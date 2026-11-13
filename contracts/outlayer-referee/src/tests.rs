use crate::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use stated_jury::Verdict;
use std::collections::HashMap;

// Round 4 uses real registration callbacks so the storage payment, payer and
// refund assertions do not rely on synthetic, uncharged ruling records.
fn r4_registered(open: bool) -> (Contract, u64) {
    near_sdk::mock::with_mocked_blockchain(|blockchain| blockchain.take_storage());
    context(DUE, "registrar.testnet", EVIDENCE_DEPOSIT, None);
    let mut c = contract();
    let mut m = material();
    if open {
        m.evidence = EvidenceSpec::Open {
            window_seconds: 3600,
            max_per_side: 2,
        };
    }
    let hash = c.terms_hash(m.clone(), "c".repeat(64));
    let _ = c.register_material(m.clone(), "c".repeat(64));
    let mut b = bet(&ruling());
    b.terms_hash = hash.clone();
    context(DUE, "referee.testnet", 0, success(&Some(b)));
    assert!(c.on_register(
        encode(&m),
        hash,
        account("registrar.testnet"),
        U128(EVIDENCE_DEPOSIT)
    ));
    let registered = near_sdk::borsh::to_vec(&c.get_ruling(ID.into()).unwrap())
        .unwrap()
        .len() as u64;
    (c, registered)
}

fn r4_assert_refunded(c: &Contract, registered: u64, separately_paid: u64) -> u128 {
    let r = c.get_ruling(ID.into()).unwrap();
    let held = near_sdk::borsh::to_vec(&r).unwrap().len() as u64;
    let used = held.saturating_sub(registered + separately_paid);
    let expected = u128::from(GROWTH_RESERVE_BYTES.saturating_sub(used))
        * env::storage_byte_cost().as_yoctonear();
    assert!(expected > 0);
    assert_eq!(transfers(), vec![(account("registrar.testnet"), expected)]);
    let view = serde_json::to_value(r).unwrap();
    assert_eq!(view["registration_payer"], "registrar.testnet");
    assert_eq!(view["storage_refunded"], expected.to_string());
    assert_eq!(c.growth_reserve, 0);
    assert!(
        env::account_balance().as_yoctonear()
            >= u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
                + c.pending_registration_deposits
                + c.growth_reserve
    );
    expected
}

fn r4_fully_backed_callback(c: &Contract, now: u64, result: Option<PromiseResult>) {
    let usage = env::storage_usage();
    let balance = u128::from(usage) * env::storage_byte_cost().as_yoctonear()
        + c.growth_reserve
        + c.pending_registration_deposits;
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("referee.testnet"))
        .predecessor_account_id(account("referee.testnet"))
        .account_balance(NearToken::from_yoctonear(balance))
        .storage_usage(usage)
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        result.into_iter().collect()
    );
}

fn r4_jury_settlement(outcome: &str) {
    let (mut c, registered) = r4_registered(false);
    let rounds = if outcome == "void" { 3 } else { 1 };
    for round in 0..rounds {
        let now = DUE + (180 + round * 301) * SECOND;
        context(now, "keeper.testnet", 0, None);
        let _ = c.request_ruling(ID.into());
        let r = c.get_ruling(ID.into()).unwrap();
        context(now, "referee.testnet", 0, success(&Some(bet(&r))));
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        context(now, "referee.testnet", 0, success(&U128(1000)));
        let _ = c.on_priced(ID.into(), U64(r.nonce));
        let r = c.get_ruling(ID.into()).unwrap();
        let jury = result(
            &r,
            if outcome == "void" {
                "unclear"
            } else {
                outcome
            },
        );
        context(now, "referee.testnet", 0, success(&Some(jury)));
        let _ = c.on_ruling(ID.into(), U64(r.nonce));
    }
    let r = c.get_ruling(ID.into()).unwrap();
    assert_eq!(r.stage, Stage::Paying);
    assert_eq!(r.outcome.as_deref(), Some(outcome));
    r4_fully_backed_callback(&c, DUE + 1000 * SECOND, success(&json!(null)));
    assert!(c.on_settled(ID.into(), U64(r.nonce)));
    r4_assert_refunded(&c, registered, 0);
}

#[test]
fn r4_yes_returns_unused_storage_reserve() {
    r4_jury_settlement("yes");
}

#[test]
fn r4_no_returns_unused_storage_reserve() {
    r4_jury_settlement("no");
}

#[test]
fn r4_void_returns_unused_storage_reserve() {
    r4_jury_settlement("void");
}

#[test]
fn r4_external_terminal_returns_unused_storage_reserve_once() {
    for status in ["settled", "refunded", "cancelled", "expired"] {
        let (mut c, registered) = r4_registered(false);
        context(DUE + 180 * SECOND, "keeper.testnet", 0, None);
        let _ = c.request_ruling(ID.into());
        let r = c.get_ruling(ID.into()).unwrap();
        let mut b = bet(&r);
        b.status = status.into();
        r4_fully_backed_callback(&c, DUE + 180 * SECOND, success(&Some(b)));
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        r4_assert_refunded(&c, registered, 0);
        let once = encode(&c.get_ruling(ID.into()).unwrap());
        context(
            DUE + 181 * SECOND,
            "referee.testnet",
            0,
            success(&json!(null)),
        );
        assert!(!c.on_settled(ID.into(), U64(r.nonce)));
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        assert!(transfers().is_empty());
        assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), once);
    }
}

