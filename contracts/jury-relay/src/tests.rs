use crate::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};

const ID: &str = "a0000000-0000-4000-8000-000000000001";
const DEADLINE: u64 = 1_000;
const SUBMITTED: u64 = DEADLINE + 5 * NS_PER_SECOND;
const WINDOW: u64 = 60 * NS_PER_SECOND;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &str, now: u64, deposit: u128, gas: Gas) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(account("relay.near"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(gas)
        .build()
}

fn set(predecessor: &str, now: u64, results: Vec<PromiseResult>) {
    testing_env!(
        context(predecessor, now, 0, APPROVE_GAS),
        test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn contract() -> Contract {
    set("anyone.near", 0, vec![]);
    Contract::new(
        account("dao.near"),
        account("escrow.near"),
        account("operator.near"),
        60,
    )
}

fn proposal() -> Value {
    json!({
        "id": 7,
        "proposer": "relay.near",
        "description": "A ruling",
        "status": "InProgress",
        "kind": {"FunctionCall": {
            "receiver_id": "escrow.near",
            "actions": [{
                "method_name": "referee_resolve",
                "args": Base64VecU8(json(&Resolution {id: ID.into(), outcome: "yes".into()})),
                "deposit": "0",
                "gas": RESOLVE_GAS
            }]
        }},
        "submission_time": SUBMITTED.to_string(),
        "votes": {},
        "vote_counts": {}
    })
}

fn callback(c: &mut Contract, value: &Value, now: u64) {
    set(
        "relay.near",
        now,
        vec![PromiseResult::Successful(json(value))],
    );
    drop(c.on_proposal(7));
}

fn kind() -> ProposalKind {
    near_sdk::serde_json::from_value(proposal()["kind"].clone()).unwrap()
}

fn bet() -> Value {
    // Start with an actual escrow BetView, normalizing the identity and time for
    // this isolated court and restoring its active, pre-settlement state.
    let record: Value = near_sdk::serde_json::from_str(include_str!(
        "../../../evidence/public-result-testnet-20261111.json"
    ))
    .unwrap();
    let mut bet = record["finalState"].clone();
    bet["id"] = json!(ID);
    bet["referee"] = json!("dao.near");
    bet["resolve_at_ns"] = json!(DEADLINE.to_string());
    bet["status"] = json!("accepted");
    bet["resolution"] = Value::Null;
    bet
}

fn bet_callback(c: &mut Contract, value: &Value, now: u64) {
    set(
        "relay.near",
        now,
        vec![PromiseResult::Successful(json(value))],
    );
    drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED)));
}

fn fails(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
    assert!(
        get_created_receipts().is_empty(),
        "Failure emitted a receipt"
    );
}

fn function_calls() -> Vec<(String, Value, NearToken, Gas)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| receipt.actions)
        .filter_map(|action| match action {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                gas_weight,
                ..
            } => {
                assert_eq!(gas_weight.0, 0, "Gas allocations must be static");
                Some((
                    String::from_utf8(method_name).unwrap(),
                    near_sdk::serde_json::from_slice(&args).unwrap(),
                    attached_deposit,
                    prepaid_gas,
                ))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn config_and_window_bounds() {
    let c = contract();
    assert_eq!(c.version(), "0.2.0");
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_config()).unwrap(),
        json!({"dao":"dao.near","escrow":"escrow.near","operator":"operator.near","window_ns": WINDOW.to_string()})
    );
    for seconds in [0, 59, 86_401, u32::MAX] {
        set("anyone.near", 0, vec![]);
        fails(|| {
            Contract::new(
                account("dao.near"),
                account("escrow.near"),
                account("operator.near"),
                seconds,
            );
        });
    }
    for seconds in [60, 86_400] {
        assert_eq!(
            Contract::new(
                account("dao.near"),
                account("escrow.near"),
                account("operator.near"),
                seconds
            )
            .window_ns,
            u64::from(seconds) * NS_PER_SECOND
        );
    }
}

