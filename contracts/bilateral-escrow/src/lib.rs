// INTEGRATION: Bilateral escrow, version 2. The code is the same on testnet and on
// mainnet; on mainnet the stakes are real NEAR, each capped at MAX_STAKE, and the
// contract account is meant to hold no access keys. Payable create_bet/accept_bet
// fund equal stakes; create_bet may name an optional referee (never a participant).
// Settlement paths, all through one shared payout helper that records a resolution
// {outcome, method, resolved_at_ns}: confirm_outcome (method "agreement"),
// finalize_unanswered (method "unanswered": the proposer finalizes a proposal the other
// side left unanswered for RESPONSE_WINDOW_NS = 2 days; never on a bet with a referee,
// where only agreement or the referee settles), and referee_resolve (method
// "referee": the named referee settles an active bet at any time). propose_outcome is
// gated to resolve_at <= now < resolve_at + 7 days and records proposed_at_ns;
// confirm_outcome/dispute_outcome work at any time while the status is Proposed.
// refund_unresolved refunds Accepted/Disputed bets once the 7-day window closes; an
// unanswered Proposed bet panics (dispute it or let it finalize) unless a referee is
// named, in which case it refunds too. cancel/expire refund
// the creator; withdraw pays only the predecessor's credit via on_withdraw. Views:
// get_bet (adds referee, proposal.proposed_at_ns, resolution), get_credit, storage_fee,
// version ("2"), response_window_ns. U128/U64 JSON amounts and times are strings.
// confirm_outcome/dispute_outcome/finalize_unanswered require expected_revision from
// proposal.revision.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const STORAGE_FEE: u128 = 10_000_000_000_000_000_000_000;
const MAX_STAKE: u128 = 1_000_000_000_000_000_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;
const MAX_HORIZON_NS: u64 = 366 * DAY_NS;
const RESOLUTION_WINDOW_NS: u64 = 7 * DAY_NS;
const RESPONSE_WINDOW_NS: u64 = 2 * DAY_NS;

#[derive(
    BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, Clone, Copy, PartialEq, Debug,
)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum Side {
    Yes,
    No,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    near_sdk::serde::Serialize,
    near_sdk::serde::Deserialize,
    Clone,
    Copy,
    PartialEq,
    Debug,
)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum Outcome {
    Yes,
    No,
    Void,
}

#[derive(
    BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, Clone, Copy, PartialEq, Debug,
)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum Status {
    Offered,
    Accepted,
    Proposed,
    Disputed,
    Settled,
    Cancelled,
    Expired,
    Refunded,
}

#[derive(BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Proposal {
    pub id: String,
    pub revision: U64,
    pub outcome: Outcome,
    pub proposer: AccountId,
    pub proposed_at_ns: U64,
}

#[derive(
    BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, Clone, Copy, PartialEq, Debug,
)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum ResolutionMethod {
    Agreement,
    Unanswered,
    Referee,
}

#[derive(BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Resolution {
    pub outcome: Outcome,
    pub method: ResolutionMethod,
    pub resolved_at_ns: U64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
struct Bet {
    id: String,
    terms_hash: [u8; 32],
    creator_binding_hash: [u8; 32],
    acceptor_binding_hash: Option<[u8; 32]>,
    creator: AccountId,
    acceptor: Option<AccountId>,
    invited_account: Option<AccountId>,
    creator_side: Side,
    stake_yocto: u128,
    accept_by_ns: u64,
    resolve_at_ns: u64,
    status: Status,
    proposal: Option<Proposal>,
    referee: Option<AccountId>,
    resolution: Option<Resolution>,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BetView {
    pub id: String,
    pub terms_hash: String,
    pub creator_binding_hash: String,
    pub acceptor_binding_hash: Option<String>,
    pub creator: AccountId,
    pub acceptor: Option<AccountId>,
    pub invited_account: Option<AccountId>,
    pub creator_side: Side,
    pub stake_yocto: U128,
    pub accept_by_ns: U64,
    pub resolve_at_ns: U64,
    pub status: Status,
    pub proposal: Option<Proposal>,
    pub referee: Option<AccountId>,
    pub resolution: Option<Resolution>,
}

impl From<Bet> for BetView {
    fn from(b: Bet) -> Self {
        Self {
            id: b.id,
            terms_hash: hex(&b.terms_hash),
            creator_binding_hash: hex(&b.creator_binding_hash),
            acceptor_binding_hash: b.acceptor_binding_hash.as_ref().map(hex),
            creator: b.creator,
            acceptor: b.acceptor,
            invited_account: b.invited_account,
            creator_side: b.creator_side,
            stake_yocto: U128(b.stake_yocto),
            accept_by_ns: U64(b.accept_by_ns),
            resolve_at_ns: U64(b.resolve_at_ns),
            status: b.status,
            proposal: b.proposal,
            referee: b.referee,
            resolution: b.resolution,
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    bets: LookupMap<String, Bet>,
    credits: LookupMap<AccountId, u128>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            bets: LookupMap::new(b"b"),
            credits: LookupMap::new(b"c"),
        }
    }