#[test]
fn r4_paid_evidence_does_not_consume_registration_reserve() {
    let (mut c, registered) = r4_registered(true);
    let r = c.get_ruling(ID.into()).unwrap();
    assert!(add_evidence(
        &mut c,
        "creator.testnet",
        "https://www.bls.gov/news.release/cpi.htm",
        bet(&r),
        EVIDENCE_DEPOSIT
    ));
    let paid = near_sdk::borsh::to_vec(&c.get_ruling(ID.into()).unwrap())
        .unwrap()
        .len() as u64
        - registered;
    context(DUE + 3600 * SECOND, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    let mut b = bet(&r);
    b.status = "refunded".into();
    r4_fully_backed_callback(&c, DUE + 3600 * SECOND, success(&Some(b)));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    r4_assert_refunded(&c, registered, paid);
}

#[test]
fn r4_failed_settlement_preserves_reserve_and_success_is_idempotent() {
    let (mut c, registered) = r4_registered(false);
    context(DUE + WINDOW, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(DUE + WINDOW, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    context(
        DUE + WINDOW,
        "referee.testnet",
        0,
        Some(PromiseResult::Failed),
    );
    assert!(!c.on_settled(ID.into(), U64(r.nonce)));
    assert!(transfers().is_empty());
    let failed = c.get_ruling(ID.into()).unwrap();
    let growth = near_sdk::borsh::to_vec(&failed).unwrap().len() as u64 - registered;
    assert_eq!(
        c.growth_reserve,
        u128::from(GROWTH_RESERVE_BYTES - growth) * env::storage_byte_cost().as_yoctonear()
    );
    context(DUE + WINDOW + RETRY_DELAY, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let newer = c.get_ruling(ID.into()).unwrap();
    // An older successful payout receipt can finish a newer escrow read.
    r4_fully_backed_callback(&c, DUE + WINDOW + RETRY_DELAY, success(&json!(null)));
    assert!(c.on_settled(ID.into(), U64(r.nonce)));
    r4_assert_refunded(&c, registered, 0);
    let once = encode(&c.get_ruling(ID.into()).unwrap());
    context(
        DUE + WINDOW + RETRY_DELAY,
        "referee.testnet",
        0,
        success(&json!(null)),
    );
    assert!(!c.on_settled(ID.into(), U64(newer.nonce)));
    assert!(!c.on_settled(ID.into(), U64(r.nonce)));
    assert!(transfers().is_empty());
    assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), once);
}

#[test]
fn r4_outstanding_growth_and_error_storage_are_reserved_exactly() {
    let (mut c, registered) = r4_registered(false);
    for attempt in 0..3 {
        let now = DUE + (180 + attempt * 901) * SECOND;
        context(now, "keeper.testnet", 0, None);
        let _ = c.request_ruling(ID.into());
        let r = c.get_ruling(ID.into()).unwrap();
        context(now, "referee.testnet", 0, success(&Some(bet(&r))));
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        context(now, "referee.testnet", 0, success(&U128(1000)));
        let _ = c.on_priced(ID.into(), U64(r.nonce));
        let held = near_sdk::borsh::to_vec(&c.get_ruling(ID.into()).unwrap())
            .unwrap()
            .len() as u64;
        assert_eq!(
            c.growth_reserve,
            u128::from(GROWTH_RESERVE_BYTES - (held - registered))
                * env::storage_byte_cost().as_yoctonear()
        );
    }
}

#[test]
fn r4_refund_preserves_other_rulings_and_pending_deposits() {
    let (mut c, registered) = r4_registered(false);
    let mut second = material();
    second.bet_id.push_str("-second");
    context(DUE, "second.testnet", EVIDENCE_DEPOSIT, None);
    let _ = c.register_material(second.clone(), "c".repeat(64));
    let hash = c.terms_hash(second.clone(), "c".repeat(64));
    let mut b = bet(&ruling());
    b.id = second.bet_id.clone();
    b.terms_hash = hash.clone();
    context(DUE, "referee.testnet", 0, success(&Some(b)));
    assert!(c.on_register(
        encode(&second),
        hash,
        account("second.testnet"),
        U128(EVIDENCE_DEPOSIT)
    ));
    let other_reserve = c.growth_reserve / 2;
    let mut pending = material();
    pending.bet_id.push_str("-pending");
    context(DUE, "pending.testnet", EVIDENCE_DEPOSIT, None);
    let _ = c.register_material(pending, "c".repeat(64));
    assert_eq!(c.pending_registration_deposits, EVIDENCE_DEPOSIT);
    context(DUE + 180 * SECOND, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    let mut b = bet(&r);
    b.status = "settled".into();
    r4_fully_backed_callback(&c, DUE + 180 * SECOND, success(&Some(b)));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert_eq!(c.growth_reserve, other_reserve);
    assert_eq!(c.pending_registration_deposits, EVIDENCE_DEPOSIT);
    let held = near_sdk::borsh::to_vec(&c.get_ruling(ID.into()).unwrap())
        .unwrap()
        .len() as u64;
    let expected = u128::from(GROWTH_RESERVE_BYTES - held.saturating_sub(registered))
        * env::storage_byte_cost().as_yoctonear();
    assert_eq!(transfers(), vec![(account("registrar.testnet"), expected)]);
    assert!(
        env::account_balance().as_yoctonear()
            >= u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
                + c.pending_registration_deposits
                + c.growth_reserve
    );
    assert_eq!(c.get_ruling(second.bet_id).unwrap().stage, Stage::Idle);
}

const EVIDENCE_DEPOSIT: u128 = 10u128.pow(24);

#[test]
fn r6_empty_open_voids_without_compute_and_refunds_reserve_once() {
    let (mut c, registered) = r4_registered(true);
    let now = DUE + 3600 * SECOND;
    context(now, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(now, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert_eq!(
        functions(),
        vec![
            (
                "referee_resolve".into(),
                json!({"id":ID,"outcome":"void"}),
                0
            ),
            (
                "on_settled".into(),
                json!({"bet_id":ID,"nonce":U64(r.nonce)}),
                0
            )
        ]
    );
    let paying = c.get_ruling(ID.into()).unwrap();
    assert_eq!(paying.stage, Stage::Paying);
    assert_eq!(paying.outcome.as_deref(), Some("void"));
    assert_eq!(paying.executions, 0);
    assert!(paying.outstanding.is_empty());
    assert!(transfers().is_empty());
    assert!(c.growth_reserve > 0);

    // A failed payout retains the selected Void and the prepaid reserve.
    context(now, "referee.testnet", 0, Some(PromiseResult::Failed));
    assert!(!c.on_settled(ID.into(), U64(r.nonce)));
    assert!(transfers().is_empty());
    assert!(c.growth_reserve > 0);
    context(now + RETRY_DELAY, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let retry = c.get_ruling(ID.into()).unwrap();
    context(
        now + RETRY_DELAY,
        "referee.testnet",
        0,
        success(&Some(bet(&retry))),
    );
    let _ = c.on_bet(ID.into(), U64(retry.nonce));
    assert_eq!(
        functions()[0],
        (
            "referee_resolve".into(),
            json!({"id":ID,"outcome":"void"}),
            0
        )
    );
    assert_eq!(functions().len(), 2);

    r4_fully_backed_callback(&c, now + RETRY_DELAY, success(&json!(null)));
    assert!(c.on_settled(ID.into(), U64(retry.nonce)));
    r4_assert_refunded(&c, registered, 0);
    let settled = encode(&c.get_ruling(ID.into()).unwrap());
    context(
        now + RETRY_DELAY,
        "referee.testnet",
        0,
        success(&json!(null)),
    );
    assert!(!c.on_settled(ID.into(), U64(retry.nonce)));
    let _ = c.on_bet(ID.into(), U64(retry.nonce));
    assert!(functions().is_empty());
    assert!(transfers().is_empty());
    assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), settled);
}

#[test]
fn r6_one_open_link_still_prices_and_dispatches() {
    let (mut c, _) = r4_registered(true);
    let r = c.get_ruling(ID.into()).unwrap();
    assert!(add_evidence(
        &mut c,
        "creator.testnet",
        "https://www.bls.gov/news.release/cpi.htm",
        bet(&r),
        EVIDENCE_DEPOSIT
    ));
    let now = DUE + 3600 * SECOND;
    context(now, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(now, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Pricing);
    assert_eq!(functions()[0].0, "estimate_execution_cost");
    assert!(c.get_ruling(ID.into()).unwrap().outcome.is_none());
    context(now, "referee.testnet", 0, success(&U128(1000)));
    let _ = c.on_priced(ID.into(), U64(r.nonce));
    assert_eq!(functions()[0].0, "request_execution");
    let input: ExecutionInput = decode(functions()[0].1["input_data"].as_str().unwrap());
    assert_eq!(input.submitted_evidence.len(), 1);
    assert_eq!(input.submitted_evidence[0].url, r.evidence[0].url);
}

#[test]
fn r6_non_open_modes_with_no_onchain_links_still_price() {
    for evidence in [
        material().evidence,
        EvidenceSpec::Submitted {
            items: vec![SubmittedSource {
                side: "yes".into(),
                url: "https://www.bls.gov/news.release/cpi.htm".into(),
            }],
        },
        EvidenceSpec::Auto,
    ] {
        context(DUE + 3600 * SECOND, "referee.testnet", 0, None);
        let mut c = contract();
        let mut r = ruling();
        let mut m = material();
        m.evidence = evidence;
        r.material_json = encode(&m);
        r.stage = Stage::Reading;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 3600 * SECOND,
            "referee.testnet",
            0,
            success(&Some(bet(&r))),
        );
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.stage, Stage::Pricing);
        assert!(got.outcome.is_none());
        assert_eq!(functions()[0].0, "estimate_execution_cost");
    }
}

#[test]
fn r6_empty_open_preserves_binding_selected_outcomes_and_seven_day_refund() {
    for case in ["mismatch", "yes", "no", "window"] {
        let now = if case == "window" {
            DUE + WINDOW
        } else {
            DUE + 3600 * SECOND
        };
        context(now, "referee.testnet", 0, None);
        let mut c = contract();
        let mut r = open_ruling();
        r.stage = Stage::Reading;
        if matches!(case, "yes" | "no") {
            r.outcome = Some(case.into());
        }
        c.rulings.insert(&ID.into(), &r);
        let mut b = bet(&r);
        if case == "mismatch" {
            b.terms_hash = "d".repeat(64);
        }
        context(now, "referee.testnet", 0, success(&Some(b)));
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        if case == "mismatch" {
            assert!(functions().is_empty());
            assert!(c.get_ruling(ID.into()).unwrap().outcome.is_none());
        } else if case == "window" {
            assert_eq!(
                functions()[0],
                ("refund_unresolved".into(), json!({"id":ID}), 0)
            );
            assert!(c.get_ruling(ID.into()).unwrap().outcome.is_none());
        } else {
            assert_eq!(
                functions()[0],
                ("referee_resolve".into(), json!({"id":ID,"outcome":case}), 0)
            );
            assert_eq!(
                c.get_ruling(ID.into()).unwrap().outcome.as_deref(),
                Some(case)
            );
        }
    }
}

#[test]
fn r3_failure_limit_waits_for_outstanding_winner() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let older = ruling();
    let mut r = older.clone();
    r.nonce = 2;
    r.executions = 2;
    r.failures = 7;
    r.outstanding.push(ExecutionAttempt {
        nonce: 2,
        attempt: 2,
    });
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Option::<JuryResult>::None),
    );
    let _ = c.on_ruling(ID.into(), U64(2));
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.failures, 8);
    assert!(got.outcome.is_none());
    context(got.next_ns, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    assert!(c.get_ruling(ID.into()).unwrap().outcome.is_none());
    context(
        got.next_ns + SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&older, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert_eq!(
        c.get_ruling(ID.into()).unwrap().outcome.as_deref(),
        Some("yes")
    );
}

#[test]
fn r3_attempt_binding_rejects_valid_result_for_wrong_execution() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    let mut jury = result(&r, "yes");
    jury.attempt = 2;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(jury)),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.failures, 1);
    assert!(got.outcome.is_none() && got.result_json.is_none());
    assert!(functions().is_empty());
}

