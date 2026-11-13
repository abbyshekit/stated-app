//! Immutable referee for versioned OutLayer bets. See docs/OUTLAYER.md.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};
use stated_jury::{
    decide, material_hash, validate_evidence_url, validate_material, BetMaterial, EvidenceSpec,
    ExecutionInput, JuryResult, PriceWindow, SubmittedSource,
};

const SECOND: u64 = 1_000_000_000;
const WINDOW: u64 = 7 * 24 * 3600 * SECOND;
const TIMEOUT: u64 = 900 * SECOND;
const RETRY_DELAY: u64 = 300 * SECOND;
const MAX_RETRY_DELAY: u64 = 6 * 3600 * SECOND;
const MAX_UNDECIDED: u8 = 3;
const MAX_FAILURES: u8 = 8;
const MAX_ADMISSION_FAILURES: u8 = 24;
const MAX_MATERIAL: usize = 16_384;
const MAX_RESULT: usize = 16_384;
// At most one extra outstanding execution per 900-second timeout within seven
// days: 673 records * 16 bytes, plus the result and bounded metadata.
const GROWTH_RESERVE_BYTES: u64 = MAX_RESULT as u64 + 16_384;
// Immutable policy cap: 0.1 NEAR per execution, independent of upstream pricing.
const MAX_COMPUTE_DEPOSIT: u128 = 100_000_000_000_000_000_000_000;

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum Stage {
    Idle,
    Reading,
    Pricing,
    Running,
    Paying,
    Settled,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Ruling {
    registration_payer: AccountId,
    storage_refunded: U128,
    // Serialized record bytes paid at registration or by evidence submitters.
    // Map-key overhead is paid at registration and never changes.
    #[serde(skip)]
    paid_storage_bytes: u64,
    #[serde(skip)]
    reserve_prepaid: u128,
    #[serde(skip)]
    reserve_remaining: u128,
    material_json: String,
    terms_hash: String,
    deadline_ns: u64,
    nonce: u64,
    executions: u64,
    outstanding: Vec<ExecutionAttempt>,
    accepted_nonce: Option<U64>,
    accepted_attempt: Option<U64>,
    undecided: u8,
    failures: u8,
    admission_failures: u8,
    stage: Stage,
    started_ns: u64,
    next_ns: u64,
    // Once selected, an outcome survives settlement receipt failure. Never reroll it.
    outcome: Option<String>,
    last_error: Option<String>,
    evidence: Vec<EvidenceRecord>,
    next_evidence_id: u64,
    #[serde(rename = "result", serialize_with = "serialize_result")]
    result_json: Option<String>,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct ExecutionAttempt {
    nonce: u64,
    attempt: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct EvidenceRecord {
    sequence: u64,
    side: String,
    url: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct EscrowBet {
    id: String,
    terms_hash: String,
    resolve_at_ns: U64,
    status: String,
    referee: Option<AccountId>,
    #[serde(default)]
    creator: Option<AccountId>,
    #[serde(default)]
    acceptor: Option<AccountId>,
    #[serde(default)]
    creator_side: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    escrow: AccountId,
    outlayer: AccountId,
    wasm_url: String,
    wasm_hash: String,
    secrets_owner: AccountId,
    secrets_profile: String,
    rulings: LookupMap<String, Ruling>,
    // Includes evidence deposits held across the asynchronous escrow read.
    pending_registration_deposits: u128,
    growth_reserve: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        escrow: AccountId,
        outlayer: AccountId,
        wasm_url: String,
        wasm_hash: String,
        secrets_owner: AccountId,
        secrets_profile: String,
    ) -> Self {
        assert!(
            valid_hash(&wasm_hash),
            "WASM hash must be lowercase SHA256 hex"
        );
        assert!(
            wasm_url.starts_with("https://") && wasm_url.len() <= 2048,
            "HTTPS WASM URL required"
        );
        assert!(
            !secrets_profile.is_empty()
                && secrets_profile.len() <= 64
                && secrets_profile
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid secret profile"
        );
        assert!(
            outlayer.as_str() == "outlayer.testnet" || outlayer.as_str() == "outlayer.near",
            "Unsupported OutLayer account"
        );
        Self {
            escrow,
            outlayer,
            wasm_url,
            wasm_hash,
            secrets_owner,
            secrets_profile,
            rulings: LookupMap::new(b"r"),
            pending_registration_deposits: 0,
            growth_reserve: 0,
        }
    }

    pub fn get_config(&self) -> Value {
        json!({"escrow": self.escrow, "outlayer": self.outlayer, "wasm_url": self.wasm_url,
            "wasm_hash": self.wasm_hash, "secrets_owner": self.secrets_owner, "secrets_profile": self.secrets_profile,
            "timeout_seconds": TIMEOUT / SECOND, "retry_seconds": RETRY_DELAY / SECOND,
            "growth_reserve_bytes": GROWTH_RESERVE_BYTES,
            "max_undecided": MAX_UNDECIDED, "max_failures": MAX_FAILURES, "supports_open_evidence": true})
    }

    pub fn get_ruling(&self, bet_id: String) -> Option<Ruling> {
        self.rulings.get(&bet_id)
    }

    /// Donations fund a shared compute pool; no donor acquires withdrawal or
    /// outcome rights. Both protocol and OutLayer refunds return to this pool.
    #[payable]
    pub fn fund_compute(&mut self) -> U128 {
        assert!(
            env::attached_deposit().as_yoctonear() > 0,
            "Attach a compute donation"
        );
        self.get_compute_budget()
    }

    pub fn get_compute_budget(&self) -> U128 {
        U128(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(
                    u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear(),
                )
                .saturating_sub(self.pending_registration_deposits)
                .saturating_sub(self.growth_reserve),
        )
    }

    /// Hash this before funding a new bet. All material, including the evidence
    /// plan, is covered. Existing v2 salted Stated hashes are intentionally refused.
    pub fn terms_hash(&self, material: BetMaterial, salt: String) -> String {
        commitment(&material, &salt)
    }

    /// Permissionless; the escrow's hash authenticates the material. Never let a
    /// first caller select uncommitted claim text for somebody else's stakes.
    #[payable]
    pub fn register_material(&mut self, material: BetMaterial, salt: String) -> Promise {
        validate_material(&material).unwrap_or_else(|e| env::panic_str(&e));
        let material_json = encode(&material);
        assert!(material_json.len() <= MAX_MATERIAL, "Material too large");
        assert!(
            self.rulings.get(&material.bet_id).is_none(),
            "Already registered"
        );
        let terms_hash = commitment(&material, &salt);
        // Reject nanosecond overflow before moving the caller's storage funds.
        timestamp_ns(&material.deadline);
        self.pending_registration_deposits = self
            .pending_registration_deposits
            .checked_add(env::attached_deposit().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        self.read_bet(&material.bet_id).then(self.call_self("on_register", json!({
            "material_json": material_json, "terms_hash": terms_hash,
            "payer": env::predecessor_account_id(), "deposit": U128(env::attached_deposit().as_yoctonear())
        }), 70))
    }

    #[private]
    pub fn on_register(
        &mut self,
        material_json: String,
        terms_hash: String,
        payer: AccountId,
        deposit: U128,
    ) -> bool {
        assert_private();
        self.pending_registration_deposits = self
            .pending_registration_deposits
            .checked_sub(deposit.0)
            .unwrap_or_else(|| env::panic_str("Registration accounting mismatch"));
        let material: BetMaterial = decode(&material_json);
        let deadline_ns = timestamp_ns(&material.deadline);
        let accepted = callback::<Option<EscrowBet>>(MAX_RESULT)
            .ok()
            .flatten()
            .is_some_and(|b| {
                self.bet_matches(&b, &material.bet_id, &terms_hash, deadline_ns, false)
            });
        if !accepted || self.rulings.get(&material.bet_id).is_some() {
            refund(&payer, deposit.0);
            return false;
        }
        let before = env::storage_usage();
        let reserve = u128::from(GROWTH_RESERVE_BYTES) * env::storage_byte_cost().as_yoctonear();
        let mut r = Ruling {
            registration_payer: payer.clone(),
            storage_refunded: U128(0),
            paid_storage_bytes: 0,
            reserve_prepaid: reserve,
            reserve_remaining: reserve,
            material_json: material_json.clone(),
            terms_hash,
            deadline_ns,
            nonce: 0,
            executions: 0,
            outstanding: Vec::new(),
            accepted_nonce: None,
            accepted_attempt: None,
            undecided: 0,
            failures: 0,
            admission_failures: 0,
            stage: Stage::Idle,
            started_ns: 0,
            next_ns: 0,
            outcome: None,
            last_error: None,
            evidence: Vec::new(),
            next_evidence_id: 0,
            result_json: None,
        };
        r.paid_storage_bytes = ruling_bytes(&r);
        self.rulings.insert(&material.bet_id, &r);
        // Reserve the bounded result plus counters and error fields before any compute.
        let bytes = env::storage_usage().saturating_sub(before) + GROWTH_RESERVE_BYTES;
        let cost = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        if deposit.0 < cost {
            self.rulings.remove(&material.bet_id);
            refund(&payer, deposit.0);
            return false;
        }
        self.growth_reserve += reserve;
        refund(&payer, deposit.0 - cost);
        true
    }

    /// Only the escrow's current participants can add links. Caller identity and
    /// side are checked in the callback, never accepted as public arguments.
    #[payable]
    pub fn submit_evidence(&mut self, bet_id: String, url: String) -> Promise {
        validate_evidence_url(&url).unwrap_or_else(|e| env::panic_str(&e));
        let mut r = self
            .rulings
            .get(&bet_id)
            .unwrap_or_else(|| env::panic_str("Register material first"));
        assert!(evidence_open(&r), "Evidence is closed");
        // Allocate before the read so callbacks cannot reorder the submission
        // history. Failed submissions may leave gaps, which carry no meaning.
        let sequence = r.next_evidence_id;
        r.next_evidence_id = sequence
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Evidence counter exhausted"));
        self.pending_registration_deposits = self
            .pending_registration_deposits
            .checked_add(env::attached_deposit().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        self.store_ruling(&bet_id, &mut r);
        self.read_bet(&bet_id).then(self.call_self(
            "on_evidence",
            json!({"bet_id":bet_id,"url":url,"payer":env::predecessor_account_id(),
                "deposit":U128(env::attached_deposit().as_yoctonear()),"sequence":U64(sequence)}),
            70,
        ))
    }

    #[private]
    pub fn on_evidence(
        &mut self,
        bet_id: String,
        url: String,
        payer: AccountId,
        deposit: U128,
        sequence: U64,
    ) -> bool {
        assert_private();
        self.pending_registration_deposits = self
            .pending_registration_deposits
            .checked_sub(deposit.0)
            .unwrap_or_else(|| env::panic_str("Evidence accounting mismatch"));
        let Some(mut r) = self.rulings.get(&bet_id).filter(evidence_open) else {
            refund(&payer, deposit.0);
            return false;
        };
        let side = callback::<Option<EscrowBet>>(MAX_RESULT)
            .ok()
            .flatten()
            .filter(|b| self.bet_matches(b, &bet_id, &r.terms_hash, r.deadline_ns, true))
            .and_then(|b| bettor_side(&b, &payer));
        let Some(side) = side else {
            refund(&payer, deposit.0);
            return false;
        };
        let material: BetMaterial = decode(&r.material_json);
        let EvidenceSpec::Open { max_per_side, .. } = material.evidence else {
            refund(&payer, deposit.0);
            return false;
        };
        if validate_evidence_url(&url).is_err()
            || sequence.0 >= r.next_evidence_id
            || r.evidence.iter().any(|item| item.sequence == sequence.0)
            || r.evidence.iter().filter(|item| item.side == side).count()
                >= usize::from(max_per_side)
        {
            refund(&payer, deposit.0);
            return false;
        }
        let before = ruling_bytes(&r);
        r.evidence.push(EvidenceRecord {
            sequence: sequence.0,
            side,
            url,
        });
        r.evidence.sort_by_key(|item| item.sequence);
        let bytes = ruling_bytes(&r) - before;
        let cost = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        if deposit.0 < cost {
            refund(&payer, deposit.0);
            return false;
        }
        r.paid_storage_bytes += bytes;
        self.store_ruling(&bet_id, &mut r);
        refund(&payer, deposit.0 - cost);
        true
    }

    /// The caller pays gas; the sponsor pool pays compute. No signing key or
    /// human outcome approval is required.
    pub fn request_ruling(&mut self, bet_id: String) -> Promise {
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            0,
            "Use fund_compute for donations"
        );
        let mut r = self
            .rulings
            .get(&bet_id)
            .unwrap_or_else(|| env::panic_str("Register material first"));
        let now = env::block_timestamp();
        assert!(now >= r.deadline_ns, "Resolution time has not arrived");
        assert!(r.stage != Stage::Settled, "Already settled");
        assert!(
            now >= ready_ns(&r),
            "Wait for closed candles or evidence window"
        );
        if matches!(
            r.stage,
            Stage::Reading | Stage::Pricing | Stage::Running | Stage::Paying
        ) {
            assert!(
                now >= r.started_ns.saturating_add(TIMEOUT),
                "Ruling in flight"
            );
            // A timed-out execution can still return a valid callback. Keep it
            // outstanding; only a completed callback can consume an allowance.
            r.last_error = Some("Attempt timed out".into());
        } else {
            assert!(now >= r.next_ns, "Retry delay remains");
        }
        if r.outstanding.is_empty() && failure_limit(&r) {
            r.outcome.get_or_insert_with(|| "void".into());
        }
        r.nonce = r
            .nonce
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Attempt counter exhausted"));
        r.stage = Stage::Reading;
        r.started_ns = now;
        self.store_ruling(&bet_id, &mut r);
        self.read_bet(&bet_id).then(self.call_self(
            "on_bet",
            json!({"bet_id": bet_id, "nonce": U64(r.nonce)}),
            260,
        ))
    }

    #[private]
    pub fn on_bet(&mut self, bet_id: String, nonce: U64) -> PromiseOrValue<String> {
        assert_private();
        let Some(mut r) = self.current(&bet_id, nonce.0, Stage::Reading) else {
            return value("stale");
        };
        let bet = callback::<Option<EscrowBet>>(MAX_RESULT).ok().flatten();
        let Some(bet) = bet else {
            return self.admission_failed(&bet_id, r, "Escrow read failed");
        };
        // An external mutual settlement or refund is terminal and costs no compute.
        if bet.id == bet_id
            && ["settled", "refunded", "cancelled", "expired"].contains(&bet.status.as_str())
        {
            self.finish_settlement(&bet_id, &mut r);
            return value("already terminal");
        }
        if !self.bet_matches(&bet, &bet_id, &r.terms_hash, r.deadline_ns, true) {
            return self.admission_failed(&bet_id, r, "Escrow binding or deadline mismatch");
        }
        if r.outcome.is_some() || env::block_timestamp() >= r.deadline_ns.saturating_add(WINDOW) {
            return self.settle(&bet_id, r);
        }
        let material: BetMaterial = decode(&r.material_json);
        if matches!(material.evidence, EvidenceSpec::Open { .. }) && r.evidence.is_empty() {
            r.outcome = Some("void".into());
            return self.settle(&bet_id, r);
        }
        let input = execution_input(&r, env::block_timestamp());
        r.stage = Stage::Pricing;
        self.store_ruling(&bet_id, &mut r);
        PromiseOrValue::Promise(
            Promise::new(self.outlayer.clone())
                .function_call(
                    "estimate_execution_cost",
                    encode(&json!({"resource_limits":limits(),"input_len":encode(&input).len()}))
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(10),
                )
                .then(self.call_self("on_priced", json!({"bet_id":bet_id,"nonce":nonce}), 230)),
        )
    }

    #[private]
    pub fn on_priced(&mut self, bet_id: String, nonce: U64) -> PromiseOrValue<String> {
        assert_private();
        let Some(mut r) = self.current(&bet_id, nonce.0, Stage::Pricing) else {
            return value("stale");
        };
        let estimate = callback::<U128>(1024).ok();
        if estimate.is_none_or(|cost| {
            self.get_compute_budget().0 < cost.0 || cost.0 == 0 || cost.0 > MAX_COMPUTE_DEPOSIT
        }) {
            // Missing sponsor funds or an unsafe quote cannot force Void.
            r.stage = Stage::Idle;
            r.last_error =
                Some("Compute estimate unavailable, over cap or pool underfunded".into());
            self.store_ruling(&bet_id, &mut r);
            return value("compute deposit rejected");
        }
        let input = execution_input(&r, env::block_timestamp());
        let deposit = estimate
            .map(|cost| cost.0)
            .unwrap_or_else(|| env::panic_str("Missing estimate"));
        r.executions = input.attempt;
        r.outstanding.push(ExecutionAttempt {
            nonce: r.nonce,
            attempt: input.attempt,
        });
        r.stage = Stage::Running;
        self.store_ruling(&bet_id, &mut r);
        let args = json!({
            "source": {"WasmUrl": {"url": self.wasm_url, "hash": self.wasm_hash, "build_target": "wasm32-wasip2"}},
            "resource_limits": limits(),
            "input_data": encode(&input),
            "secrets_ref": {"account_id": self.secrets_owner, "profile": self.secrets_profile},
            "response_format": "Json", "payer_account_id": env::current_account_id(), "params": null
        });
        PromiseOrValue::Promise(
            Promise::new(self.outlayer.clone())
                .function_call(
                    "request_execution",
                    encode(&args).into_bytes(),
                    NearToken::from_yoctonear(deposit),
                    Gas::from_tgas(150),
                )
                .then(self.call_self("on_ruling", json!({"bet_id": bet_id, "nonce": nonce}), 60)),
        )
    }

    #[private]
    pub fn on_ruling(&mut self, bet_id: String, nonce: U64) -> PromiseOrValue<String> {
        assert_private();
        let Some(mut r) = self.rulings.get(&bet_id).filter(|r| {
            r.outstanding.iter().any(|attempt| attempt.nonce == nonce.0)
                && r.outcome.is_none()
                && !matches!(r.stage, Stage::Paying | Stage::Settled)
        }) else {
            return value("stale");
        };
        let older = nonce.0 < r.nonce;
        // Remove exactly this receipt before handling it, so duplicate callbacks
        // cannot consume another allowance or overwrite an accepted result.
        let mut expected_attempt = 0;
        r.outstanding.retain(|attempt| {
            if attempt.nonce == nonce.0 {
                expected_attempt = attempt.attempt;
                false
            } else {
                true
            }
        });
        let response =
            (env::promise_results_count() == 1).then(|| env::promise_result_checked(0, MAX_RESULT));
        if matches!(response, Some(Err(near_sdk::PromiseError::Failed))) {
            // A reverted admission refunds its deposit; it did not buy compute.
            r.admission_failures = r.admission_failures.saturating_add(1);
            return self.execution_failed(&bet_id, r, older, "OutLayer admission failed");
        }
        let result = response
            .and_then(Result::ok)
            .and_then(|bytes| serde_json::from_slice::<Option<JuryResult>>(&bytes).ok())
            .flatten();
        let Some(result) = result else {
            r.failures = r.failures.saturating_add(1);
            return self.execution_failed(&bet_id, r, older, "OutLayer execution failed");
        };
        let input = execution_input(&r, r.started_ns);
        let hash = material_hash(&input).unwrap_or_else(|e| env::panic_str(&e));
        let result_json = encode(&result);
        let error = if result.bet_id != bet_id
            || result.terms_hash != r.terms_hash
            || result.material_hash != hash
            || result.attempt != expected_attempt
            || !["yes", "no", "unclear"].contains(&result.outcome.as_str())
            || result.verdicts.len() != 3
            || result.outcome != decide(&result.verdicts)
            || result.verdicts.iter().any(|v| {
                !["yes", "no", "unclear"].contains(&v.outcome.as_str())
                    || !v.confidence.is_finite()
                    || !(0.0..=1.0).contains(&v.confidence)
            }) {
            Some("Invalid jury result binding or decision")
        }
        // A malformed roster must fail rather than spend the undecided allowance.
        else if result
            .verdicts
            .iter()
            .zip(stated_jury::MODELS)
            .any(|(v, m)| v.model != m)
        {
            Some("Invalid jury roster")
        } else if result_json.len() > MAX_RESULT {
            Some("Serialized jury result exceeds limit")
        } else {
            None
        };
        if let Some(error) = error {
            r.failures = r.failures.saturating_add(1);
            return self.execution_failed(&bet_id, r, older, error);
        }
        // A valid result closes this whole jury round. In particular, an older
        // unclear invalidates newer executions and enforces a fresh retry delay.
        r.outstanding.clear();
        r.accepted_nonce = Some(nonce);
        r.accepted_attempt = Some(U64(expected_attempt));
        r.result_json = Some(result_json);
        if result.outcome == "unclear" {
            r.undecided += 1;
            if r.undecided < MAX_UNDECIDED {
                r.stage = Stage::Idle;
                r.next_ns = env::block_timestamp().saturating_add(RETRY_DELAY);
                self.store_ruling(&bet_id, &mut r);
                return value("undecided; retry after delay");
            }
            r.outcome = Some("void".into());
        } else {
            r.outcome = Some(result.outcome);
        }
        self.settle(&bet_id, r)
    }

    #[private]
    pub fn on_settled(&mut self, bet_id: String, nonce: U64) -> bool {
        assert_private();
        let Some(mut r) = self.rulings.get(&bet_id).filter(|r| {
            nonce.0 > 0
                && nonce.0 <= r.nonce
                && r.stage != Stage::Settled
                && (nonce.0 < r.nonce || r.stage == Stage::Paying)
        }) else {
            return false;
        };
        let succeeded = callback::<Value>(1024).is_ok();
        if nonce.0 < r.nonce && !succeeded {
            return false;
        }
        if succeeded {
            r.last_error = None;
            self.finish_settlement(&bet_id, &mut r);
        } else {
            r.stage = Stage::Idle;
            r.last_error = Some("Escrow settlement failed; retry selected outcome".into());
            r.next_ns = env::block_timestamp().saturating_add(RETRY_DELAY);
            self.store_ruling(&bet_id, &mut r);
        }
        r.stage == Stage::Settled
    }
}

impl Contract {
    fn store_ruling(&mut self, id: &str, r: &mut Ruling) {
        let previous = self
            .rulings
            .get(&id.to_owned())
            .map_or(0, |old| old.reserve_remaining);
        r.reserve_remaining = if r.stage == Stage::Settled {
            0
        } else {
            remaining_reserve(r)
        };
        self.growth_reserve = self
            .growth_reserve
            .checked_sub(previous)
            .and_then(|reserve| reserve.checked_add(r.reserve_remaining))
            .unwrap_or_else(|| env::panic_str("Growth reserve accounting mismatch"));
        self.rulings.insert(&id.to_owned(), r);
    }

    fn finish_settlement(&mut self, id: &str, r: &mut Ruling) {
        if r.stage == Stage::Settled {
            return;
        }
        r.stage = Stage::Settled;
        r.storage_refunded = U128(remaining_reserve(r));
        self.store_ruling(id, r);
        refund(&r.registration_payer, r.storage_refunded.0);
    }

    fn read_bet(&self, id: &str) -> Promise {
        Promise::new(self.escrow.clone()).function_call(
            "get_bet",
            encode(&json!({"id":id})).into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        )
    }
    fn call_self(&self, method: &str, args: Value, gas: u64) -> Promise {
        Promise::new(env::current_account_id()).function_call(
            method,
            encode(&args).into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(gas),
        )
    }
    fn current(&self, id: &str, nonce: u64, stage: Stage) -> Option<Ruling> {
        self.rulings
            .get(&id.to_owned())
            .filter(|r| r.nonce == nonce && r.stage == stage)
    }
    fn bet_matches(&self, b: &EscrowBet, id: &str, hash: &str, deadline: u64, due: bool) -> bool {
        b.id == id
            && b.terms_hash == hash
            && b.resolve_at_ns.0 == deadline
            && b.referee.as_ref() == Some(&env::current_account_id())
            && (["accepted", "proposed", "disputed"].contains(&b.status.as_str())
                || (!due && b.status == "offered"))
            && (!due || env::block_timestamp() >= deadline)
    }
    fn execution_failed(
        &mut self,
        id: &str,
        mut r: Ruling,
        older: bool,
        error: &str,
    ) -> PromiseOrValue<String> {
        if !older {
            return self.retry_failure(id, r, error);
        }
        // A completed older failure counts once, but cannot interrupt a newer
        // execution or its backoff. Any outstanding valid result can still win.
        if r.outstanding.is_empty() && failure_limit(&r) {
            return self.retry_failure(id, r, error);
        }
        r.last_error = Some(error.into());
        self.store_ruling(id, &mut r);
        value(error)
    }
    fn admission_failed(&mut self, id: &str, mut r: Ruling, error: &str) -> PromiseOrValue<String> {
        r.admission_failures = r.admission_failures.saturating_add(1);
        self.retry_failure(id, r, error)
    }
    fn retry_failure(&mut self, id: &str, mut r: Ruling, error: &str) -> PromiseOrValue<String> {
        r.last_error = Some(error.into());
        r.stage = Stage::Idle;
        r.next_ns = env::block_timestamp().saturating_add(failure_delay(&r));
        if r.outstanding.is_empty() && failure_limit(&r) {
            r.outcome.get_or_insert_with(|| "void".into());
            // Re-read escrow on the next permissionless request before refunding.
        }
        self.store_ruling(id, &mut r);
        value(error)
    }
    fn settle(&mut self, id: &str, mut r: Ruling) -> PromiseOrValue<String> {
        let (method, args) = if let Some(outcome) = r.outcome.as_ref() {
            ("referee_resolve", json!({"id":id,"outcome":outcome}))
        } else {
            ("refund_unresolved", json!({"id":id}))
        };
        r.stage = Stage::Paying;
        r.started_ns = env::block_timestamp();
        self.store_ruling(id, &mut r);
        PromiseOrValue::Promise(
            Promise::new(self.escrow.clone())
                .function_call(
                    method,
                    encode(&args).into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(15),
                )
                .then(self.call_self("on_settled", json!({"bet_id":id,"nonce":U64(r.nonce)}), 15)),
        )
    }
}

fn ruling_bytes(r: &Ruling) -> u64 {
    near_sdk::borsh::object_length(r)
        .unwrap_or_else(|_| env::panic_str("Ruling storage measurement failed")) as u64
}

fn remaining_reserve(r: &Ruling) -> u128 {
    let growth = ruling_bytes(r).saturating_sub(r.paid_storage_bytes);
    r.reserve_prepaid
        .saturating_sub(u128::from(growth) * env::storage_byte_cost().as_yoctonear())
}

fn serialize_result<S: near_sdk::serde::Serializer>(
    raw: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match raw {
        Some(raw) => serde_json::from_str::<Value>(raw)
            .map_err(near_sdk::serde::ser::Error::custom)?
            .serialize(serializer),
        None => serializer.serialize_none(),
    }
}

fn commitment(material: &BetMaterial, salt: &str) -> String {
    validate_material(material).unwrap_or_else(|e| env::panic_str(&e));
    assert!(valid_hash(salt), "Salt must be 32 bytes lowercase hex");
    assert!(encode(material).len() <= MAX_MATERIAL, "Material too large");
    // Cargo feature unification can enable serde_json/preserve_order in tests
    // or downstream builds. Commit to sorted objects regardless of that feature.
    let mut envelope = json!({"domain":"stated-outlayer-v1","material":material,"salt":salt});
    envelope.sort_all_objects();
    hex_hash(&encode(&envelope))
}
fn hex_hash(input: &str) -> String {
    env::sha256(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn encode<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| env::panic_str("Serialization failed"))
}
fn decode<T: for<'de> Deserialize<'de>>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_else(|_| env::panic_str("Invalid stored material"))
}
fn timestamp_millis(s: &str) -> i64 {
    let d = chrono::DateTime::parse_from_rfc3339(s)
        .unwrap_or_else(|_| env::panic_str("Invalid deadline"));
    assert_eq!(
        d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        s,
        "Canonical UTC milliseconds required"
    );
    d.timestamp_millis()
}
fn timestamp_ns(s: &str) -> u64 {
    let ms = u64::try_from(timestamp_millis(s))
        .unwrap_or_else(|_| env::panic_str("Deadline before epoch"));
    ms.checked_mul(1_000_000)
        .unwrap_or_else(|| env::panic_str("Deadline overflow"))
}
fn window_timestamp_ns(s: &str) -> u64 {
    u64::try_from(timestamp_millis(s))
        .unwrap_or(0)
        .saturating_mul(1_000_000)
}
fn execution_input(r: &Ruling, now: u64) -> ExecutionInput {
    let date = chrono::DateTime::from_timestamp((now / SECOND) as i64, (now % SECOND) as u32)
        .unwrap_or_else(|| env::panic_str("Invalid block timestamp"));
    ExecutionInput {
        attempt: r
            .executions
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Execution counter exhausted")),
        material: decode(&r.material_json),
        terms_hash: r.terms_hash.clone(),
        now: date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        submitted_evidence: r
            .evidence
            .iter()
            .map(|item| SubmittedSource {
                side: item.side.clone(),
                url: item.url.clone(),
            })
            .collect(),
    }
}
fn failure_limit(r: &Ruling) -> bool {
    r.undecided >= MAX_UNDECIDED
        || r.failures >= MAX_FAILURES
        || r.admission_failures >= MAX_ADMISSION_FAILURES
}
fn limits() -> Value {
    json!({"max_instructions":10_000_000_000u64,"max_memory_mb":128,"max_execution_seconds":180})
}
fn failure_delay(r: &Ruling) -> u64 {
    let shift = r.failures.saturating_add(r.admission_failures).min(6);
    (RETRY_DELAY << shift).min(MAX_RETRY_DELAY)
}
fn ready_ns(r: &Ruling) -> u64 {
    let material: BetMaterial = decode(&r.material_json);
    let minute = 60 * SECOND;
    let closed = match material.evidence {
        EvidenceSpec::Submitted { .. } => r.deadline_ns,
        EvidenceSpec::Open { window_seconds, .. } => r
            .deadline_ns
            .saturating_add(u64::from(window_seconds) * SECOND),
        EvidenceSpec::Auto => r.deadline_ns.saturating_add(180 * SECOND),
        EvidenceSpec::Coinbase {
            window: PriceWindow::Moment { at },
            ..
        } => (window_timestamp_ns(&at) / minute)
            .saturating_mul(minute)
            .saturating_add(2 * minute),
        EvidenceSpec::Coinbase {
            window: PriceWindow::Range { end, .. },
            ..
        } => {
            let end = window_timestamp_ns(&end).min(r.deadline_ns);
            end.div_ceil(minute)
                .saturating_mul(minute)
                .saturating_add(minute)
        }
    };
    r.deadline_ns.max(closed)
}
fn evidence_open(r: &Ruling) -> bool {
    let material: BetMaterial = decode(&r.material_json);
    matches!(material.evidence, EvidenceSpec::Open { .. })
        && r.stage == Stage::Idle
        && r.outcome.is_none()
        && env::block_timestamp() >= r.deadline_ns
        && env::block_timestamp() < ready_ns(r)
}
fn bettor_side(bet: &EscrowBet, caller: &AccountId) -> Option<String> {
    let creator_side = bet.creator_side.as_deref()?;
    if !matches!(creator_side, "yes" | "no") {
        return None;
    }
    // A fully accepted, distinct pair is required even for a malformed escrow
    // response. Only the configured escrow can supply these identities.
    if bet.creator.is_none() || bet.acceptor.is_none() || bet.creator == bet.acceptor {
        return None;
    }
    if bet.creator.as_ref() == Some(caller) {
        Some(creator_side.into())
    } else if bet.acceptor.as_ref() == Some(caller) {
        Some(if creator_side == "yes" { "no" } else { "yes" }.into())
    } else {
        None
    }
}
fn refund(payer: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(payer.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}
fn value(message: &str) -> PromiseOrValue<String> {
    PromiseOrValue::Value(message.into())
}
fn callback<T: for<'de> Deserialize<'de>>(limit: usize) -> Result<T, ()> {
    if env::promise_results_count() != 1 {
        return Err(());
    }
    let bytes = env::promise_result_checked(0, limit).map_err(|_| ())?;
    // Successful void methods return empty bytes, not JSON null.
    serde_json::from_slice(if bytes.is_empty() { b"null" } else { &bytes }).map_err(|_| ())
}

fn assert_private() {
    assert_eq!(
        env::predecessor_account_id(),
        env::current_account_id(),
        "Private callback"
    );
}

#[cfg(test)]
mod tests;