    #[payable]
    #[allow(clippy::too_many_arguments)] // Public JSON ABI keeps funded terms explicit.
    pub fn create_bet(
        &mut self,
        id: String,
        terms_hash: String,
        creator_side: String,
        stake_yocto: U128,
        accept_by_ns: U64,
        resolve_at_ns: U64,
        invited_account: Option<AccountId>,
        binding_hash: String,
        referee: Option<AccountId>,
    ) {
        valid_uuid(&id);
        let terms_hash = parse_hash(&terms_hash);
        let binding_hash = parse_hash(&binding_hash);
        assert!(self.bets.get(&id).is_none(), "Bet already exists");
        let side = match creator_side.as_str() {
            "yes" => Side::Yes,
            "no" => Side::No,
            _ => env::panic_str("Creator side must be yes or no"),
        };
        let stake = stake_yocto.0;
        assert!(
            stake > 0 && stake <= MAX_STAKE,
            "Stake must be positive and at most 1 NEAR"
        );
        let now = env::block_timestamp();
        assert!(
            now < accept_by_ns.0 && accept_by_ns.0 < resolve_at_ns.0,
            "Invalid deadlines"
        );
        assert!(
            resolve_at_ns.0 <= add_time(now, MAX_HORIZON_NS),
            "Resolution horizon too long"
        );
        add_time(resolve_at_ns.0, RESOLUTION_WINDOW_NS);
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            add(stake, STORAGE_FEE),
            "Deposit must equal stake plus storage fee"
        );
        let creator = env::predecessor_account_id();
        assert!(
            invited_account.as_ref() != Some(&creator),
            "Creator cannot invite self"
        );
        if let Some(r) = &referee {
            assert!(
                r != &creator && invited_account.as_ref() != Some(r),
                "Referee cannot be a participant"
            );
        }
        let before = env::storage_usage();
        self.bets.insert(
            &id,
            &Bet {
                id: id.clone(),
                terms_hash,
                creator_binding_hash: binding_hash,
                acceptor_binding_hash: None,
                creator: creator.clone(),
                acceptor: None,
                invited_account,
                creator_side: side,
                stake_yocto: stake,
                accept_by_ns: accept_by_ns.0,
                resolve_at_ns: resolve_at_ns.0,
                status: Status::Offered,
                proposal: None,
                referee,
                resolution: None,
            },
        );
        // Preallocate the creator credit entry; later withdrawal callbacks only update it.
        if self.credits.get(&creator).is_none() {
            self.credits.insert(&creator, &0);
        }
        let bytes = env::storage_usage().saturating_sub(before);
        let cost = (bytes as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        assert!(cost <= STORAGE_FEE, "Storage fee does not cover this bet");
    }

    #[payable]
    pub fn accept_bet(&mut self, id: String, binding_hash: String) {
        let binding_hash = parse_hash(&binding_hash);
        let mut b = self.bet(&id);
        assert_eq!(b.status, Status::Offered, "Bet is not offered");
        assert!(
            env::block_timestamp() < b.accept_by_ns,
            "Acceptance deadline passed"
        );
        let caller = env::predecessor_account_id();
        assert_ne!(caller, b.creator, "Creator cannot accept own bet");
        assert!(
            b.referee.as_ref() != Some(&caller),
            "Referee cannot be a participant"
        );
        if let Some(invited) = &b.invited_account {
            assert_eq!(&caller, invited, "Account is not invited");
        }
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            b.stake_yocto,
            "Deposit must equal stake"
        );
        b.acceptor = Some(caller.clone());
        b.acceptor_binding_hash = Some(binding_hash);
        b.status = Status::Accepted;
        self.bets.insert(&id, &b);
        if self.credits.get(&caller).is_none() {
            self.credits.insert(&caller, &0);
        }
    }

    pub fn cancel_bet(&mut self, id: String) {
        let mut b = self.bet(&id);
        assert_eq!(
            env::predecessor_account_id(),
            b.creator,
            "Only creator can cancel"
        );
        assert_eq!(
            b.status,
            Status::Offered,
            "Only offered bet can be cancelled"
        );
        b.status = Status::Cancelled;
        self.credit(&b.creator, b.stake_yocto);
        self.bets.insert(&id, &b);
    }

    pub fn expire_bet(&mut self, id: String) {
        let mut b = self.bet(&id);
        assert_eq!(b.status, Status::Offered, "Only offered bet can expire");
        assert!(
            env::block_timestamp() >= b.accept_by_ns,
            "Acceptance deadline has not passed"
        );
        b.status = Status::Expired;
        self.credit(&b.creator, b.stake_yocto);
        self.bets.insert(&id, &b);
    }

    pub fn propose_outcome(&mut self, id: String, proposal_id: String, outcome: Outcome) {
        valid_uuid(&proposal_id);
        let mut b = self.bet(&id);
        self.resolvable(&b);
        let caller = env::predecessor_account_id();
        participant(&b, &caller);
        // A revision binds responses to exact proposal content even if an id is
        // reused later. Only the latest proposal occupies storage.
        let revision = b
            .proposal
            .as_ref()
            .map_or(0, |p| p.revision.0)
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Proposal revision overflow"));
        b.proposal = Some(Proposal {
            id: proposal_id,
            revision: U64(revision),
            outcome,
            proposer: caller,
            proposed_at_ns: U64(env::block_timestamp()),
        });
        b.status = Status::Proposed;
        self.bets.insert(&id, &b);
    }