#[test]
fn r3_only_dispatched_nonces_can_report() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.nonce = 2;
    r.stage = Stage::Reading;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(2));
    assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), encode(&r));
}

#[test]
#[should_panic(expected = "Retry delay remains")]
fn r3_older_unclear_enforces_fresh_retry_delay() {
    context(DUE + 120 * SECOND + TIMEOUT, "caller.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    context(
        DUE + 121 * SECOND + TIMEOUT,
        "referee.testnet",
        0,
        success(&Some(result(&r, "unclear"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    context(DUE + 122 * SECOND + TIMEOUT, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
}

#[test]
fn r3_attempt_counts_dispatches_not_requests_or_funding_failures() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Pricing;
    r.nonce = 500;
    r.outstanding.clear();
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        Some(PromiseResult::Failed),
    );
    let _ = c.on_priced(ID.into(), U64(500));
    assert_eq!(c.get_ruling(ID.into()).unwrap().executions, 1);
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 181 * SECOND,
        "referee.testnet",
        0,
        success(&U128(1000)),
    );
    let _ = c.on_priced(ID.into(), U64(500));
    let calls = functions();
    let call = calls.iter().find(|x| x.0 == "request_execution").unwrap();
    let input: Value = serde_json::from_str(call.1["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["attempt"], 2);
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.executions, 2);
    assert_eq!(got.outstanding[0].nonce, 500);
    assert_eq!(got.outstanding[0].attempt, 2);
}

#[test]
fn r3_old_failure_limit_invalidates_newer_pricing_before_void_retry() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.nonce = 2;
    r.stage = Stage::Pricing;
    r.failures = 7;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Option::<JuryResult>::None),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert_eq!(
        c.get_ruling(ID.into()).unwrap().outcome.as_deref(),
        Some("void")
    );
    context(
        DUE + 181 * SECOND,
        "referee.testnet",
        0,
        success(&U128(1000)),
    );
    let _ = c.on_priced(ID.into(), U64(2));
    assert!(functions().is_empty());
}

#[test]
fn r3_growth_reserve_covers_maximum_outstanding_and_result() {
    context(DUE, "referee.testnet", 0, None);
    let initial = ruling();
    let mut maximum = initial.clone();
    maximum.outstanding = (1..=WINDOW / TIMEOUT + 1)
        .map(|nonce| ExecutionAttempt {
            nonce,
            attempt: nonce,
        })
        .collect();
    maximum.result_json = Some("x".repeat(MAX_RESULT));
    maximum.last_error = Some("Invalid jury result binding or decision".into());
    maximum.accepted_nonce = Some(U64(u64::MAX));
    maximum.accepted_attempt = Some(U64(u64::MAX));
    maximum.outcome = Some("unclear".into());
    let growth = near_sdk::borsh::to_vec(&maximum).unwrap().len()
        - near_sdk::borsh::to_vec(&initial).unwrap().len();
    assert!(growth as u64 <= GROWTH_RESERVE_BYTES);
}

#[test]
fn r3_failed_payout_receipt_retries_winner_across_window() {
    context(DUE + WINDOW - SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + WINDOW - SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "no"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    context(
        DUE + WINDOW,
        "referee.testnet",
        0,
        Some(PromiseResult::Failed),
    );
    assert!(!c.on_settled(ID.into(), U64(1)));
    let retry = c.get_ruling(ID.into()).unwrap().next_ns;
    context(retry, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(retry, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert!(functions()
        .iter()
        .any(|x| x.0 == "referee_resolve" && x.1["outcome"] == "no"));
    assert!(!functions().iter().any(|x| x.0 == "refund_unresolved"));
    let view = serde_json::to_value(c.get_ruling(ID.into()).unwrap()).unwrap();
    assert_eq!(view["accepted_nonce"], "1");
    assert_eq!(view["accepted_attempt"], "1");
}

#[test]
fn r3_timeout_at_seven_failures_preserves_late_winner() {
    context(DUE + 120 * SECOND + TIMEOUT, "caller.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.failures = 7;
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.failures, 7, "timeout is not a completed failure");
    assert!(got.outcome.is_none());
    context(
        DUE + 121 * SECOND + TIMEOUT,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert_eq!(
        c.get_ruling(ID.into()).unwrap().outcome.as_deref(),
        Some("yes")
    );
}

#[test]
fn r3_selected_yes_no_retry_payout_after_refund_window() {
    context(DUE + WINDOW + SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for outcome in ["yes", "no"] {
        let mut r = ruling();
        r.outcome = Some(outcome.into());
        r.stage = Stage::Reading;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + WINDOW + SECOND,
            "referee.testnet",
            0,
            success(&Some(bet(&r))),
        );
        let _ = c.on_bet(ID.into(), U64(1));
        assert!(functions()
            .iter()
            .any(|x| x.0 == "referee_resolve" && x.1["outcome"] == outcome));
        assert!(!functions().iter().any(|x| x.0 == "refund_unresolved"));
    }
}

#[test]
fn r3_older_unclear_invalidates_newer_running_callback() {
    context(DUE + 120 * SECOND + TIMEOUT, "caller.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    let mut newer = c.get_ruling(ID.into()).unwrap();
    newer.stage = Stage::Running;
    newer.executions += 1;
    newer.outstanding.push(ExecutionAttempt {
        nonce: 2,
        attempt: 2,
    });
    c.rulings.insert(&ID.into(), &newer);
    context(
        DUE + 121 * SECOND + TIMEOUT,
        "referee.testnet",
        0,
        success(&Some(result(&r, "unclear"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    let after_unclear = encode(&c.get_ruling(ID.into()).unwrap());
    context(
        DUE + 122 * SECOND + TIMEOUT,
        "referee.testnet",
        0,
        success(&Some(result(&newer, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(2));
    assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), after_unclear);
}

#[test]
fn r3_accepting_older_result_preserves_request_nonce() {
    context(DUE + 120 * SECOND + TIMEOUT, "caller.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    context(
        DUE + 121 * SECOND + TIMEOUT,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert_eq!(c.get_ruling(ID.into()).unwrap().nonce, 2);
}

#[test]
fn r3_late_decisive_result_after_window_still_pays_selected_outcome() {
    context(DUE + WINDOW + SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + WINDOW + SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert!(functions()
        .iter()
        .any(|x| x.0 == "referee_resolve" && x.1["outcome"] == "yes"));
}

fn open_ruling() -> Ruling {
    let mut r = ruling();
    let mut m = material();
    m.evidence = EvidenceSpec::Open {
        window_seconds: 3600,
        max_per_side: 2,
    };
    r.material_json = encode(&m);
    r.stage = Stage::Idle;
    r
}

fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .iter()
        .flat_map(|receipt| {
            receipt.actions.iter().filter_map(|action| {
                if let near_sdk::mock::MockAction::Transfer { deposit, .. } = action {
                    Some((receipt.receiver_id.clone(), deposit.as_yoctonear()))
                } else {
                    None
                }
            })
        })
        .collect()
}

fn add_evidence(c: &mut Contract, payer: &str, url: &str, b: EscrowBet, deposit: u128) -> bool {
    context(DUE + SECOND, payer, deposit, None);
    let sequence = c.get_ruling(ID.into()).unwrap().next_evidence_id;
    let _ = c.submit_evidence(ID.into(), url.into());
    context(DUE + SECOND, "referee.testnet", 0, success(&Some(b)));
    c.on_evidence(
        ID.into(),
        url.into(),
        account(payer),
        U128(deposit),
        U64(sequence),
    )
}

#[test]
fn open_commitment_binds_window_and_limit() {
    context(DUE, "caller.testnet", 0, None);
    let c = contract();
    let m: BetMaterial = decode(&open_ruling().material_json);
    let hash = c.terms_hash(m.clone(), "c".repeat(64));
    for evidence in [
        EvidenceSpec::Open {
            window_seconds: 3601,
            max_per_side: 2,
        },
        EvidenceSpec::Open {
            window_seconds: 3600,
            max_per_side: 1,
        },
    ] {
        let mut changed = m.clone();
        changed.evidence = evidence;
        assert_ne!(c.terms_hash(changed, "c".repeat(64)), hash);
    }
}

#[test]
fn evidence_checks_escrow_and_captures_predecessor_not_signer() {
    context(DUE, "creator.testnet", EVIDENCE_DEPOSIT, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    let budget = c.get_compute_budget().0;
    let _ = c.submit_evidence(ID.into(), "https://news.example/report".into());
    assert_eq!(c.pending_registration_deposits, EVIDENCE_DEPOSIT);
    assert_eq!(c.get_compute_budget().0, budget - EVIDENCE_DEPOSIT);
    let calls = functions();
    assert!(calls
        .iter()
        .any(|(name, args, _)| name == "get_bet" && args == &json!({"id":ID})));
    let (_, args, _) = calls
        .iter()
        .find(|(name, _, _)| name == "on_evidence")
        .unwrap();
    assert_eq!(args["payer"], "creator.testnet");
    assert_eq!(args["sequence"], "0");
    assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
}

#[test]
fn evidence_assigns_escrow_side_charges_actual_storage_and_refunds_excess() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let r = open_ruling();
    let mut b = bet(&r);
    b.creator_side = Some("no".into());
    c.rulings.insert(&ID.into(), &r);
    // Both possible creator sides must invert correctly for the acceptor.
    assert!(add_evidence(
        &mut c,
        "creator.testnet",
        "https://agency.example/report",
        b.clone(),
        EVIDENCE_DEPOSIT
    ));
    let refunds = transfers();
    let refunded = refunds
        .iter()
        .find(|(who, _)| who == &account("creator.testnet"))
        .unwrap()
        .1;
    let stored = c.get_ruling(ID.into()).unwrap();
    assert_eq!(stored.evidence[0].side, "no");
    let mut empty = stored.clone();
    empty.evidence.clear();
    let growth = near_sdk::borsh::to_vec(&stored).unwrap().len()
        - near_sdk::borsh::to_vec(&empty).unwrap().len();
    assert_eq!(
        EVIDENCE_DEPOSIT - refunded,
        growth as u128 * env::storage_byte_cost().as_yoctonear()
    );
    assert_eq!(c.pending_registration_deposits, 0);
    assert!(add_evidence(
        &mut c,
        "acceptor.testnet",
        "https://agency.example/other",
        b,
        EVIDENCE_DEPOSIT
    ));
    assert_eq!(c.get_ruling(ID.into()).unwrap().evidence[1].side, "yes");
}

#[test]
fn evidence_storage_shortfall_rolls_back_and_returns_all() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let r = open_ruling();
    c.rulings.insert(&ID.into(), &r);
    assert!(!add_evidence(
        &mut c,
        "creator.testnet",
        "https://agency.example/report",
        bet(&r),
        1
    ));
    assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
    assert_eq!(transfers(), vec![(account("creator.testnet"), 1)]);
    assert_eq!(c.pending_registration_deposits, 0);
}

#[test]
fn evidence_requires_bettor_and_complete_matching_active_escrow_bet() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let r = open_ruling();
    c.rulings.insert(&ID.into(), &r);
    let good = bet(&r);
    let mut cases = vec![("attacker.testnet", good.clone())];
    for field in [
        "id",
        "hash",
        "deadline",
        "referee",
        "creator",
        "acceptor",
        "same_accounts",
        "side",
        "missing_side",
        "offered",
        "settled",
        "refunded",
        "cancelled",
        "expired",
    ] {
        let mut bad = good.clone();
        match field {
            "id" => bad.id.push('x'),
            "hash" => bad.terms_hash = "d".repeat(64),
            "deadline" => bad.resolve_at_ns = U64(DUE + 1),
            "referee" => bad.referee = Some(account("attacker.testnet")),
            "creator" => bad.creator = None,
            "acceptor" => bad.acceptor = None,
            "same_accounts" => bad.acceptor = bad.creator.clone(),
            "side" => bad.creator_side = Some("maybe".into()),
            "missing_side" => bad.creator_side = None,
            status => bad.status = status.into(),
        }
        cases.push(("creator.testnet", bad));
    }
    for (payer, b) in cases {
        assert!(!add_evidence(
            &mut c,
            payer,
            "https://news.example/report",
            b,
            EVIDENCE_DEPOSIT
        ));
        assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
        assert_eq!(transfers(), vec![(account(payer), EVIDENCE_DEPOSIT)]);
        assert_eq!(c.pending_registration_deposits, 0);
    }
    for status in ["proposed", "disputed"] {
        let mut b = good.clone();
        b.status = status.into();
        assert!(add_evidence(
            &mut c,
            "creator.testnet",
            "https://news.example/report",
            b,
            EVIDENCE_DEPOSIT
        ));
    }
}

#[test]
fn evidence_callback_read_failure_returns_deposit() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    for response in [
        Some(PromiseResult::Failed),
        success(&Option::<EscrowBet>::None),
        Some(PromiseResult::Successful(b"bad".to_vec())),
    ] {
        context(DUE, "creator.testnet", EVIDENCE_DEPOSIT, None);
        let sequence = c.get_ruling(ID.into()).unwrap().next_evidence_id;
        let _ = c.submit_evidence(ID.into(), "https://news.example/report".into());
        context(DUE, "referee.testnet", 0, response);
        assert!(!c.on_evidence(
            ID.into(),
            "https://news.example/report".into(),
            account("creator.testnet"),
            U128(EVIDENCE_DEPOSIT),
            U64(sequence)
        ));
        assert_eq!(
            transfers(),
            vec![(account("creator.testnet"), EVIDENCE_DEPOSIT)]
        );
        assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
    }
}

#[test]
fn evidence_callback_rechecks_closing_boundary_and_ruling_stage() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let mut r = open_ruling();
    r.next_evidence_id = 1;
    for (time, stage, outcome) in [
        (DUE + 3600 * SECOND, Stage::Idle, None),
        (DUE - 1, Stage::Idle, None),
        (DUE, Stage::Reading, None),
        (DUE, Stage::Running, None),
        (DUE, Stage::Settled, None),
        (DUE, Stage::Idle, Some("void".into())),
    ] {
        r.stage = stage;
        r.outcome = outcome;
        c.rulings.insert(&ID.into(), &r);
        c.pending_registration_deposits = EVIDENCE_DEPOSIT;
        context(time, "referee.testnet", 0, success(&Some(bet(&r))));
        assert!(!c.on_evidence(
            ID.into(),
            "https://news.example/report".into(),
            account("creator.testnet"),
            U128(EVIDENCE_DEPOSIT),
            U64(0)
        ));
        assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
        assert_eq!(
            transfers(),
            vec![(account("creator.testnet"), EVIDENCE_DEPOSIT)]
        );
    }
}

#[test]
fn evidence_cap_is_per_side_and_callbacks_preserve_invocation_order() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let r = open_ruling();
    let b = bet(&r);
    c.rulings.insert(&ID.into(), &r);
    for index in 0..3 {
        context(DUE, "creator.testnet", EVIDENCE_DEPOSIT, None);
        let _ = c.submit_evidence(ID.into(), format!("https://news.example/{index}"));
    }
    for index in [1, 0, 2] {
        context(DUE, "referee.testnet", 0, success(&Some(b.clone())));
        assert_eq!(
            c.on_evidence(
                ID.into(),
                format!("https://news.example/{index}"),
                account("creator.testnet"),
                U128(EVIDENCE_DEPOSIT),
                U64(index)
            ),
            index != 2
        );
    }
    assert_eq!(
        c.get_ruling(ID.into())
            .unwrap()
            .evidence
            .iter()
            .map(|e| e.sequence)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert!(add_evidence(
        &mut c,
        "acceptor.testnet",
        "https://agency.example/one",
        b.clone(),
        EVIDENCE_DEPOSIT
    ));
    assert!(add_evidence(
        &mut c,
        "acceptor.testnet",
        "https://agency.example/two",
        b.clone(),
        EVIDENCE_DEPOSIT
    ));
    assert!(!add_evidence(
        &mut c,
        "acceptor.testnet",
        "https://agency.example/three",
        b,
        EVIDENCE_DEPOSIT
    ));
    assert_eq!(c.get_ruling(ID.into()).unwrap().evidence.len(), 4);
    assert_eq!(c.pending_registration_deposits, 0);
}

#[test]
fn open_ruling_waits_until_close_and_forwards_committed_material_and_ordered_urls() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let r = open_ruling();
    c.rulings.insert(&ID.into(), &r);
    assert!(add_evidence(
        &mut c,
        "creator.testnet",
        "https://agency.example/report",
        bet(&r),
        EVIDENCE_DEPOSIT
    ));
    assert!(add_evidence(
        &mut c,
        "acceptor.testnet",
        "https://news.example/report",
        bet(&r),
        EVIDENCE_DEPOSIT
    ));
    context(DUE + 3600 * SECOND, "keeper.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(
        DUE + 3600 * SECOND,
        "referee.testnet",
        0,
        success(&Some(bet(&r))),
    );
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    let estimate = functions()
        .into_iter()
        .find(|(method, _, _)| method == "estimate_execution_cost")
        .unwrap();
    context(
        DUE + 3600 * SECOND,
        "referee.testnet",
        0,
        success(&U128(10u128.pow(22))),
    );
    let _ = c.on_priced(ID.into(), U64(r.nonce));
    let call = functions()
        .into_iter()
        .find(|(method, _, _)| method == "request_execution")
        .unwrap();
    let input: ExecutionInput = decode(call.1["input_data"].as_str().unwrap());
    assert_eq!(input.material, decode::<BetMaterial>(&r.material_json));
    assert_eq!(input.terms_hash, r.terms_hash);
    assert_eq!(
        input.submitted_evidence,
        vec![
            SubmittedSource {
                side: "yes".into(),
                url: "https://agency.example/report".into()
            },
            SubmittedSource {
                side: "no".into(),
                url: "https://news.example/report".into()
            }
        ]
    );
    assert_eq!(estimate.1["input_len"], encode(&input).len());
    assert_eq!(call.1["resource_limits"]["max_execution_seconds"], 180);
}

#[test]
#[should_panic(expected = "Wait for closed candles or evidence window")]
fn open_ruling_rejects_before_window_close() {
    context(DUE + 3600 * SECOND - 1, "caller.testnet", 0, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    let _ = c.request_ruling(ID.into());
}

#[test]
#[should_panic(expected = "Evidence is closed")]
fn evidence_public_method_rejects_late_submission() {
    context(
        DUE + 3600 * SECOND,
        "creator.testnet",
        EVIDENCE_DEPOSIT,
        None,
    );
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    let _ = c.submit_evidence(ID.into(), "https://news.example/report".into());
}

#[test]
#[should_panic(expected = "Evidence is closed")]
fn evidence_public_method_rejects_before_deadline() {
    context(DUE - 1, "creator.testnet", EVIDENCE_DEPOSIT, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    let _ = c.submit_evidence(ID.into(), "https://news.example/report".into());
}

#[test]
#[should_panic(expected = "Evidence is closed")]
fn evidence_public_method_rejects_precommitted_only_bets() {
    context(DUE, "creator.testnet", EVIDENCE_DEPOSIT, None);
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Idle;
    c.rulings.insert(&ID.into(), &r);
    let _ = c.submit_evidence(ID.into(), "https://news.example/report".into());
}

#[test]
#[should_panic(expected = "Private callback")]
fn evidence_callback_cannot_be_forged() {
    context(DUE, "creator.testnet", 0, None);
    let _ = contract().on_evidence(
        ID.into(),
        "https://news.example/report".into(),
        account("creator.testnet"),
        U128(0),
        U64(0),
    );
}

#[test]
fn evidence_callback_rejects_invalid_url_or_sequence_without_storage_growth() {
    context(DUE, "caller.testnet", 0, None);
    let mut c = contract();
    let mut r = open_ruling();
    r.next_evidence_id = 1;
    c.rulings.insert(&ID.into(), &r);
    for (url, sequence) in [
        ("https://x.com/post", 0),
        ("http://news.example/report", 0),
        ("https://127.0.0.1/report", 0),
        ("https://news.example/report", 1),
    ] {
        context(DUE, "referee.testnet", 0, success(&Some(bet(&r))));
        c.pending_registration_deposits = EVIDENCE_DEPOSIT;
        assert!(!c.on_evidence(
            ID.into(),
            url.into(),
            account("creator.testnet"),
            U128(EVIDENCE_DEPOSIT),
            U64(sequence)
        ));
        assert!(c.get_ruling(ID.into()).unwrap().evidence.is_empty());
        assert_eq!(
            transfers(),
            vec![(account("creator.testnet"), EVIDENCE_DEPOSIT)]
        );
    }
    assert!(add_evidence(
        &mut c,
        "creator.testnet",
        "https://news.example/report",
        bet(&r),
        EVIDENCE_DEPOSIT
    ));
    context(DUE, "referee.testnet", 0, success(&Some(bet(&r))));
    c.pending_registration_deposits = EVIDENCE_DEPOSIT;
    assert!(!c.on_evidence(
        ID.into(),
        "https://news.example/duplicate".into(),
        account("creator.testnet"),
        U128(EVIDENCE_DEPOSIT),
        U64(1)
    ));
    assert_eq!(c.get_ruling(ID.into()).unwrap().evidence.len(), 1);
}

#[test]
#[should_panic]
fn evidence_public_method_rejects_x_before_reading_escrow() {
    context(DUE, "creator.testnet", EVIDENCE_DEPOSIT, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &open_ruling());
    let _ = c.submit_evidence(ID.into(), "https://TWITTER.com./post".into());
}

// Claim and ID from README.md's recorded Coinbase bet. Tests change the referee
// and use the new commitment format; they do not represent that bet's deployment.
const ID: &str = "3668aa04-7009-4b85-b19d-debfabebbf96";
const DUE: u64 = 1_794_510_900_000_000_000; // 2026-11-12T19:15:00.000Z

fn account(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(now: u64, caller: &str, deposit: u128, result: Option<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("referee.testnet"))
        .predecessor_account_id(account(caller))
        .signer_account_id(account("caller.testnet"))
        .account_balance(NearToken::from_near(100))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        result.into_iter().collect()
    );
}
fn success<T: Serialize>(v: &T) -> Option<PromiseResult> {
    Some(PromiseResult::Successful(encode(v).into_bytes()))
}
fn material() -> BetMaterial {
    serde_json::from_value(json!({"bet_id":ID,"claim":"NEAR above US$3.30 on Coinbase",
        "made_at":"2026-11-12T18:00:00.000Z","deadline":"2026-11-12T19:15:00.000Z",
        "post_url":"https://x.com/ChainAbstracted/status/2120000000000000000",
        "evidence":{"kind":"coinbase","product":"NEAR-USD","window":{"kind":"moment","at":"2026-11-12T19:15:00.000Z"}}})).unwrap()
}
fn contract() -> Contract {
    Contract::new(
        account("escrow.testnet"),
        account("outlayer.testnet"),
        "https://example.org/jury.wasm".into(),
        "a".repeat(64),
        account("sponsor.testnet"),
        "jury".into(),
    )
}
fn ruling() -> Ruling {
    Ruling {
        registration_payer: account("caller.testnet"),
        storage_refunded: U128(0),
        paid_storage_bytes: 0,
        reserve_prepaid: 0,
        reserve_remaining: 0,
        material_json: encode(&material()),
        terms_hash: "b".repeat(64),
        deadline_ns: timestamp_ns(&material().deadline),
        nonce: 1,
        executions: 1,
        outstanding: vec![ExecutionAttempt {
            nonce: 1,
            attempt: 1,
        }],
        accepted_nonce: None,
        accepted_attempt: None,
        undecided: 0,
        failures: 0,
        admission_failures: 0,
        stage: Stage::Running,
        started_ns: DUE + 120 * SECOND,
        next_ns: 0,
        outcome: None,
        last_error: None,
        evidence: Vec::new(),
        next_evidence_id: 0,
        result_json: None,
    }
}
fn bet(r: &Ruling) -> EscrowBet {
    EscrowBet {
        id: ID.into(),
        terms_hash: r.terms_hash.clone(),
        resolve_at_ns: U64(r.deadline_ns),
        status: "accepted".into(),
        referee: Some(account("referee.testnet")),
        creator: Some(account("creator.testnet")),
        acceptor: Some(account("acceptor.testnet")),
        creator_side: Some("yes".into()),
    }
}
fn result(r: &Ruling, outcome: &str) -> JuryResult {
    JuryResult {
        attempt: r.executions,
        bet_id: ID.into(),
        terms_hash: r.terms_hash.clone(),
        outcome: outcome.into(),
        verdicts: stated_jury::MODELS
            .iter()
            .map(|m| Verdict {
                model: (*m).into(),
                outcome: outcome.into(),
                confidence: 0.8,
            })
            .collect(),
        evidence_summary: json!({"priceAtMoment":3.4206}),
        material_hash: material_hash(&execution_input(r, r.started_ns)).unwrap(),
    }
}
fn functions() -> Vec<(String, Value, u128)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| &r.actions)
        .filter_map(|a| {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } = a
            {
                Some((
                    String::from_utf8(method_name.clone()).unwrap(),
                    serde_json::from_slice(args).unwrap(),
                    attached_deposit.as_yoctonear(),
                ))
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn deadline_fixture_matches_iso() {
    context(DUE, "caller.testnet", 0, None);
    assert_eq!(ruling().deadline_ns, DUE);
}

#[test]
fn committed_material_cannot_change_claim_or_plan() {
    context(DUE, "caller.testnet", 0, None);
    let c = contract();
    let m = material();
    let salt = "c".repeat(64);
    let hash = c.terms_hash(m.clone(), salt.clone());
    let mut other = m.clone();
    other.claim.push('?');
    assert_ne!(hash, c.terms_hash(other, salt.clone()));
    let mut other = m;
    other.post_url.push('x');
    assert_ne!(hash, c.terms_hash(other, salt));
}

#[test]
fn validated_result_is_public_and_uses_its_prepaid_storage_reserve() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    let reserve = u128::from(GROWTH_RESERVE_BYTES) * env::storage_byte_cost().as_yoctonear();
    r.reserve_prepaid = reserve;
    r.reserve_remaining = reserve;
    r.paid_storage_bytes = near_sdk::borsh::to_vec(&r).unwrap().len() as u64;
    c.rulings.insert(&ID.into(), &r);
    c.growth_reserve = reserve;
    let jury = result(&r, "yes");
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(jury.clone())),
    );
    let _ = c.on_ruling(ID.into(), U64(r.nonce));
    let got = c.get_ruling(ID.into()).unwrap();
    let stored_bytes = near_sdk::borsh::to_vec(&got).unwrap().len() as u64 - r.paid_storage_bytes;
    let view = serde_json::to_value(got).unwrap();
    assert_eq!(view["result"], serde_json::to_value(jury).unwrap());
    assert_eq!(view["result"]["verdicts"].as_array().unwrap().len(), 3);
    assert_eq!(
        c.growth_reserve,
        reserve - stored_bytes as u128 * env::storage_byte_cost().as_yoctonear()
    );
    assert!(view.get("result_json").is_none());
}

#[test]
fn print_terms_hash_vectors() {
    context(DUE, "caller.testnet", 0, None);
    let c = contract();
    assert_eq!(
        c.terms_hash(material(), "c".repeat(64)),
        "4d67c9dbbc1a90a9130942b5e90c4bc5050283f01a47357833f28e1bc7567e24"
    );
    let mut examples = vec![material()];
    let mut auto = material();
    auto.claim = "Will the announcement say \"ready\"? café 🚀".into();
    auto.evidence = EvidenceSpec::Auto;
    examples.push(auto);
    let mut submitted = material();
    submitted.evidence = EvidenceSpec::Submitted {
        items: vec![stated_jury::SubmittedSource {
            side: "yes".into(),
            url: "https://www.sec.gov/newsroom".into(),
        }],
    };
    examples.push(submitted);
    for m in examples {
        let salt = "c".repeat(64);
        println!(
            "TERMS_VECTOR:{}",
            encode(&json!({
                "material": m, "salt": salt,
                "hash": c.terms_hash(m.clone(), salt.clone())
            }))
        );
    }
}

#[test]
fn registration_requires_chain_commitment_and_referee() {
    context(DUE, "referee.testnet", 0, None);
    let mut c = contract();
    let m = material();
    let hash = c.terms_hash(m.clone(), "c".repeat(64));
    let mut b = bet(&ruling());
    b.terms_hash = hash.clone();
    for wrong in [true, false] {
        let mut tampered = b.clone();
        if wrong {
            tampered.terms_hash = "d".repeat(64);
        } else {
            tampered.referee = None;
        }
        context(DUE, "referee.testnet", 0, success(&Some(tampered)));
        c.pending_registration_deposits = 10u128.pow(24);
        assert!(!c.on_register(
            encode(&m),
            hash.clone(),
            account("caller.testnet"),
            U128(10u128.pow(24))
        ));
        assert!(c.get_ruling(ID.into()).is_none());
    }
    context(DUE, "referee.testnet", 0, success(&Some(b)));
    c.pending_registration_deposits = 10u128.pow(24);
    assert!(c.on_register(
        encode(&m),
        hash,
        account("caller.testnet"),
        U128(10u128.pow(24))
    ));
}

#[test]
#[should_panic(expected = "Resolution time has not arrived")]
fn early_request_rejected() {
    context(DUE - 1, "caller.testnet", 0, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &ruling());
    let _ = c.request_ruling(ID.into());
}

#[test]
#[should_panic(expected = "Private callback")]
fn forged_public_callback_rejected() {
    context(DUE, "attacker.testnet", 0, None);
    let _ = contract().on_ruling(ID.into(), U64(1));
}

#[test]
fn chain_binding_checks_every_field() {
    context(DUE, "referee.testnet", 0, None);
    let c = contract();
    let r = ruling();
    let good = bet(&r);
    assert!(c.bet_matches(&good, ID, &r.terms_hash, DUE, true));
    let mut variants = Vec::new();
    let mut b = good.clone();
    b.id.push('x');
    variants.push(b);
    let mut b = good.clone();
    b.terms_hash = "d".repeat(64);
    variants.push(b);
    let mut b = good.clone();
    b.referee = Some(account("attacker.testnet"));
    variants.push(b);
    let mut b = good.clone();
    b.resolve_at_ns = U64(DUE + 1);
    variants.push(b);
    let mut b = good;
    b.status = "offered".into();
    variants.push(b);
    for b in variants {
        assert!(!c.bet_matches(&b, ID, &r.terms_hash, DUE, true));
    }
    context(DUE - 1, "referee.testnet", 0, None);
    assert!(!c.bet_matches(&bet(&r), ID, &r.terms_hash, DUE, true));
}

#[test]
fn mock_outlayer_round_trip_builds_current_abi_and_pays() {
    context(DUE + 120 * SECOND, "caller.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Idle;
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(
        DUE + 120 * SECOND,
        "referee.testnet",
        0,
        success(&Some(bet(&r))),
    );
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert!(functions().iter().any(|x| x.0 == "estimate_execution_cost"));
    context(
        DUE + 120 * SECOND,
        "referee.testnet",
        0,
        success(&U128(10u128.pow(22))),
    );
    let _ = c.on_priced(ID.into(), U64(r.nonce));
    let calls = functions();
    let call = calls.iter().find(|x| x.0 == "request_execution").unwrap();
    assert_eq!(call.1["source"]["WasmUrl"]["hash"], "a".repeat(64));
    assert_eq!(call.1["response_format"], "Json");
    assert_eq!(call.1["secrets_ref"]["account_id"], "sponsor.testnet");
    assert_eq!(call.2, 10u128.pow(22));
    assert_eq!(call.1["payer_account_id"], "referee.testnet");
    let input: ExecutionInput =
        serde_json::from_str(call.1["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input.material, material());
    let r = c.get_ruling(ID.into()).unwrap();
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(r.nonce));
    let calls = functions();
    assert!(calls
        .iter()
        .any(|x| x.0 == "referee_resolve" && x.1 == json!({"id":ID,"outcome":"yes"})));
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        Some(PromiseResult::Successful(vec![])),
    );
    assert!(c.on_settled(ID.into(), U64(r.nonce)));
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Settled);
}

#[test]
fn result_binding_and_decision_tampering_fails_without_using_jury_retry() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    let good = result(&r, "yes");
    let mut bads = Vec::new();
    let mut v = good.clone();
    v.bet_id.push('x');
    bads.push(v);
    let mut v = good.clone();
    v.terms_hash = "d".repeat(64);
    bads.push(v);
    let mut v = good.clone();
    v.material_hash = "d".repeat(64);
    bads.push(v);
    let mut v = good.clone();
    v.verdicts[0].model = "other".into();
    bads.push(v);
    let mut v = good.clone();
    v.verdicts[0].confidence = 0.79;
    bads.push(v);
    let mut v = good.clone();
    v.verdicts[1].outcome = "no".into();
    bads.push(v);
    let mut v = good;
    v.outcome = "void".into();
    bads.push(v);
    for v in bads {
        c.rulings.insert(&ID.into(), &r);
        context(DUE + 180 * SECOND, "referee.testnet", 0, success(&Some(v)));
        let _ = c.on_ruling(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.failures, 1);
        assert_eq!(got.undecided, 0);
        assert!(!functions().iter().any(|x| x.0 == "referee_resolve"));
    }
}

#[test]
fn stale_result_cannot_settle() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "yes"))),
    );
    let _ = c.on_ruling(ID.into(), U64(0));
    assert!(functions().is_empty());
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Running);
}