#[test]
fn file_forwards_bond_and_exact_proposal_for_all_outcomes() {
    let mut c = contract();
    for outcome in ["yes", "no", "void"] {
        testing_env!(context("operator.near", 0, 12345, APPROVE_GAS));
        drop(c.file(ID.into(), outcome.into(), "A ruling".into()));
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, account("dao.near"));
        let calls = function_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "add_proposal");
        assert_eq!(calls[0].2.as_yoctonear(), 12345);
        assert_eq!(calls[0].3, FILE_GAS);
        let mut expected = proposal();
        expected["kind"]["FunctionCall"]["actions"][0]["args"] =
            near_sdk::serde_json::to_value(Base64VecU8(json(&Resolution {
                id: ID.into(),
                outcome: outcome.into(),
            })))
            .unwrap();
        assert_eq!(
            calls[0].1,
            json!({"proposal":{"description":"A ruling","kind":expected["kind"]}})
        );
    }
}

#[test]
fn file_rejects_non_operator_and_invalid_inputs() {
    let mut c = contract();
    set("outsider.near", 0, vec![]);
    fails(|| drop(c.file(ID.into(), "yes".into(), String::new())));
    for id in [
        ID.to_uppercase(),
        ID.replace('-', ""),
        "x".repeat(36),
        format!("{ID}0"),
    ] {
        set("operator.near", 0, vec![]);
        fails(|| drop(c.file(id, "yes".into(), String::new())));
    }
    for outcome in ["YES", "", "abstain"] {
        set("operator.near", 0, vec![]);
        fails(|| drop(c.file(ID.into(), outcome.into(), String::new())));
    }
    for description in ["x".repeat(1001), "é".repeat(501)] {
        set("operator.near", 0, vec![]);
        fails(|| drop(c.file(ID.into(), "yes".into(), description)));
    }
    set("operator.near", 0, vec![]);
    drop(c.file(ID.into(), "yes".into(), "é".repeat(500)));
    assert_eq!(get_created_receipts().len(), 1);
}

#[test]
fn approve_is_permissionless_and_uses_bounded_nested_gas() {
    let mut c = contract();
    set("stranger.near", 0, vec![]);
    drop(c.approve(7));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, account("dao.near"));
    assert_eq!(receipts[1].receiver_id, account("relay.near"));
    assert!(!receipts[1].receipt_indices.is_empty());
    let calls = function_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0],
        (
            "get_proposal".into(),
            json!({"id":7}),
            NearToken::from_yoctonear(0),
            READ_GAS
        )
    );
    assert_eq!(
        calls[1],
        (
            "on_proposal".into(),
            json!({"id":7}),
            NearToken::from_yoctonear(0),
            CALLBACK_GAS
        )
    );
    // The VM's used_gas includes gas reserved for promises. Subtract those
    // reservations to measure the root receipt's own burnt gas.
    let root_cost = env::used_gas().as_gas() - READ_GAS.as_gas() - CALLBACK_GAS.as_gas();
    assert!(root_cost + READ_GAS.as_gas() + CALLBACK_GAS.as_gas() <= APPROVE_GAS.as_gas());

    testing_env!(
        context("relay.near", SUBMITTED + WINDOW, 0, CALLBACK_GAS),
        test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(json(&proposal()))]
    );
    drop(c.on_proposal(7));
    let callback_cost = env::used_gas().as_gas() - READ_GAS.as_gas() - BET_CALLBACK_GAS.as_gas();
    assert!(callback_cost + READ_GAS.as_gas() + BET_CALLBACK_GAS.as_gas() <= CALLBACK_GAS.as_gas());
    testing_env!(
        context("relay.near", SUBMITTED + WINDOW, 0, BET_CALLBACK_GAS),
        test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(json(&bet()))]
    );
    drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED)));
    let bet_callback_cost = env::used_gas().as_gas() - ACT_GAS.as_gas();
    assert!(bet_callback_cost + ACT_GAS.as_gas() <= BET_CALLBACK_GAS.as_gas());
    // The 100-Tgas escrow action is nested inside act_proposal's 200 Tgas.
    assert!(100_000_000_000_000 < ACT_GAS.as_gas());
    println!("own gas: root {root_cost}, proposal callback {callback_cost}, bet callback {bet_callback_cost}; nested allocations: 10+260, 10+220, 200 Tgas");
}