    pub fn confirm_outcome(&mut self, id: String, proposal_id: String, expected_revision: U64) {
        let mut b = self.bet(&id);
        assert_active(&b);
        assert_eq!(b.status, Status::Proposed, "Proposal is not open");
        let p = other_proposal(&b, &proposal_id, expected_revision);
        self.settle(&mut b, p.outcome, ResolutionMethod::Agreement);
        self.bets.insert(&id, &b);
    }

    pub fn dispute_outcome(&mut self, id: String, proposal_id: String, expected_revision: U64) {
        let mut b = self.bet(&id);
        assert_active(&b);
        assert_eq!(b.status, Status::Proposed, "Proposal is not open");
        other_proposal(&b, &proposal_id, expected_revision);
        b.status = Status::Disputed;
        self.bets.insert(&id, &b);
    }

    pub fn finalize_unanswered(&mut self, id: String, proposal_id: String, expected_revision: U64) {
        let mut b = self.bet(&id);
        assert_active(&b);
        assert_eq!(b.status, Status::Proposed, "Proposal is not open");
        // With a referee named, silence is not consent: the referee decides, or the
        // stakes go back. Otherwise a participant could win by proposing a result
        // the other side never sees before the referee has ruled.
        assert!(b.referee.is_none(), "A referee decides this bet");
        let p = current_proposal(&b, &proposal_id, expected_revision);
        assert_eq!(
            env::predecessor_account_id(),
            p.proposer,
            "Only the proposer can finalize"
        );
        assert!(
            env::block_timestamp() >= add_time(p.proposed_at_ns.0, RESPONSE_WINDOW_NS),
            "Response window remains open"
        );
        self.settle(&mut b, p.outcome, ResolutionMethod::Unanswered);
        self.bets.insert(&id, &b);
    }

    pub fn referee_resolve(&mut self, id: String, outcome: Outcome) {
        let mut b = self.bet(&id);
        assert!(
            b.referee.as_ref() == Some(&env::predecessor_account_id()),
            "Only the referee can resolve"
        );
        assert_active(&b);
        self.settle(&mut b, outcome, ResolutionMethod::Referee);
        self.bets.insert(&id, &b);
    }

    pub fn refund_unresolved(&mut self, id: String) {
        let mut b = self.bet(&id);
        assert_active(&b);
        // Without a referee an unanswered proposal can be finalized, so it blocks the
        // refund. With one it cannot, so it must not hold the stakes forever.
        assert!(
            b.status != Status::Proposed || b.referee.is_some(),
            "An unanswered result stands; dispute it or let it finalize"
        );
        assert!(
            env::block_timestamp() >= add_time(b.resolve_at_ns, RESOLUTION_WINDOW_NS),
            "Resolution window remains open"
        );
        let acceptor = accepted_account(&b);
        b.status = Status::Refunded;
        self.credit(&b.creator, b.stake_yocto);
        self.credit(&acceptor, b.stake_yocto);
        self.bets.insert(&id, &b);
    }

    pub fn withdraw(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.credits.get(&caller).unwrap_or(0);
        assert!(amount > 0, "No withdrawal credit");
        self.credits.insert(&caller, &0);
        Promise::new(caller.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Promise::new(env::current_account_id()).function_call("on_withdraw".to_owned(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "account_id": caller, "amount": U128(amount) }))
                    .unwrap_or_else(|_| env::panic_str("Callback serialization failed")),
                NearToken::from_yoctonear(0), Gas::from_tgas(10)))
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Private callback"
        );
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one transfer result"
        );
        match env::promise_result_checked(0, 0) {
            Ok(_) => true,
            Err(PromiseError::Failed) => {
                self.credit(&account_id, amount.0);
                false
            }
            Err(_) => env::panic_str("Unexpected transfer result"),
        }
    }

    pub fn get_bet(&self, id: String) -> Option<BetView> {
        self.bets.get(&id).map(BetView::from)
    }
    pub fn get_credit(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).unwrap_or(0))
    }
    pub fn storage_fee(&self) -> U128 {
        U128(STORAGE_FEE)
    }
    pub fn version(&self) -> String {
        "2".to_owned()
    }
    pub fn response_window_ns(&self) -> U64 {
        U64(RESPONSE_WINDOW_NS)
    }
}