#[test]
fn third_undecided_voids_but_failure_does_not_count_as_undecided() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    for count in 0..3 {
        r.undecided = count;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            success(&Some(result(&r, "unclear"))),
        );
        let _ = c.on_ruling(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.undecided, count + 1);
        assert_eq!(got.failures, 0);
        if count == 2 {
            assert_eq!(got.outcome.as_deref(), Some("void"));
            assert!(functions().iter().any(|x| x.1["outcome"] == "void"));
        } else {
            assert_eq!(got.stage, Stage::Idle);
            assert!(functions().is_empty());
        }
    }
}

#[test]
fn eighth_failure_selects_void_and_next_request_rechecks_escrow() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.failures = 7;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Option::<JuryResult>::None),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    let r = c.get_ruling(ID.into()).unwrap();
    assert_eq!(r.outcome.as_deref(), Some("void"));
    context(r.next_ns, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(r.started_ns, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert!(functions()
        .iter()
        .any(|x| x.0 == "referee_resolve" && x.1["outcome"] == "void"));
}

#[test]
fn timeout_preserves_outstanding_and_seven_days_routes_to_refund() {
    context(DUE + 1020 * SECOND, "caller.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.nonce, 2);
    assert_eq!(got.failures, 0);
    assert_eq!(got.outstanding.len(), 1);
    let mut r = got;
    r.stage = Stage::Idle;
    c.rulings.insert(&ID.into(), &r);
    context(DUE + WINDOW, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(DUE + WINDOW, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert!(functions().iter().any(|x| x.0 == "refund_unresolved"));
    assert!(!functions().iter().any(|x| x.0 == "request_execution"));
}

#[test]
fn failed_payment_keeps_outcome_for_retry() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.outcome = Some("no".into());
    r.stage = Stage::Paying;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        Some(PromiseResult::Failed),
    );
    assert!(!c.on_settled(ID.into(), U64(1)));
    let r = c.get_ruling(ID.into()).unwrap();
    assert_eq!(r.outcome.as_deref(), Some("no"));
    assert_eq!(r.stage, Stage::Idle);
}

#[test]
fn underfunding_and_price_lookup_failure_cannot_force_void() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for response in [success(&U128(100)), Some(PromiseResult::Failed)] {
        let mut r = ruling();
        r.stage = Stage::Pricing;
        c.pending_registration_deposits = NearToken::from_near(100).as_yoctonear();
        c.rulings.insert(&ID.into(), &r);
        context(DUE + 180 * SECOND, "referee.testnet", 0, response);
        let _ = c.on_priced(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.failures, 0);
        assert_eq!(got.undecided, 0);
        assert_eq!(got.stage, Stage::Idle);
        assert!(!functions().iter().any(|x| x.0 == "request_execution"));
    }
}

#[test]
#[should_panic(expected = "Wait for closed candles")]
fn an_unclosed_candle_cannot_consume_failures() {
    context(DUE + 60 * SECOND, "caller.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Idle;
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
}

#[test]
#[should_panic(expected = "Use fund_compute for donations")]
fn request_never_accepts_a_callers_compute_deposit() {
    context(DUE + 180 * SECOND, "caller.testnet", 1, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &ruling());
    let _ = c.request_ruling(ID.into());
}

#[test]
fn two_priced_requests_cannot_spend_the_same_pool_balance() {
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&U128(20_000_000_000_000_000_000_000)),
    );
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Pricing;
    c.rulings.insert(&ID.into(), &r);
    let second_id = format!("{ID}-second");
    let mut other = r.clone();
    let mut m: BetMaterial = decode(&other.material_json);
    m.bet_id = second_id.clone();
    other.material_json = encode(&m);
    c.rulings.insert(&second_id, &other);
    // Only 0.03 NEAR is spendable; each request quotes 0.02 NEAR.
    c.growth_reserve = c.get_compute_budget().0 - 30_000_000_000_000_000_000_000;
    let _ = c.on_priced(ID.into(), U64(1));
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Running);
    let _ = c.on_priced(second_id.clone(), U64(1));
    assert_eq!(c.get_ruling(second_id).unwrap().stage, Stage::Idle);
    assert_eq!(
        functions()
            .iter()
            .filter(|x| x.0 == "request_execution")
            .count(),
        1
    );
}