#[test]
fn proposal_callback_reads_bet_before_voting() {
    let mut c = contract();
    callback(&mut c, &proposal(), SUBMITTED + WINDOW);
    assert!(
        function_calls().iter().all(|call| call.0 != "act_proposal"),
        "Proposal callback voted without reading the bet deadline"
    );
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, account("escrow.near"));
    assert_eq!(receipts[1].receiver_id, account("relay.near"));
    assert!(!receipts[1].receipt_indices.is_empty());
    assert_eq!(
        function_calls(),
        vec![
            (
                "get_bet".into(),
                json!({"id":ID}),
                NearToken::from_yoctonear(0),
                READ_GAS
            ),
            (
                "on_bet".into(),
                json!({"id":7,"bet_id":ID,"kind":proposal()["kind"],"submission_time":SUBMITTED.to_string()}),
                NearToken::from_yoctonear(0),
                BET_CALLBACK_GAS
            )
        ]
    );
}

#[test]
fn approve_rejects_underfunded_gas() {
    let mut c = contract();
    testing_env!(context("stranger.near", 0, 0, Gas::from_tgas(299)));
    fails(|| drop(c.approve(7)));
}

#[test]
fn callback_votes_at_boundary_and_after_with_full_u64_timestamp() {
    let mut c = contract();
    for now in [SUBMITTED + WINDOW, SUBMITTED + WINDOW + 1, u64::MAX] {
        callback(&mut c, &proposal(), now);
        bet_callback(&mut c, &bet(), now);
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, account("dao.near"));
        assert_eq!(
            function_calls(),
            vec![(
                "act_proposal".into(),
                json!({"id":7,"action":"VoteApprove","proposal":proposal()["kind"]}),
                NearToken::from_yoctonear(0),
                ACT_GAS
            )]
        );
    }
    let mut p = proposal();
    p["submission_time"] = json!(u64::MAX - WINDOW);
    callback(&mut c, &p, u64::MAX);
    p["submission_time"] = json!((u64::MAX - WINDOW).to_string());
    callback(&mut c, &p, u64::MAX);
}

#[test]
fn bet_callback_refuses_before_deadline_without_voting() {
    let mut c = contract();
    let mut future = bet();
    future["resolve_at_ns"] = json!((SUBMITTED + WINDOW + 1).to_string());
    // The challenge window passed; the independently read bet is not due.
    callback(&mut c, &proposal(), SUBMITTED + WINDOW);
    set(
        "relay.near",
        SUBMITTED + WINDOW,
        vec![PromiseResult::Successful(json(&future))],
    );
    fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
    assert_eq!(get_logs(), vec!["Bet deadline has not arrived"]);
}

#[test]
fn bet_callback_votes_for_filings_at_deadline_and_after_for_all_active_statuses() {
    let mut c = contract();
    for status in ["accepted", "proposed", "disputed"] {
        for submitted in [DEADLINE, DEADLINE + 1] {
            for now in [submitted + WINDOW, u64::MAX] {
                let mut p = proposal();
                p["submission_time"] = json!(submitted.to_string());
                callback(&mut c, &p, now);
                let args = &function_calls()[1].1;
                let carried =
                    near_sdk::serde_json::from_value::<U64>(args["submission_time"].clone())
                        .unwrap();
                assert_eq!(carried.0, submitted);
                let mut b = bet();
                b["status"] = json!(status);
                set("relay.near", now, vec![PromiseResult::Successful(json(&b))]);
                drop(c.on_bet(7, ID.into(), kind(), carried));
                assert_eq!(get_created_receipts()[0].receiver_id, account("dao.near"));
                assert_eq!(
                    function_calls(),
                    vec![(
                        "act_proposal".into(),
                        json!({"id":7,"action":"VoteApprove","proposal":proposal()["kind"]}),
                        NearToken::from_yoctonear(0),
                        ACT_GAS
                    )]
                );
            }
        }
    }
}