impl Contract {
    fn bet(&self, id: &String) -> Bet {
        self.bets
            .get(id)
            .unwrap_or_else(|| env::panic_str("Bet not found"))
    }
    fn credit(&mut self, account: &AccountId, amount: u128) {
        let current = self.credits.get(account).unwrap_or(0);
        self.credits.insert(account, &add(current, amount));
    }
    fn resolvable(&self, b: &Bet) {
        assert_active(b);
        let now = env::block_timestamp();
        assert!(now >= b.resolve_at_ns, "Resolution time has not arrived");
        assert!(
            now < add_time(b.resolve_at_ns, RESOLUTION_WINDOW_NS),
            "Resolution window closed; refund required"
        );
    }
    /// The only payout path: credits the stakes per `outcome` and records the resolution.
    /// The caller persists the bet.
    fn settle(&mut self, b: &mut Bet, outcome: Outcome, method: ResolutionMethod) {
        let acceptor = accepted_account(b);
        match outcome {
            Outcome::Void => {
                self.credit(&b.creator, b.stake_yocto);
                self.credit(&acceptor, b.stake_yocto);
            }
            outcome => {
                let creator_wins = matches!(
                    (b.creator_side, outcome),
                    (Side::Yes, Outcome::Yes) | (Side::No, Outcome::No)
                );
                let winner = if creator_wins { &b.creator } else { &acceptor };
                self.credit(winner, add(b.stake_yocto, b.stake_yocto));
            }
        }
        b.status = Status::Settled;
        b.resolution = Some(Resolution {
            outcome,
            method,
            resolved_at_ns: U64(env::block_timestamp()),
        });
    }
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("Amount overflow"))
}
fn add_time(a: u64, b: u64) -> u64 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("Timestamp overflow"))
}
fn assert_active(b: &Bet) {
    assert!(
        matches!(
            b.status,
            Status::Accepted | Status::Proposed | Status::Disputed
        ),
        "Bet is not active"
    );
}
fn accepted_account(b: &Bet) -> AccountId {
    b.acceptor
        .clone()
        .unwrap_or_else(|| env::panic_str("Bet has no acceptor"))
}
fn participant(b: &Bet, account: &AccountId) {
    assert!(
        account == &b.creator || b.acceptor.as_ref() == Some(account),
        "Only participants can resolve"
    );
}
fn current_proposal(b: &Bet, id: &str, expected_revision: U64) -> Proposal {
    let p = b
        .proposal
        .clone()
        .unwrap_or_else(|| env::panic_str("No outcome proposal"));
    assert_eq!(p.id, id, "Proposal is stale");
    assert_eq!(p.revision, expected_revision, "Proposal revision is stale");
    p
}
fn other_proposal(b: &Bet, id: &str, expected_revision: U64) -> Proposal {
    let caller = env::predecessor_account_id();
    participant(b, &caller);
    let p = current_proposal(b, id, expected_revision);
    assert_ne!(p.proposer, caller, "Other participant must respond");
    p
}
/// Validates lowercase hex64 and decodes it to 32 bytes (half the storage of the string).
fn parse_hash(value: &str) -> [u8; 32] {
    let nibble = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => env::panic_str("Hash must be lowercase hex64"),
    };
    if value.len() != 64 {
        env::panic_str("Hash must be lowercase hex64");
    }
    let mut out = [0u8; 32];
    for (byte, pair) in out.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *byte = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    out
}
fn hex(hash: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in hash {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }
    out
}
fn valid_uuid(value: &str) {
    assert!(
        value.len() == 36
            && value.bytes().enumerate().all(|(i, c)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    c == b'-'
                } else {
                    c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
                }
            }),
        "Id must be canonical lowercase UUID"
    );
}