#[test]
fn quote_cap_and_growth_reserve_cannot_be_spent() {
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&U128(MAX_COMPUTE_DEPOSIT + 1)),
    );
    let mut c = contract();
    let mut r = ruling();
    r.stage = Stage::Pricing;
    c.rulings.insert(&ID.into(), &r);
    let _ = c.on_priced(ID.into(), U64(1));
    assert_eq!(c.get_ruling(ID.into()).unwrap().failures, 0);
    c.rulings.insert(&ID.into(), &r);
    c.growth_reserve = NearToken::from_near(100).as_yoctonear();
    context(DUE + 180 * SECOND, "referee.testnet", 0, success(&U128(1)));
    let _ = c.on_priced(ID.into(), U64(1));
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Idle);
    assert!(!functions().iter().any(|x| x.0 == "request_execution"));
}

#[test]
fn failed_execution_has_no_caller_refund_claim_on_another_bets_funds() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let r = ruling();
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Option::<JuryResult>::None),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    assert!(get_created_receipts()
        .iter()
        .flat_map(|r| &r.actions)
        .all(|a| !matches!(a, near_sdk::mock::MockAction::Transfer { .. })));
    assert_eq!(c.get_ruling(ID.into()).unwrap().failures, 1);
}

#[test]
#[should_panic(expected = "Ruling in flight")]
fn regression_timeout_waits_900_seconds() {
    let r = ruling();
    context(r.started_ns + 899 * SECOND, "caller.testnet", 0, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
}

#[test]
fn regression_older_valid_result_wins_and_invalidates_newer_attempt() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for stage in [Stage::Reading, Stage::Pricing, Stage::Running, Stage::Idle] {
        for outcome in ["yes", "no"] {
            let original = ruling();
            let jury = result(&original, outcome);
            let mut newer = original;
            newer.nonce = 2;
            newer.stage = stage.clone();
            newer.started_ns += 900 * SECOND;
            c.rulings.insert(&ID.into(), &newer);
            context(
                newer.started_ns,
                "referee.testnet",
                0,
                success(&Some(jury.clone())),
            );
            let _ = c.on_ruling(ID.into(), U64(1));
            let selected = c.get_ruling(ID.into()).unwrap();
            assert_eq!(selected.outcome.as_deref(), Some(outcome));
            assert_eq!(selected.stage, Stage::Paying);
            assert_eq!(selected.nonce, 2);
            assert_eq!(selected.accepted_nonce, Some(U64(1)));
            assert_eq!(selected.accepted_attempt, Some(U64(1)));
            assert!(selected.outstanding.is_empty());
            assert_eq!(
                selected.result_json.as_deref(),
                Some(encode(&jury).as_str())
            );
            assert!(functions()
                .iter()
                .any(|(name, args, _)| name == "on_settled" && args["nonce"] == "2"));
            let before = encode(&selected);
            context(
                newer.started_ns,
                "referee.testnet",
                0,
                success(&Some(result(&newer, "no"))),
            );
            let _ = c.on_ruling(ID.into(), U64(2));
            assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), before);
            assert!(functions().is_empty());
        }
    }
}

