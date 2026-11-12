// INTEGRATION: Create and fund the account, deploy code, and initialize in one
// transaction with zero access keys. There is no upgrade, owner, configuration
// mutation, or key-management entry point in this contract.
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const NS_PER_SECOND: u64 = 1_000_000_000;
const MAX_DESCRIPTION_BYTES: usize = 1_000;
const MAX_PROPOSAL_BYTES: usize = 65_536;
const RESOLVE_GAS: &str = "100000000000000";
const FILE_GAS: Gas = Gas::from_tgas(100);
const READ_GAS: Gas = Gas::from_tgas(20);
const CALLBACK_GAS: Gas = Gas::from_tgas(250);
const ACT_GAS: Gas = Gas::from_tgas(200);
const APPROVE_GAS: Gas = Gas::from_tgas(300);

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Resolution {
    id: String,
    outcome: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct FunctionCallAction {
    method_name: String,
    args: Base64VecU8,
    deposit: String,
    gas: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct FunctionCall {
    receiver_id: AccountId,
    actions: Vec<FunctionCallAction>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
enum ProposalKind {
    FunctionCall(FunctionCall),
}

// Accept decimal strings and JSON u64 timestamps without floating-point parsing.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", untagged)]
enum Timestamp {
    Decimal(String),
    Number(u64),
}

impl Timestamp {
    fn value(self) -> u64 {
        match self {
            Self::Number(value) => value,
            Self::Decimal(value) => {
                assert!(
                    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
                    "Invalid submission timestamp"
                );
                value
                    .parse()
                    .unwrap_or_else(|_| env::panic_str("Invalid submission timestamp"))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct DaoProposal {
    id: u64,
    proposer: AccountId,
    status: String,
    kind: ProposalKind,
    submission_time: Timestamp,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub dao: AccountId,
    pub escrow: AccountId,
    pub operator: AccountId,
    pub window_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao: AccountId,
    escrow: AccountId,
    operator: AccountId,
    window_ns: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        dao: AccountId,
        escrow: AccountId,
        operator: AccountId,
        window_seconds: u32,
    ) -> Self {
        assert!(
            (60..=86_400).contains(&window_seconds),
            "Window must be 60 through 86400 seconds"
        );
        Self {
            dao,
            escrow,
            operator,
            window_ns: u64::from(window_seconds) * NS_PER_SECOND,
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            dao: self.dao.clone(),
            escrow: self.escrow.clone(),
            operator: self.operator.clone(),
            window_ns: U64(self.window_ns),
        }
    }

    /// Forward the attached DAO proposal bond. The promise returns add_proposal's
    /// final JSON u64 proposal ID directly to the caller.
    #[payable]
    pub fn file(&mut self, id: String, outcome: String, description: String) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.operator,
            "Operator only"
        );
        validate_resolution(&Resolution {
            id: id.clone(),
            outcome: outcome.clone(),
        });
        assert!(
            description.len() <= MAX_DESCRIPTION_BYTES,
            "Description exceeds 1000 bytes"
        );
        let kind = ProposalKind::FunctionCall(FunctionCall {
            receiver_id: self.escrow.clone(),
            actions: vec![FunctionCallAction {
                method_name: "referee_resolve".into(),
                args: Base64VecU8(json(&Resolution { id, outcome })),
                deposit: "0".into(),
                gas: RESOLVE_GAS.into(),
            }],
        });
        Promise::new(self.dao.clone()).function_call(
            "add_proposal",
            json(&near_sdk::serde_json::json!({
                "proposal": {"description": description, "kind": kind}
            })),
            env::attached_deposit(),
            FILE_GAS,
        )
    }

    /// Anyone may trigger the relay vote after the immutable challenge window.
    /// Attach 300 Tgas: 20 for the read and 250 for the callback. The callback's
    /// 200-Tgas act_proposal allowance includes the 100-Tgas escrow action.
    pub fn approve(&mut self, id: u64) -> Promise {
        assert!(env::prepaid_gas() >= APPROVE_GAS, "Attach 300 Tgas");
        Promise::new(self.dao.clone())
            .function_call(
                "get_proposal",
                json(&near_sdk::serde_json::json!({"id": id})),
                NearToken::from_yoctonear(0),
                READ_GAS,
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_proposal",
                json(&near_sdk::serde_json::json!({"id": id})),
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_proposal(&mut self, id: u64) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Private callback"
        );
        assert_eq!(env::promise_results_count(), 1, "Expected one DAO result");
        let raw = env::promise_result_checked(0, MAX_PROPOSAL_BYTES)
            .unwrap_or_else(|_| env::panic_str("DAO read failed or result too large"));
        let proposal: DaoProposal = near_sdk::serde_json::from_slice(&raw)
            .unwrap_or_else(|_| env::panic_str("Invalid DAO proposal"));
        assert_eq!(proposal.id, id, "Proposal ID mismatch");
        assert_eq!(
            proposal.proposer,
            env::current_account_id(),
            "Foreign proposer"
        );
        assert_eq!(proposal.status, "InProgress", "Proposal is not InProgress");
        let ProposalKind::FunctionCall(call) = &proposal.kind;
        assert_eq!(call.receiver_id, self.escrow, "Wrong escrow receiver");
        assert_eq!(call.actions.len(), 1, "Expected one action");
        let action = &call.actions[0];
        assert_eq!(action.method_name, "referee_resolve", "Wrong method");
        assert_eq!(action.deposit, "0", "Wrong action deposit");
        assert_eq!(action.gas, RESOLVE_GAS, "Wrong action gas");
        let resolution: Resolution = near_sdk::serde_json::from_slice(&action.args.0)
            .unwrap_or_else(|_| env::panic_str("Invalid resolution arguments"));
        validate_resolution(&resolution);
        let eligible_at = proposal
            .submission_time
            .value()
            .checked_add(self.window_ns)
            .unwrap_or_else(|| env::panic_str("Submission timestamp overflow"));
        assert!(
            env::block_timestamp() >= eligible_at,
            "Challenge window is open"
        );
        Promise::new(self.dao.clone()).function_call(
            "act_proposal",
            json(&near_sdk::serde_json::json!({
                "id": id, "action": "VoteApprove", "proposal": proposal.kind
            })),
            NearToken::from_yoctonear(0),
            ACT_GAS,
        )
    }
}

fn json(value: &impl Serialize) -> Vec<u8> {
    near_sdk::serde_json::to_vec(value)
        .unwrap_or_else(|_| env::panic_str("JSON serialization failed"))
}

fn validate_resolution(resolution: &Resolution) {
    let id = resolution.id.as_bytes();
    assert!(
        id.len() == 36
            && id.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
                }
            }),
        "ID must be a lower-case UUID"
    );
    assert!(
        matches!(resolution.outcome.as_str(), "yes" | "no" | "void"),
        "Outcome must be yes, no or void"
    );
}

#[cfg(test)]
mod tests;