#[cfg(test)]
mod tests {
    use crate::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    const PROPOSAL: &str = "00000000-0000-4000-8000-000000000002";
    const STAKE: u128 = 100_000_000_000_000_000_000_000;
    const ACCEPT: u64 = DAY_NS;
    const RESOLVE: u64 = 2 * DAY_NS;
    fn account(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }
    fn context(name: &str, now: u64, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(account("escrow"))
            .predecessor_account_id(account(name))
            .signer_account_id(account(name))
            .block_timestamp(now)
            .account_balance(NearToken::from_near(100))
            .attached_deposit(NearToken::from_yoctonear(deposit));
        b
    }
    fn set(name: &str, now: u64, deposit: u128) {
        testing_env!(context(name, now, deposit).build());
    }
    fn offered() -> Contract {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            None,
        );
        c
    }
    fn matched() -> Contract {
        let mut c = offered();
        set("bob", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
        c
    }
    fn proposed() -> Contract {
        let mut c = matched();
        set("alice", RESOLVE, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Yes);
        c
    }
    #[test]
    fn mutual_settlement_credits_full_stakes_and_preserves_bindings() {
        let mut c = proposed();
        set("bob", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_credit(account("alice")).0, STAKE * 2);
        assert_eq!(c.get_credit(account("bob")).0, 0);
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Settled);
        assert_eq!(b.creator_binding_hash, "b".repeat(64));
        assert_eq!(b.acceptor_binding_hash, Some("c".repeat(64)));
        let json = near_sdk::serde_json::to_value(b).unwrap();
        assert_eq!(json["stake_yocto"], STAKE.to_string());
        assert_eq!(json["resolve_at_ns"], RESOLVE.to_string());
        assert_eq!(json["proposal"]["revision"], "1");
    }
    #[test]
    fn creator_no_side_pays_acceptor_when_yes_wins() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "no".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            None,
        );
        set("bob", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
        set("alice", RESOLVE, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Yes);
        set("bob", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_credit(account("alice")).0, 0);
        assert_eq!(c.get_credit(account("bob")).0, STAKE * 2);
    }
    #[test]
    #[should_panic(expected = "Creator cannot accept")]
    fn creator_cannot_accept() {
        let mut c = offered();
        set("alice", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
    }
    #[test]
    #[should_panic(expected = "Deposit must equal stake")]
    fn wrong_accept_deposit_rejected() {
        let mut c = offered();
        set("bob", 1, STAKE - 1);
        c.accept_bet(ID.into(), "c".repeat(64));
    }
    #[test]
    #[should_panic(expected = "Account is not invited")]
    fn uninvited_accept_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "no".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            Some(account("bob")),
            "b".repeat(64),
            None,
        );
        set("mallory", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
    }
    #[test]
    #[should_panic(expected = "Other participant must respond")]
    fn proposer_cannot_self_confirm() {
        let mut c = proposed();
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Acceptance deadline passed")]
    fn acceptance_at_deadline_rejected() {
        let mut c = offered();
        set("bob", ACCEPT, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
    }
    #[test]
    fn late_confirmation_settles_after_window_closes() {
        let mut c = proposed();
        set("bob", RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Settled);
        assert_eq!(b.resolution.unwrap().method, ResolutionMethod::Agreement);
        assert_eq!(c.get_credit(account("alice")).0, STAKE * 2);
    }
    #[test]
    fn late_dispute_succeeds_after_window_closes() {
        let mut c = proposed();
        set("bob", RESOLVE + 10 * RESOLUTION_WINDOW_NS, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Disputed);
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn settlement_replay_rejected() {
        let mut c = proposed();
        set("bob", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Bet is not offered")]
    fn repeated_accept_rejected() {
        let mut c = matched();
        set("bob", 1, STAKE);
        c.accept_bet(ID.into(), "d".repeat(64));
    }
    #[test]
    #[should_panic(expected = "Only participants")]
    fn outsider_cannot_resolve() {
        let mut c = matched();
        set("mallory", RESOLVE, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::No);
    }
    #[test]
    fn expired_offer_refunds_stake_without_storage_fee() {
        let mut c = offered();
        set("mallory", ACCEPT, 0);
        c.expire_bet(ID.into());
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Expired);
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
    }
    #[test]
    fn creator_cancellation_credits_full_stake() {
        let mut c = offered();
        set("alice", 1, 0);
        c.cancel_bet(ID.into());
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Cancelled);
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
    }
    #[test]
    #[should_panic(expected = "Only creator can cancel")]
    fn outsider_cancellation_rejected() {
        let mut c = offered();
        set("bob", 1, 0);
        c.cancel_bet(ID.into());
    }
    #[test]
    #[should_panic(expected = "Resolution time has not arrived")]
    fn premature_proposal_rejected() {
        let mut c = matched();
        set("alice", RESOLVE - 1, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Resolution window remains open")]
    fn premature_refund_rejected() {
        let mut c = matched();
        set("mallory", RESOLVE + RESOLUTION_WINDOW_NS - 1, 0);
        c.refund_unresolved(ID.into());
    }
    #[test]
    #[should_panic(expected = "Deposit must equal stake plus storage fee")]
    fn create_must_fund_storage_separately() {
        set("alice", 0, STAKE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            None,
        );
    }
    #[test]
    fn unresolved_dispute_refunds_each_stake() {
        let mut c = proposed();
        set("bob", RESOLVE, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Disputed);
        set("mallory", RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.refund_unresolved(ID.into());
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Refunded);
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
        assert_eq!(c.get_credit(account("bob")).0, STAKE);
    }
    #[test]
    fn void_settlement_and_failed_withdrawal_restore_credit() {
        let mut c = matched();
        set("bob", RESOLVE, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Void);
        set("alice", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
        assert_eq!(c.get_credit(account("bob")).0, STAKE);
        c.withdraw().detach();
        assert_eq!(c.get_credit(account("alice")).0, 0);
        assert_eq!(get_created_receipts().len(), 2);
        let ctx = context("escrow", RESOLVE, 0).build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            vec![PromiseResult::Failed]
        );
        assert!(!c.on_withdraw(account("alice"), U128(STAKE)));
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
    }
    #[test]
    fn successful_withdrawal_does_not_restore_credit() {
        let mut c = offered();
        set("alice", 1, 0);
        c.cancel_bet(ID.into());
        c.withdraw().detach();
        let ctx = context("escrow", RESOLVE, 0).build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            vec![PromiseResult::Successful(vec![])]
        );
        assert!(c.on_withdraw(account("alice"), U128(STAKE)));
        assert_eq!(c.get_credit(account("alice")).0, 0);
    }
    #[test]
    #[should_panic(expected = "Private callback")]
    fn external_callback_rejected() {
        let mut c = offered();
        c.on_withdraw(account("mallory"), U128(STAKE));
    }
    #[test]
    #[should_panic(expected = "Only offered bet")]
    fn accepted_cancellation_rejected() {
        let mut c = matched();
        set("alice", 1, 0);
        c.cancel_bet(ID.into());
    }
    #[test]
    #[should_panic(expected = "Proposal is stale")]
    fn replaced_proposal_rejects_stale_confirmation() {
        let mut c = proposed();
        c.propose_outcome(
            ID.into(),
            "00000000-0000-4000-8000-000000000003".into(),
            Outcome::No,
        );
        set("bob", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Proposal revision is stale")]
    fn historical_proposal_id_reuse_rejects_old_confirmation() {
        let mut c = proposed();
        c.propose_outcome(
            ID.into(),
            "00000000-0000-4000-8000-000000000003".into(),
            Outcome::No,
        );
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::No);
        assert_eq!(
            c.get_bet(ID.into()).unwrap().proposal.unwrap().revision.0,
            3
        );
        set("bob", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Proposal revision is stale")]
    fn replaced_proposal_rejects_stale_dispute() {
        let mut c = proposed();
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::No);
        set("bob", RESOLVE, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    fn disputed_bet_can_settle_current_revision_after_counterproposal() {
        let mut c = proposed();
        set("bob", RESOLVE, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::No);
        assert_eq!(
            c.get_bet(ID.into()).unwrap().proposal.unwrap().revision.0,
            2
        );
        set("alice", RESOLVE, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(2));
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Settled);
        assert_eq!(c.get_credit(account("alice")).0, 0);
        assert_eq!(c.get_credit(account("bob")).0, STAKE * 2);
    }
    const REFEREE_SIDE: &str = "carol";
    fn refereed() -> Contract {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account(REFEREE_SIDE)),
        );
        set("bob", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
        c
    }
    fn refereed_proposed() -> Contract {
        let mut c = refereed();
        set("alice", RESOLVE, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Yes);
        c
    }
    fn refereed_disputed() -> Contract {
        let mut c = refereed_proposed();
        set("bob", RESOLVE, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
        c
    }
    fn assert_referee_result(c: &Contract, outcome: Outcome, alice: u128, bob: u128) {
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Settled);
        let r = b.resolution.unwrap();
        assert_eq!(r.method, ResolutionMethod::Referee);
        assert_eq!(r.outcome, outcome);
        assert_eq!(r.resolved_at_ns.0, RESOLVE + 5);
        assert_eq!(c.get_credit(account("alice")).0, alice);
        assert_eq!(c.get_credit(account("bob")).0, bob);
    }
    fn referee_resolves(mut c: Contract, outcome: Outcome, alice: u128, bob: u128) {
        set(REFEREE_SIDE, RESOLVE + 5, 0);
        c.referee_resolve(ID.into(), outcome);
        assert_referee_result(&c, outcome, alice, bob);
    }
    #[test]
    fn referee_resolves_yes_from_accepted() {
        referee_resolves(refereed(), Outcome::Yes, STAKE * 2, 0);
    }
    #[test]
    fn referee_resolves_no_from_accepted() {
        referee_resolves(refereed(), Outcome::No, 0, STAKE * 2);
    }
    #[test]
    fn referee_resolves_void_from_accepted() {
        referee_resolves(refereed(), Outcome::Void, STAKE, STAKE);
    }
    #[test]
    fn referee_resolves_yes_from_proposed() {
        referee_resolves(refereed_proposed(), Outcome::Yes, STAKE * 2, 0);
    }
    #[test]
    fn referee_resolves_no_from_proposed() {
        referee_resolves(refereed_proposed(), Outcome::No, 0, STAKE * 2);
    }
    #[test]
    fn referee_resolves_void_from_proposed() {
        referee_resolves(refereed_proposed(), Outcome::Void, STAKE, STAKE);
    }
    #[test]
    fn referee_resolves_yes_from_disputed() {
        referee_resolves(refereed_disputed(), Outcome::Yes, STAKE * 2, 0);
    }
    #[test]
    fn referee_resolves_no_from_disputed() {
        referee_resolves(refereed_disputed(), Outcome::No, 0, STAKE * 2);
    }
    #[test]
    fn referee_resolves_void_from_disputed() {
        referee_resolves(refereed_disputed(), Outcome::Void, STAKE, STAKE);
    }
    #[test]
    fn referee_can_resolve_before_resolution_time() {
        let mut c = refereed();
        set(REFEREE_SIDE, 2, 0);
        c.referee_resolve(ID.into(), Outcome::No);
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.resolution.unwrap().resolved_at_ns.0, 2);
        assert_eq!(c.get_credit(account("bob")).0, STAKE * 2);
    }
    #[test]
    #[should_panic(expected = "Only the referee can resolve")]
    fn non_referee_cannot_referee_resolve() {
        let mut c = refereed();
        set("mallory", RESOLVE, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Only the referee can resolve")]
    fn participant_cannot_referee_resolve() {
        let mut c = refereed();
        set("alice", RESOLVE, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Only the referee can resolve")]
    fn bet_without_referee_cannot_referee_resolve() {
        let mut c = matched();
        set("carol", RESOLVE, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Referee cannot be a participant")]
    fn referee_cannot_accept() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account("carol")),
        );
        set("carol", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
    }
    #[test]
    #[should_panic(expected = "Referee cannot be a participant")]
    fn referee_equal_to_creator_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account("alice")),
        );
    }
    #[test]
    #[should_panic(expected = "Referee cannot be a participant")]
    fn referee_equal_to_invited_account_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            Some(account("bob")),
            "b".repeat(64),
            Some(account("bob")),
        );
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn referee_resolve_after_settlement_rejected() {
        let mut c = refereed();
        set(REFEREE_SIDE, RESOLVE, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
        c.referee_resolve(ID.into(), Outcome::No);
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn referee_resolve_after_cancellation_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account("carol")),
        );
        set("alice", 1, 0);
        c.cancel_bet(ID.into());
        set("carol", 2, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn referee_resolve_after_expiry_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account("carol")),
        );
        set("mallory", ACCEPT, 0);
        c.expire_bet(ID.into());
        set("carol", ACCEPT + 1, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn referee_resolve_after_refund_rejected() {
        let mut c = refereed();
        set("mallory", RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.refund_unresolved(ID.into());
        set(REFEREE_SIDE, RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    #[should_panic(expected = "Bet is not active")]
    fn referee_resolve_before_acceptance_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(account("carol")),
        );
        set("carol", 1, 0);
        c.referee_resolve(ID.into(), Outcome::Yes);
    }
    #[test]
    fn finalize_unanswered_settles_after_response_window() {
        let mut c = proposed();
        set("alice", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Settled);
        let r = b.resolution.unwrap();
        assert_eq!(r.method, ResolutionMethod::Unanswered);
        assert_eq!(r.outcome, Outcome::Yes);
        assert_eq!(r.resolved_at_ns.0, RESOLVE + RESPONSE_WINDOW_NS);
        assert_eq!(c.get_credit(account("alice")).0, STAKE * 2);
        assert_eq!(c.get_credit(account("bob")).0, 0);
    }
    #[test]
    fn finalize_unanswered_works_after_resolution_window_closes() {
        let mut c = proposed();
        set("alice", RESOLVE + 3 * RESOLUTION_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Settled);
    }
    #[test]
    #[should_panic(expected = "Response window remains open")]
    fn finalize_unanswered_rejected_before_window() {
        let mut c = proposed();
        set("alice", RESOLVE + RESPONSE_WINDOW_NS - 1, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Only the proposer can finalize")]
    fn finalize_unanswered_rejected_for_non_proposer() {
        let mut c = proposed();
        set("bob", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Only the proposer can finalize")]
    fn finalize_unanswered_rejected_for_outsider() {
        let mut c = proposed();
        set("mallory", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    #[should_panic(expected = "Proposal is stale")]
    fn finalize_unanswered_rejected_for_stale_id() {
        let mut c = proposed();
        set("alice", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(
            ID.into(),
            "00000000-0000-4000-8000-000000000003".into(),
            U64(1),
        );
    }
    #[test]
    #[should_panic(expected = "Proposal revision is stale")]
    fn finalize_unanswered_rejected_for_stale_revision() {
        let mut c = proposed();
        set("alice", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(2));
    }
    #[test]
    #[should_panic(expected = "Proposal is not open")]
    fn finalize_unanswered_rejected_once_disputed() {
        let mut c = proposed();
        set("bob", RESOLVE, 0);
        c.dispute_outcome(ID.into(), PROPOSAL.into(), U64(1));
        set("alice", RESOLVE + RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    fn replacing_a_proposal_restarts_the_response_clock() {
        let mut c = proposed();
        set("bob", RESOLVE + RESPONSE_WINDOW_NS - 1, 0);
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::No);
        assert_eq!(
            c.get_bet(ID.into())
                .unwrap()
                .proposal
                .unwrap()
                .proposed_at_ns
                .0,
            RESOLVE + RESPONSE_WINDOW_NS - 1
        );
    }
    #[test]
    #[should_panic(expected = "An unanswered result stands")]
    fn refund_rejected_while_proposed_after_both_windows() {
        let mut c = proposed();
        set("mallory", RESOLVE + 10 * RESOLUTION_WINDOW_NS, 0);
        c.refund_unresolved(ID.into());
    }
    #[test]
    #[should_panic(expected = "A referee decides this bet")]
    fn finalize_unanswered_rejected_when_a_referee_is_named() {
        let mut c = refereed_proposed();
        set("alice", RESOLVE + 3 * RESPONSE_WINDOW_NS, 0);
        c.finalize_unanswered(ID.into(), PROPOSAL.into(), U64(1));
    }
    #[test]
    fn refund_succeeds_while_proposed_when_a_referee_is_named() {
        let mut c = refereed_proposed();
        set("mallory", RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.refund_unresolved(ID.into());
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Refunded);
        assert!(b.resolution.is_none());
        assert_eq!(c.get_credit(account("alice")).0, STAKE);
        assert_eq!(c.get_credit(account("bob")).0, STAKE);
    }
    #[test]
    fn mutual_agreement_still_settles_a_refereed_bet() {
        let mut c = refereed_proposed();
        set("bob", RESOLVE + 1, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.status, Status::Settled);
        assert_eq!(b.resolution.unwrap().method, ResolutionMethod::Agreement);
    }
    #[test]
    fn refund_succeeds_for_accepted_bet_after_window() {
        let mut c = matched();
        set("mallory", RESOLVE + RESOLUTION_WINDOW_NS, 0);
        c.refund_unresolved(ID.into());
        assert_eq!(c.get_bet(ID.into()).unwrap().status, Status::Refunded);
        assert!(c.get_bet(ID.into()).unwrap().resolution.is_none());
    }
    #[test]
    fn proposed_at_is_recorded_and_views_expose_v2_fields() {
        let mut c = refereed_proposed();
        let b = c.get_bet(ID.into()).unwrap();
        assert_eq!(b.proposal.as_ref().unwrap().proposed_at_ns.0, RESOLVE);
        let json = near_sdk::serde_json::to_value(&b).unwrap();
        assert_eq!(json["referee"], "carol.testnet");
        assert_eq!(json["proposal"]["proposed_at_ns"], RESOLVE.to_string());
        assert!(json["resolution"].is_null());
        set("bob", RESOLVE + 7, 0);
        c.confirm_outcome(ID.into(), PROPOSAL.into(), U64(1));
        let json = near_sdk::serde_json::to_value(c.get_bet(ID.into()).unwrap()).unwrap();
        assert_eq!(json["resolution"]["outcome"], "yes");
        assert_eq!(json["resolution"]["method"], "agreement");
        assert_eq!(
            json["resolution"]["resolved_at_ns"],
            (RESOLVE + 7).to_string()
        );
    }
    #[test]
    fn view_without_referee_is_null() {
        let json = near_sdk::serde_json::to_value(matched().get_bet(ID.into()).unwrap()).unwrap();
        assert!(json["referee"].is_null());
        assert!(json["resolution"].is_null());
    }
    #[test]
    #[should_panic(expected = "Hash must be lowercase hex64")]
    fn uppercase_hash_rejected() {
        set("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "A".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            None,
        );
    }
    #[test]
    fn hash_round_trips_through_view() {
        let h = "0123456789abcdef".repeat(4);
        assert_eq!(hex(&parse_hash(&h)), h);
    }
    #[test]
    fn unanswered_and_referee_methods_serialize_lowercase() {
        for (m, s) in [
            (ResolutionMethod::Agreement, "agreement"),
            (ResolutionMethod::Unanswered, "unanswered"),
            (ResolutionMethod::Referee, "referee"),
        ] {
            assert_eq!(near_sdk::serde_json::to_value(m).unwrap(), s);
        }
    }
    #[test]
    fn version_and_response_window_views() {
        let c = offered();
        assert_eq!(c.version(), "2");
        assert_eq!(c.response_window_ns().0, 2 * DAY_NS);
        assert_eq!(c.storage_fee().0, 10_000_000_000_000_000_000_000);
    }
    #[test]
    fn worst_case_storage_is_paid_by_retained_fee() {
        let long = |c: &str| -> AccountId { format!("{}.testnet", c.repeat(56)).parse().unwrap() };
        let (creator, acceptor, referee) = (long("a"), long("b"), long("c"));
        let mut ctx = context("alice", 0, STAKE + STORAGE_FEE);
        ctx.predecessor_account_id(creator.clone());
        testing_env!(ctx.build());
        let mut c = Contract::new();
        let start = env::storage_usage();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            Some(acceptor.clone()),
            "b".repeat(64),
            Some(referee.clone()),
        );
        let creation_bytes = env::storage_usage() - start;
        let mut ctx = context("bob", 1, STAKE);
        ctx.predecessor_account_id(acceptor.clone());
        testing_env!(ctx.build());
        let start = env::storage_usage();
        c.accept_bet(ID.into(), "c".repeat(64));
        let acceptance_bytes = env::storage_usage() - start;
        let mut ctx = context("alice", RESOLVE, 0);
        ctx.predecessor_account_id(creator);
        testing_env!(ctx.build());
        let start = env::storage_usage();
        c.propose_outcome(ID.into(), PROPOSAL.into(), Outcome::Yes);
        let proposal_bytes = env::storage_usage() - start;
        let mut ctx = context("carol", RESOLVE, 0);
        ctx.predecessor_account_id(referee);
        testing_env!(ctx.build());
        let start = env::storage_usage();
        c.referee_resolve(ID.into(), Outcome::No);
        let resolution_bytes = env::storage_usage() - start;
        let total = creation_bytes + acceptance_bytes + proposal_bytes + resolution_bytes;
        assert!(
            u128::from(total) * env::storage_byte_cost().as_yoctonear() <= STORAGE_FEE,
            "{total} bytes exceeds fee"
        );
    }
    #[test]
    fn runs_under_a_mainnet_name_with_the_same_rules() {
        let near = |name: &str| -> AccountId { format!("{name}.near").parse().unwrap() };
        let at = |name: &str, now: u64, deposit: u128| {
            let mut ctx = context(name, now, deposit);
            ctx.current_account_id(near("escrow"))
                .predecessor_account_id(near(name))
                .signer_account_id(near(name));
            testing_env!(ctx.build());
        };
        at("alice", 0, STAKE + STORAGE_FEE);
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(STAKE),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            Some(near("referee")),
        );
        at("bob", 1, STAKE);
        c.accept_bet(ID.into(), "c".repeat(64));
        at("referee", 2, 0);
        c.referee_resolve(ID.into(), Outcome::No);
        assert_eq!(c.get_credit(near("bob")).0, 2 * STAKE);
        assert_eq!(c.get_credit(near("alice")).0, 0);
    }
    #[test]
    #[should_panic(expected = "Stake must be positive and at most 1 NEAR")]
    fn a_stake_above_one_near_is_refused_on_any_network() {
        let mut ctx = context("alice", 0, MAX_STAKE + 1 + STORAGE_FEE);
        ctx.current_account_id("escrow.near".parse().unwrap());
        testing_env!(ctx.build());
        let mut c = Contract::new();
        c.create_bet(
            ID.into(),
            "a".repeat(64),
            "yes".into(),
            U128(MAX_STAKE + 1),
            U64(ACCEPT),
            U64(RESOLVE),
            None,
            "b".repeat(64),
            None,
        );
    }
}