#[test]
fn regression_older_failures_count_once_without_interrupting_newer_attempt() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.nonce = 2;
    let mut bad = result(&r, "yes");
    bad.material_hash = "d".repeat(64);
    let mut roster = result(&r, "yes");
    roster.verdicts[0].model = "wrong".into();
    for response in [
        Some(PromiseResult::Failed),
        success(&Option::<JuryResult>::None),
        Some(PromiseResult::Successful(b"bad".to_vec())),
        success(&Some(bad)),
        success(&Some(roster)),
    ] {
        c.rulings.insert(&ID.into(), &r);
        let reserve = c.growth_reserve;
        context(DUE + 180 * SECOND, "referee.testnet", 0, response);
        let _ = c.on_ruling(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.failures + got.admission_failures, 1);
        assert!(got.outstanding.is_empty());
        assert_eq!(got.stage, Stage::Running);
        assert_eq!(got.nonce, 2);
        assert_eq!(got.next_ns, r.next_ns);
        let once = encode(&got);
        let _ = c.on_ruling(ID.into(), U64(1));
        assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), once);
        assert_eq!(c.growth_reserve, reserve);
        assert!(functions().is_empty());
    }
}

#[test]
fn regression_older_unclear_uses_normal_allowance_and_invalidates_newer_read() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for count in 0..3 {
        let mut r = ruling();
        r.nonce = 2;
        r.stage = Stage::Reading;
        r.undecided = count;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            success(&Some(result(&r, "unclear"))),
        );
        let _ = c.on_ruling(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(got.nonce, 2);
        assert_eq!(got.undecided, count + 1);
        assert_eq!(
            got.stage,
            if count == 2 {
                Stage::Paying
            } else {
                Stage::Idle
            }
        );
        if count < 2 {
            assert_eq!(got.next_ns, DUE + 480 * SECOND);
        }
        let before = encode(&got);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            success(&Some(bet(&got))),
        );
        let _ = c.on_bet(ID.into(), U64(2));
        assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), before);
        assert!(functions().is_empty());
    }
}

