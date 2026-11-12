use crate::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};

const ID: &str = "a0000000-0000-4000-8000-000000000001";
const SUBMITTED: u64 = 1_000;
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
    let callback_cost = env::used_gas().as_gas() - ACT_GAS.as_gas();
    assert!(callback_cost + ACT_GAS.as_gas() <= CALLBACK_GAS.as_gas());
    // The downstream 100 Tgas is taken from act_proposal's 200 Tgas, which is
    // taken from the callback's 250 Tgas. These are nested, not additive.
    assert!(100_000_000_000_000 < ACT_GAS.as_gas());
    println!("root used {root_cost} gas; callback used {callback_cost} gas; root allocations 270 Tgas, callback allocation 200 Tgas");
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