#[test]
fn bet_callback_refuses_missing_malformed_failed_and_oversized_results() {
    let mut c = contract();
    for (results, reason) in [
        (vec![], "Expected one escrow result"),
        (
            vec![PromiseResult::Failed],
            "Escrow read failed or result too large",
        ),
        (
            vec![PromiseResult::Successful(vec![b' '; MAX_BET_BYTES + 1])],
            "Escrow read failed or result too large",
        ),
        (
            vec![PromiseResult::Successful(b"null".to_vec())],
            "Escrow bet does not exist",
        ),
        (
            vec![PromiseResult::Successful(b"not json".to_vec())],
            "Invalid escrow bet result",
        ),
        (
            vec![
                PromiseResult::Successful(json(&bet())),
                PromiseResult::Successful(json(&bet())),
            ],
            "Expected one escrow result",
        ),
    ] {
        set("relay.near", DEADLINE, results);
        fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
        assert_eq!(get_logs(), vec![reason]);
    }
    for field in ["id", "status", "resolve_at_ns"] {
        let mut b = bet();
        b.as_object_mut().unwrap().remove(field);
        set(
            "relay.near",
            DEADLINE,
            vec![PromiseResult::Successful(json(&b))],
        );
        fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
        assert_eq!(get_logs(), vec!["Invalid escrow bet result"]);
    }
    for timestamp in [
        json!("bad"),
        json!("18446744073709551616"),
        Value::Null,
        json!(-1),
    ] {
        let mut b = bet();
        b["resolve_at_ns"] = timestamp;
        set(
            "relay.near",
            DEADLINE,
            vec![PromiseResult::Successful(json(&b))],
        );
        fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
        assert_eq!(get_logs(), vec!["Invalid escrow bet result"]);
    }
}

#[test]
fn bet_callback_refuses_wrong_id_and_inactive_statuses() {
    let mut c = contract();
    let mut b = bet();
    b["id"] = json!("a0000000-0000-4000-8000-000000000002");
    set(
        "relay.near",
        DEADLINE,
        vec![PromiseResult::Successful(json(&b))],
    );
    fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
    assert_eq!(get_logs(), vec!["Escrow bet ID mismatch"]);
    for status in [
        "offered",
        "settled",
        "cancelled",
        "expired",
        "refunded",
        "Accepted",
        "unknown",
    ] {
        let mut b = bet();
        b["status"] = json!(status);
        set(
            "relay.near",
            DEADLINE,
            vec![PromiseResult::Successful(json(&b))],
        );
        fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
        assert_eq!(get_logs(), vec!["Escrow bet is not active"]);
    }
}

#[test]
fn bet_callback_is_private() {
    let mut c = contract();
    set(
        "stranger.near",
        DEADLINE,
        vec![PromiseResult::Successful(json(&bet()))],
    );
    fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
}

#[test]
fn early_filing_is_refused_even_after_deadline() {
    let mut c = contract();
    let mut early = proposal();
    early["submission_time"] = json!((DEADLINE - 1).to_string());
    for now in [DEADLINE + WINDOW, u64::MAX] {
        callback(&mut c, &early, now);
        let args = &function_calls()[1].1;
        let submitted =
            near_sdk::serde_json::from_value::<U64>(args["submission_time"].clone()).unwrap();
        assert_eq!(submitted.0, DEADLINE - 1);
        set(
            "relay.near",
            now,
            vec![PromiseResult::Successful(json(&bet()))],
        );
        fails(|| drop(c.on_bet(7, ID.into(), kind(), submitted)));
        assert_eq!(get_logs(), vec!["Ruling filed before the bet deadline"]);
    }
}

#[test]
fn bet_callback_refuses_other_or_null_referee_without_voting() {
    let mut c = contract();
    for referee in [json!("other-dao.near"), Value::Null] {
        let mut b = bet();
        b["referee"] = referee;
        set(
            "relay.near",
            DEADLINE + WINDOW,
            vec![PromiseResult::Successful(json(&b))],
        );
        fails(|| drop(c.on_bet(7, ID.into(), kind(), U64(SUBMITTED))));
        assert_eq!(get_logs(), vec!["Escrow bet referee is not this DAO"]);
    }
}

#[test]
fn callback_rejects_early_private_failed_missing_and_oversized_results() {
    let mut c = contract();
    set(
        "relay.near",
        SUBMITTED + WINDOW - 1,
        vec![PromiseResult::Successful(json(&proposal()))],
    );
    fails(|| drop(c.on_proposal(7)));
    set(
        "stranger.near",
        u64::MAX,
        vec![PromiseResult::Successful(json(&proposal()))],
    );
    fails(|| drop(c.on_proposal(7)));
    for results in [
        vec![],
        vec![PromiseResult::Failed],
        vec![PromiseResult::Successful(vec![
            b' ';
            MAX_PROPOSAL_BYTES + 1
        ])],
        vec![PromiseResult::Successful(b"not json".to_vec())],
        vec![
            PromiseResult::Successful(json(&proposal())),
            PromiseResult::Successful(json(&proposal())),
        ],
    ] {
        set("relay.near", u64::MAX, results);
        fails(|| drop(c.on_proposal(7)));
    }
}