#[test]
fn regression_selected_outcome_and_terminal_stages_reject_older_results() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for (stage, outcome) in [
        (Stage::Idle, Some("no".into())),
        (Stage::Paying, None),
        (Stage::Settled, None),
    ] {
        let mut r = ruling();
        r.nonce = 2;
        r.stage = stage;
        r.outcome = outcome;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            success(&Some(result(&r, "yes"))),
        );
        let _ = c.on_ruling(ID.into(), U64(1));
        assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), encode(&r));
        assert!(functions().is_empty());
    }
}

#[test]
fn regression_older_settlement_success_is_terminal_and_failure_is_ignored() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    for stage in [Stage::Reading, Stage::Paying, Stage::Idle] {
        let mut r = ruling();
        r.nonce = 2;
        r.outcome = Some("yes".into());
        r.stage = stage;
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            Some(PromiseResult::Failed),
        );
        assert!(!c.on_settled(ID.into(), U64(1)));
        assert_eq!(encode(&c.get_ruling(ID.into()).unwrap()), encode(&r));
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            Some(PromiseResult::Successful(vec![])),
        );
        assert!(c.on_settled(ID.into(), U64(1)));
        let settled = c.get_ruling(ID.into()).unwrap();
        assert_eq!(settled.stage, Stage::Settled);
        assert_eq!(settled.outcome.as_deref(), Some("yes"));
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            Some(PromiseResult::Failed),
        );
        assert!(!c.on_settled(ID.into(), U64(2)));
        assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Settled);
    }
}

