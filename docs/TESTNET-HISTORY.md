# Testnet history and evidence

### Earlier testnet walkthrough

This is the historical testnet walkthrough. The X bot now serves mainnet; its earlier reply commands do not establish current testnet intake. Steps 1 to 6 need no X account, wallet or API key.

1. Open the ruling on the first bet Stated paid on a jury ruling: https://stated-production.up.railway.app/bets/3668aa04-7009-4b85-b19d-debfabebbf96/ruling. Both sides belong to the operator: @ChainAbstracted offered it on X, and an operator-held NEAR account took it directly on the escrow. The claim was NEAR above US$3.30 on Coinbase at 19:15 UTC on 12 November. At 19:17 UTC Qwen3.8 27B, DeepSeek V4.1 Flash and GLM-5.3 Flash each read that minute's candle (open US$3.4206) and said yes, at confidence 1, 0.98 and 0.98. You see the three verdicts, why each decided, and under "Check it yourself" what was verified and the command that checks it again.
2. Run `npm ci && npm run verify` (Node 22.9 or later, outbound HTTPS). It replays the saved ruling offline, checks the live ruling, then checks the Court payout. Each step gets a summary and the command ends with a final status. The live step now checks bet `0bf4f3a7-8dfc-44e2-a139-1e33ce844178`, ending `37 checks passed, 0 failed, 0 not checked`; the aggregate ends `final: PASS (3 verification steps)`. Rotated NVIDIA signing keys use the certificate-checked snapshot `evidence/nvidia-jwks-snapshot-20261114.json` and the verifier prints the matching source. The checks cover the Intel TDX quotes back to Intel's root, the Ed25519 signatures over the exact request and response, each model's NVIDIA GPU evidence (a stored NVIDIA-signed verdict checked against NVIDIA's keys, or raw evidence sent to NVIDIA's attestation service), the enclaves' boot measurements against the published dstack image (through a Stated-hosted copy of the official dstack verifier unless you pass your own; the script says which), Intel's TCB status, the Coinbase prices fetched again, the Stated Court proposal that settled the bet (it must resolve the bet with the signed outcome and carry the ruling record's SHA-256), and the public page against the signed ruling.
3. Run `node scripts/verify-hosted-payout.mjs evidence/hosted-court-payout-testnet-20261112.json`. It prints `"overall": "PASS"` after two archival RPCs agree: the relay's approval of Stated Court proposal 3 made the DAO settle that bet as yes, 0.02 test NEAR reached the winner's account, the relay holds no keys and is the DAO's only jury member, and the contract that paid still runs code `Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg` (any other code fails the check) with no access keys. Without an argument it checks the earlier bet `c171de89`, paid 0.2 test NEAR on 11 November on a Result a human reviewer recorded.
4. Open https://stated-production.up.railway.app/court. You see Stated Court, the Sputnik DAO that referees new bets, read from chain: its jury member is a relay contract that cannot approve a ruling until ten minutes after it was filed, and its council can only vote a ruling down.
5. Check the chain with nothing of ours: the `curl` lines under [Check the chain yourself](../README.md#check-the-chain-yourself) print the access keys of the escrow, the relay and the DAO (none) and decode the relay's configuration and the DAO's policy.
6. Run `npm test`. With PostgreSQL 15+ tools (`initdb`, `pg_ctl`) on PATH it runs the whole suite; without them it runs the test files that need no database and names the rest as skipped.
7. With an X account, check the [testnet home page](https://stated-production.up.railway.app/) for an open offer. The historical links below may already be taken or expired.

## Historical testnet offers

These testnet offers were posted by the operator's account, @ChainAbstracted. These links document the earlier walkthrough; their inclusion does not establish current availability. The 14 November 16:00 UTC offer has expired; its public page still showed it accepted and unresolved when checked on 14 November 2026. Testnet reply workers may be off after the mainnet handover.

| Decides | The claim | Referee | Historical X link | Bet page |
| --- | --- | --- | --- | --- |
| 13 Nov, 16:00 UTC | NEAR above US$3.50 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120776695028576644&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/0bf4f3a7-8dfc-44e2-a139-1e33ce844178) |
| 14 Nov, 16:00 UTC | NEAR below US$3.50 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120776948846846333&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/009ce5b5-8b52-4f38-9117-96ae0e1a1b43) |
| 16 Nov, 16:00 UTC | NEAR above US$3.40 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120944717152317638&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/5814089a-7d17-4c05-913a-9ee7fde3e865) |
| 17 Nov, after the 13:30 UTC BLS release | US import prices fell in October 2026 | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120754423999914191&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/393238b4-34a5-4c27-b54f-01d3d4106c40) |
| 17 Nov, 16:00 UTC | BTC above US$72,000 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120945225120227684&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/3bcc8870-8a4e-4b52-9f6a-e5b8a602ccac) |
| 18 Nov, 16:00 UTC | NEAR below US$3.40 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120945480024867283&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/506505ee-bbe1-4346-acc4-0aa0eb0e50b2) |
| 19 Nov, 18:00 UTC | NEAR above US$3.50 on Coinbase | Stated Court | [X offer](https://x.com/intent/tweet?in_reply_to=2120754677759533081&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/4c71bdc7-0eab-47e6-88bb-f3fbe9a016a4) |
| 20 Nov, 20:00 UTC | NEAR above US$5 on Coinbase | Stated's referee account | [X offer](https://x.com/intent/tweet?in_reply_to=2120656329614430515&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/b29c28c0-4642-4115-b3e9-98512ae4ef07) |

The import-price bet is settled from links: after the release, whoever is right replies `yes <link>` or `no <link>` with the BLS page, or adds it on the bet's page, and the jury reads it. An offer can be taken until a minute before its deadline, and for at most seven days after it was made.

## Jury evaluation reference

This optional rerun makes paid API calls; it is not part of the read-only judge path. Load the API key through the environment before running it.

```sh
node scripts/jury-eval.mjs evidence/jury-eval-20261112/cases.json
```

The script sends written cases through the production verdict prompt, input builders and unanimity rule, then compares outcomes with each case's `expect`. It defaults to the hosted three-maker jury and 80% confidence, both configurable; it makes live NEAR AI Cloud calls and measures judgment on supplied text only.

## Where each number comes from

| Numbers, dates or versions used above | Evidence or command |
| --- | --- |
| Status date, bet `3668aa04`, 19:15 price window, 19:17 decision, US$3.30 / US$3.4206, proposal 3, 0.02 test NEAR, three early refusals, transaction/receipt hashes | [Court payout record](../evidence/hosted-court-payout-testnet-20261112.json), its `evidence`, `court`, `transactions` and `payout` fields; the individual historical commands recheck this ruling and payout; `npm run verify` checks `0bf4f3a7` |
| Three hosted models/makers, model version names, 80% threshold and confidence 1 / 0.98 / 0.98; recorded Court ruling | [Signed ruling](../evidence/enclave-ruling-3668aa04.json), `record.jury`, `record.verdicts`, `record.decidedAt`; the payout record establishes the operator-run example, not an exhaustive adoption count |
| Live ruling's saved 37 / 0 / 0 checks; offline 17 / 0 / 21 | [Saved live output](../evidence/verify-enclave-ruling-3668aa04-20261112.txt); `npm run verify:offline` prints the current replay counts |
| Earlier bet `c171de89`, 11 November, 0.1 stakes / 0.2 payout, human Result; managed account suffixes | [Earlier payout](../evidence/hosted-real-x-testnet-20261111.json); [earlier signed second opinion](../evidence/enclave-ruling-c171de89.json) |
| Historical offers' dates, UTC times, price thresholds, 0.1 stakes, bet UUIDs and X post IDs | Each linked Bet page in [Historical testnet offers](#historical-testnet-offers) shows its claim/deadline/stake and X links; open its linked public page to read it again |
| One-minute acceptance cutoff, seven-day offer limit, hosted one-hour evidence window and one-day default | [Reply-bet terms](../server/src/reply-bets.mjs), [configuration defaults](../server/src/config.mjs); the linked live Bet and evidence pages show the hosted deadlines |
| Two-to-ten-model policy, three undecided juries, 80% default, three-second page read, candle coverage and two-minute late-read limits | [Ruling engine](../server/src/enclave-ruling.mjs), [configuration](../server/src/config.mjs), [evidence intake](../server/src/bet-evidence.mjs) and [page extraction pool](../server/src/extraction-pool.mjs) |
| Reputation tiers 0.25 / 0.5 / 1 after 0 / 1 / 3 settled bets | [Default tiers](../server/src/reputation.mjs) |
| Ten-minute / 600-second deployed window, seven-day DAO proposal period, council/relay accounts, zero keys and frozen policy | [Relay deployment](../evidence/jury-relay-deploy-testnet-20261112.json), [Court freeze](../evidence/court-harden-testnet-20261112.json); the **Check the chain yourself** commands read current configuration and keys |
| Escrow one-NEAR maximum, 0.01 storage, two-day unanswered proposal and seven-day refund | [Escrow contract constants and methods](../contracts/bilateral-escrow/src/lib.rs) |
| Escrow code `Bqr2Tsgy…`, build SHA-256 `57fb29aa…`, testnet/mainnet account versions and zero keys | [Hosted verification](../evidence/hosted-court-payout-testnet-20261112.verification.json), [testnet deployment](../evidence/escrow-deploy-testnet-20261111.json), [mainnet deployment](../evidence/escrow-deploy-mainnet-20261111.json) |
| Deployed relay build SHA-256 `18545bdc…`; rehearsal 60 vs 600 seconds, 21 passing checks | [Relay deployment](../evidence/jury-relay-deploy-testnet-20261112.json); [rehearsal steps](../evidence/court-relay-live-test-2026-11-12.json), count `steps` and check each `pass` |
| Local relay 0.2.0, 17 Rust tests, two harmless surviving mutants; escrow 71 Rust tests | [Relay manifest](../contracts/jury-relay/Cargo.toml), [mutation run](../evidence/jury-relay-0.2.0-mutation-run-20261112.json); run the two `cargo test` commands in **Tests** for current counts. Local relay source is not the deployed build |
| 116 cases; 36 yes / 53 no / 27 refunds; individual misses 2 / 1 / 2; earlier 115 correct and no wrong-side payout; four author families | [Current results](../evidence/jury-eval-20261112/results-three-makers.json), [earlier results](../evidence/jury-eval-20261112/results.json), [case authors and review labels](../evidence/jury-eval-20261112/cases.json); tally `results[].jury` for the outcome split |
| Policy-check date; dstack production image 0.5.12 and verifier image 0.6.3; one-byte / half-memory / compose-event tamper tests | [Model policy checks](../evidence/jury-models-policy-check-20261112.json), [saved verifier output](../evidence/verify-enclave-ruling-3668aa04-20261112.txt), [dstack tamper checks](../evidence/dstack-verifier-2026-11-12.json) |
| Node 22.9 minimum, Docker/CI Node 26, PostgreSQL 15+ / container 17, SDK 5.29 and Sputnik v2 | [Package engines](../package.json), [CI](../.github/workflows/checks.yml), [test database helper](../server/test/support/pg.mjs), [test image](../Dockerfile.tests), contract manifests above, deployed DAO's `.sputnik-v2.testnet` account |
| Verification exits, three attempts, 250 / 1,000 ms backoff and 20 / 30 / 90-second deadlines | [Verification runner](../scripts/verify.mjs), [request transport](../scripts/verification-network.mjs), individual verifier CLI exit handling |
| Full-suite tests/pass/fail/skip counts, duration, commit and runtime versions | Historical full-suite record linked in [README Tests](../README.md#tests); its commit scope is stated there |
| Local ports 4310 / 4311 / 8080, zero demo delay and Docker PostgreSQL version | [Demo Compose](../compose.yaml), [demo walkthrough](DEMO.md), [dstack verifier deployment guidance](DEPLOY.md) |
| Video date/name, 0.4 demo payout, earlier live Court's two bets | [Demo run](../evidence/hackathon-demo-20261111.json), [video](../docs/stated-demo-70s.mp4), [earlier Court check](../evidence/court-live-2026-11-12.json) |
| Repository history's 11 November start | `git log --reverse --format='%aI %h'`; pre-git origin is the author's account, and who is behind each X account that bet is not established by the receipts |