#[test]
fn callback_rejects_every_wrong_proposal_field() {
    let mut c = contract();
    let mutations = [
        ("/id", json!(8)),
        ("/proposer", json!("operator.near")),
        ("/status", json!("Approved")),
        ("/kind", json!("Transfer")),
        ("/kind/FunctionCall/receiver_id", json!("attacker.near")),
        ("/kind/FunctionCall/actions", json!([])),
        (
            "/kind/FunctionCall/actions",
            json!([
                proposal()["kind"]["FunctionCall"]["actions"][0],
                proposal()["kind"]["FunctionCall"]["actions"][0]
            ]),
        ),
        (
            "/kind/FunctionCall/actions/0/method_name",
            json!("transfer"),
        ),
        ("/kind/FunctionCall/actions/0/deposit", json!("1")),
        ("/kind/FunctionCall/actions/0/deposit", json!(0)),
        ("/kind/FunctionCall/actions/0/gas", json!("99999999999999")),
        ("/kind/FunctionCall/actions/0/gas", json!("100000000000001")),
        (
            "/kind/FunctionCall/actions/0/gas",
            json!(100000000000000_u64),
        ),
        ("/kind/FunctionCall/actions/0/args", json!("not base64!")),
        ("/submission_time", json!(u64::MAX.to_string())),
        ("/submission_time", json!("18446744073709551616")),
        ("/submission_time", json!("+1000")),
        ("/submission_time", json!(-1)),
        ("/submission_time", json!(1000.5)),
        ("/submission_time", Value::Null),
    ];
    for (path, value) in mutations {
        let mut p = proposal();
        *p.pointer_mut(path).unwrap() = value;
        set(
            "relay.near",
            u64::MAX,
            vec![PromiseResult::Successful(json(&p))],
        );
        fails(|| drop(c.on_proposal(7)));
    }
    for status in [
        "Rejected",
        "Removed",
        "Expired",
        "Moved",
        "Failed",
        "inprogress",
    ] {
        let mut p = proposal();
        p["status"] = json!(status);
        set(
            "relay.near",
            u64::MAX,
            vec![PromiseResult::Successful(json(&p))],
        );
        fails(|| drop(c.on_proposal(7)));
    }
}

#[test]
fn callback_rejects_extra_or_missing_kind_action_and_argument_fields() {
    let mut c = contract();
    for path in [
        "/kind",
        "/kind/FunctionCall",
        "/kind/FunctionCall/actions/0",
    ] {
        let mut p = proposal();
        p.pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), json!(true));
        set(
            "relay.near",
            u64::MAX,
            vec![PromiseResult::Successful(json(&p))],
        );
        fails(|| drop(c.on_proposal(7)));
    }
    for args in [
        json!({"id":ID.to_uppercase(),"outcome":"yes"}),
        json!({"id":"bad","outcome":"yes"}),
        json!({"id":ID,"outcome":"approve"}),
        json!({"id":ID,"outcome":"YES"}),
        json!({"id":ID,"outcome":"yes","extra":true}),
        json!({"id":ID}),
        json!({"outcome":"yes"}),
    ] {
        let mut p = proposal();
        p["kind"]["FunctionCall"]["actions"][0]["args"] =
            near_sdk::serde_json::to_value(Base64VecU8(json(&args))).unwrap();
        set(
            "relay.near",
            u64::MAX,
            vec![PromiseResult::Successful(json(&p))],
        );
        fails(|| drop(c.on_proposal(7)));
    }
    for (parent, field) in [
        ("", "id"),
        ("", "proposer"),
        ("", "status"),
        ("", "kind"),
        ("", "submission_time"),
        ("/kind/FunctionCall", "receiver_id"),
        ("/kind/FunctionCall", "actions"),
        ("/kind/FunctionCall/actions/0", "method_name"),
        ("/kind/FunctionCall/actions/0", "args"),
        ("/kind/FunctionCall/actions/0", "deposit"),
        ("/kind/FunctionCall/actions/0", "gas"),
    ] {
        let mut p = proposal();
        p.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        set(
            "relay.near",
            u64::MAX,
            vec![PromiseResult::Successful(json(&p))],
        );
        fails(|| drop(c.on_proposal(7)));
    }
}