#[test]
fn regression_paying_relaunch_recognizes_first_settlement_without_second_call() {
    let mut r = ruling();
    r.stage = Stage::Paying;
    r.outcome = Some("yes".into());
    context(r.started_ns + 900 * SECOND, "caller.testnet", 0, None);
    let mut c = contract();
    c.rulings.insert(&ID.into(), &r);
    let _ = c.request_ruling(ID.into());
    assert!(functions().iter().any(|(name, _, _)| name == "get_bet"));
    let newer = c.get_ruling(ID.into()).unwrap();
    let mut b = bet(&newer);
    b.status = "settled".into();
    context(newer.started_ns, "referee.testnet", 0, success(&Some(b)));
    let _ = c.on_bet(ID.into(), U64(newer.nonce));
    assert_eq!(c.get_ruling(ID.into()).unwrap().stage, Stage::Settled);
    assert!(functions().is_empty());
}

#[test]
fn regression_admission_reverts_void_only_on_twenty_fourth_failure() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    for count in 1..=24 {
        r.stage = Stage::Running;
        r.outstanding = vec![ExecutionAttempt {
            nonce: r.nonce,
            attempt: r.executions,
        }];
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            Some(PromiseResult::Failed),
        );
        let _ = c.on_ruling(ID.into(), U64(r.nonce));
        r = c.get_ruling(ID.into()).unwrap();
        assert_eq!(r.failures, 0);
        assert_eq!(r.undecided, 0);
        assert_eq!(
            serde_json::to_value(&r).unwrap()["admission_failures"],
            count
        );
        assert_eq!(r.stage, Stage::Idle);
        assert_eq!(
            r.outcome.as_deref(),
            if count == 24 { Some("void") } else { None }
        );
        assert!(functions().is_empty());
    }
    context(r.next_ns, "caller.testnet", 0, None);
    let _ = c.request_ruling(ID.into());
    let r = c.get_ruling(ID.into()).unwrap();
    context(r.started_ns, "referee.testnet", 0, success(&Some(bet(&r))));
    let _ = c.on_bet(ID.into(), U64(r.nonce));
    assert!(functions()
        .iter()
        .any(|(name, args, _)| name == "referee_resolve" && args["outcome"] == "void"));
}

#[test]
fn regression_escrow_read_failures_use_admission_allowance() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    for count in 1..=24 {
        r.stage = Stage::Reading;
        r.outstanding.clear();
        c.rulings.insert(&ID.into(), &r);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            Some(PromiseResult::Failed),
        );
        let _ = c.on_bet(ID.into(), U64(r.nonce));
        r = c.get_ruling(ID.into()).unwrap();
        assert_eq!(r.failures, 0);
        assert_eq!(
            serde_json::to_value(&r).unwrap()["admission_failures"],
            count
        );
        assert_eq!(
            r.outcome.as_deref(),
            if count == 24 { Some("void") } else { None }
        );
    }
}

#[test]
fn regression_infrastructure_backoff_combines_counters_and_caps_shift() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let now = DUE + 180 * SECOND;
    let mut r = ruling();
    // First reverted admission, followed by paid null results. Combined totals
    // 1..8 exercise every shift, including the six-bit cap.
    for count in 1u32..=8 {
        r.stage = Stage::Running;
        r.outstanding = vec![ExecutionAttempt {
            nonce: r.nonce,
            attempt: r.executions,
        }];
        c.rulings.insert(&ID.into(), &r);
        let response = if count == 1 {
            Some(PromiseResult::Failed)
        } else {
            success(&Option::<JuryResult>::None)
        };
        context(now, "referee.testnet", 0, response);
        let _ = c.on_ruling(ID.into(), U64(r.nonce));
        r = c.get_ruling(ID.into()).unwrap();
        assert_eq!(
            r.next_ns - now,
            ((300 * SECOND) << count.min(6)).min(6 * 3600 * SECOND)
        );
        assert!(r.outcome.is_none());
    }
}

#[test]
fn regression_unclear_keeps_fixed_delay_after_infrastructure_failure() {
    context(DUE + 180 * SECOND, "referee.testnet", 0, None);
    let mut c = contract();
    let mut r = ruling();
    r.failures = 4;
    c.rulings.insert(&ID.into(), &r);
    context(
        DUE + 180 * SECOND,
        "referee.testnet",
        0,
        success(&Some(result(&r, "unclear"))),
    );
    let _ = c.on_ruling(ID.into(), U64(1));
    let got = c.get_ruling(ID.into()).unwrap();
    assert_eq!(got.next_ns, DUE + 480 * SECOND);
    assert_eq!(got.failures, 4);
    assert_eq!(got.undecided, 1);
}

fn check_saturating_window(window: PriceWindow) {
    context(DUE, "caller.testnet", 0, None);
    let mut r = ruling();
    let mut m = material();
    m.deadline = "2554-07-21T23:34:00.000Z".into();
    r.deadline_ns = timestamp_ns(&m.deadline);
    m.evidence = EvidenceSpec::Coinbase {
        product: "NEAR-USD".into(),
        window,
    };
    validate_material(&m).unwrap();
    r.material_json = encode(&m);
    assert_eq!(ready_ns(&r), u64::MAX);
}

#[test]
fn regression_moment_nanoseconds_saturate() {
    check_saturating_window(PriceWindow::Moment {
        at: "2554-07-21T23:35:00.000Z".into(),
    });
}

#[test]
fn regression_range_nanoseconds_saturate() {
    check_saturating_window(PriceWindow::Range {
        start: "2554-07-21T23:33:00.000Z".into(),
        end: "2554-07-21T23:35:00.000Z".into(),
    });
}

#[test]
fn regression_registration_reserve_matches_shared_interface() {
    context(DUE, "referee.testnet", 0, None);
    let mut c = contract();
    let m = material();
    let hash = c.terms_hash(m.clone(), "c".repeat(64));
    let mut b = bet(&ruling());
    b.terms_hash = hash.clone();
    let before = env::storage_usage();
    c.pending_registration_deposits = EVIDENCE_DEPOSIT;
    context(DUE, "referee.testnet", 0, success(&Some(b)));
    assert!(c.on_register(
        encode(&m),
        hash,
        account("caller.testnet"),
        U128(EVIDENCE_DEPOSIT)
    ));
    let cost = env::storage_byte_cost().as_yoctonear();
    assert_eq!(c.growth_reserve, 32_768 * cost);
    assert_eq!(
        EVIDENCE_DEPOSIT - transfers()[0].1,
        (u128::from(env::storage_usage() - before) + 32_768) * cost
    );
}

#[test]
fn regression_result_limit_matches_shared_interface() {
    context(DUE, "referee.testnet", 0, None);
    let mut c = contract();
    for size in [16_384, 16_385] {
        let r = ruling();
        c.rulings.insert(&ID.into(), &r);
        let mut jury = result(&r, "yes");
        jury.evidence_summary = json!("");
        let padding = size - encode(&jury).len();
        jury.evidence_summary = json!("a".repeat(padding));
        assert_eq!(encode(&jury).len(), size);
        context(
            DUE + 180 * SECOND,
            "referee.testnet",
            0,
            success(&Some(jury)),
        );
        let _ = c.on_ruling(ID.into(), U64(1));
        let got = c.get_ruling(ID.into()).unwrap();
        assert_eq!(
            got.stage,
            if size == 16_384 {
                Stage::Paying
            } else {
                Stage::Idle
            }
        );
        assert_eq!(got.failures, u8::from(size > 16_384));
    }
}

#[test]
fn regression_config_advertises_open_evidence_and_actual_timeout() {
    context(DUE, "caller.testnet", 0, None);
    let config = contract().get_config();
    assert_eq!(config["supports_open_evidence"], true);
    assert_eq!(config["timeout_seconds"], 900);
}
