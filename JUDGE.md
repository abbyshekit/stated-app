# Judge path

## Check it yourself

**Mainnet OutLayer deployment: 9 of 9 checks passed.** [Saved verification](evidence/judge-outlayer-mainnet.json)

After `npm ci`, run the read-only deployment check:

```sh
npm run judge -- --outlayer --network mainnet \
  --referee referee.statedforecast.near \
  --referee-sha256 1f6b35b9fce99165af5090ff04d4ff6493933ec90ab3c0a37a532255bf46ed83 \
  --jury-sha256 85198c7afbfca6ad6cb42c76fe064abdf480d18f4db4955b90ce205d768d9791 \
  --wasm-url https://stated-production.up.railway.app/static/outlayer/stated-jury-85198c7afbfca6ad6cb42c76fe064abdf480d18f4db4955b90ce205d768d9791.wasm \
  --secrets-owner statedforecast.near
```

The deployment check covers the first three items below. A settled mainnet OutLayer bet is still needed for the fourth.

- Referee: no access keys; code hash matches the approved referee build.
- Config: expected escrow, OutLayer contract, jury URL/hash, secrets owner and profile.
- Jury: downloaded bytes match the pinned SHA-256.
- Bet: named referee, ruling stage/outcome, successful archival settlement and credits to the correct side.

Settlement credits remain in escrow until withdrawal; this command checks those credits through public RPC, needs no key and exits nonzero on a failed or pending bet check. Saved JSON records observed values and check time, excluding local paths and environment contents.

### OutLayer options

Supply the deployed referee account and reviewed deployment values. Obtain the two SHA-256 values from a reproducible build using the local runner documented in [docs/OUTLAYER.md](docs/OUTLAYER.md).

| Flag | Environment variable | Value |
| --- | --- | --- |
| `--referee` | `JUDGE_REFEREE` | Deployed referee account; required |
| `--referee-sha256` | `JUDGE_REFEREE_SHA256` | Approved referee build SHA-256 hex; required |
| `--jury-sha256` | `JUDGE_JURY_SHA256` | Approved jury build SHA-256 hex; required |
| `--wasm-url` | `JUDGE_WASM_URL` | Published HTTPS jury artifact URL; required |
| `--secrets-owner` | `JUDGE_SECRETS_OWNER` | Expected on-chain secrets owner account; required (public name only) |
| `--secrets-profile` | `JUDGE_SECRETS_PROFILE` | Defaults to `jury` |
| `--network` | `JUDGE_NETWORK` | Defaults to `mainnet`; also accepts `testnet` |
| `--escrow` | `JUDGE_ESCROW` | Defaults to `escrow.statedforecast.near` on mainnet |
| `--outlayer-contract` | `JUDGE_OUTLAYER_CONTRACT` | Defaults to `outlayer.near` on mainnet |
| `--bet-id` | `JUDGE_BET_ID` | Published bet ID; omit for deployment-only checks |
| `--settlement-tx` | `JUDGE_SETTLEMENT_TX` | Optional originating settlement transaction hash |
| `--settlement-signer` | `JUDGE_SETTLEMENT_SIGNER` | Original transaction signer; required with the transaction hash |
| `--save` | None | JSON output file; parent directory must exist |

Flags override environment values. `--outlayer` selects this mode; plain `npm run judge` keeps the existing escrow, relay, DAO and testnet bet checks. `--verbose` prints bounded request diagnostics. No environment file is loaded.

The bet check uses **`https://archival-rpc.mainnet.near.org`** (testnet: `https://archival-rpc.testnet.near.org`):

- Find the block matching the escrow resolution time and examine escrow state-change receipt IDs.
- Resolve the matching `referee_resolve` receipt through [NEAR's receipt-to-transaction lookup](https://docs.near.org/api-reference/post-experimental_receipt_to_tx) and read its finalized receipt graph.
- Check the successful settlement receipt came from the named referee and selected the ruling's outcome.
- Compare historical credit balances at the settlement block and its predecessor.

The referee is keyless; the original signer is a caller or OutLayer worker. If the archival node lacks receipt-to-transaction lookup, supply both optional transaction flags; missing archival evidence fails the check.

At both historical boundaries, the referee must have the approved code and no keys; the escrow must have its recorded code and no keys (using the same build records as the legacy judge checks). The reads also check the bet transition and both participants' net credit changes: both stakes to the Yes/No winner, or one stake each for Void.

Other credit activity in that block can prevent the comparison from passing. A selected bet that has not settled fails; a run without `--bet-id` checks deployment only and labels that limit in its JSON. Neither mode verifies model attestations or a later withdrawal to a wallet.

[Judge CI](.github/workflows/judge.yml) runs `npm ci`, `npm run verify:offline`, `npm run test:judge` and both OutLayer Rust test suites on pushes and pull requests. The daily mainnet job skips until repository variables for the referee, both hashes, jury URL and secrets owner are set. Set `JUDGE_BET_ID` to include settlement checks. Its `judge-outlayer-mainnet` artifact contains the JSON result even on a check failure. The saved deployment result covers the referee and its jury artifact.

Five minutes, nine steps. Each is a command or a link, then exactly what you should see. Steps 1 to 3 and 5 need only a browser or Node 22.9 or later; none needs an X account, wallet or API key, and every command is read-only (no transaction is sent, no key is read). Every number below comes from a file in [evidence/](evidence/) or from a command you can run.

## Current testnet path

- Stated lets two people bet on a post on X. Three models from three makers, each in its own NEAR AI enclave, must all agree on the outcome (80% confidence or more) or both stakes go back. A NEAR escrow contract pays the winner.
- It runs on NEAR **testnet, with test NEAR**. One bet has been paid on a jury ruling, `3668aa04`, and **both of its sides belong to the operator**. On 13 November the testnet home page counts three bets taken by people outside the team; who runs those X accounts is not established here ([README, status](README.md)). The mainnet escrow is deployed with no access keys and has settled one pilot round by mutual agreement between two pilot accounts; the OutLayer referee is deployed on mainnet ([saved verification](evidence/judge-outlayer-mainnet.json)).
- The home page shows "N bets taken by people outside the team" only when N is at least 1, counting public bets whose taker is not an operator account.

## 1. See the ruling (30 seconds, browser)

Open https://stated-production.up.railway.app/bets/3668aa04-7009-4b85-b19d-debfabebbf96/ruling

You see: the claim ("NEAR/USD will be above US$3.30 at 19:15 UTC on 12 November 2026"), three verdicts, Qwen3.8 27B yes at 100%, DeepSeek V4.1 yes at 98%, GLM-5.3 Flash yes at 98%, the Coinbase price US$3.4206, the line "@ChainAbstracted won the 0.02 test NEAR pot", each model's reason, and a "Check it yourself" section ending in the command in step 3. The same figures are in [enclave-ruling-3668aa04.json](evidence/enclave-ruling-3668aa04.json) and [hosted-court-payout-testnet-20261112.json](evidence/hosted-court-payout-testnet-20261112.json) (`stakeYoctoEach` 10000000000000000000000 per side, `payout.amountYocto` 20000000000000000000000).

## 2. See the Court (30 seconds, browser)

Open https://stated-production.up.railway.app/court

You see: "Every ruling waits ten minutes on NEAR. The council can vote it down before anyone is paid." A list of rulings, each marked "Let it stand" or "Voted it down" with its vote count, then "How the court is set up": the DAO `stated-court.sputnik-v2.testnet`, a jury that is only `jury.stated-court-relay.testnet`, and a council `stated-court-18ecdebd.testnet`. The list is read live, so it can hold more rulings than were there when this file was written; the `3668aa04` ruling is listed as "The models said yes. @ChainAbstracted was paid 0.02 test NEAR."

## 3. Re-check the ruling from outside (about 2 minutes)

```sh
npm ci && npm run verify
```

You see three steps and a last line `final: PASS (3 verification steps)`:

- the offline replay of the saved ruling, ending `EXPECTED INCOMPLETE` (it cannot check the network parts offline; `17 checks passed, 0 failed, 21 not checked`);
- the live ruling check, ending `37 checks passed, 0 failed, 0 not checked` ([saved output](evidence/verify-enclave-ruling-3668aa04-20261112.txt)): Intel TDX quotes to Intel's root, Ed25519 signatures, NVIDIA GPU attestation, boot measurements against the published dstack 0.5.12 image, the Coinbase candle fetched again, and the Court proposal that settled the bet;
- the live Court payout check, ending `live hosted payout: PASS (exit 0)`.

Without network access, `npm run verify:offline` runs only the first step.

## 4. Check the chain (10 seconds)

```sh
npm run judge
```

You see five `PASS` lines and `judge-chain: PASS (5 of 5 checks)`. The command asks public NEAR RPC (`test.rpc.fastnear.com` and `free.rpc.fastnear.com`, each with a second endpoint and at most three tries per call) and prints `FAIL` and exits 1 on any difference. The five checks:

| Check | Expected | Where the expected value is recorded |
| --- | --- | --- |
| Testnet escrow `stated-escrow-52081551be.testnet` | 0 access keys, `version()` = `"2"`, code hash `Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg` | [reply-bets-testnet-live.json](evidence/reply-bets-testnet-live.json), `contractDeployment.wasmSha256` `a1182e5c…a2d5` in hex; the script converts it to base58 |
| Mainnet escrow `escrow.statedforecast.near` | 0 access keys, `version()` = `"2"`, code hash `6vSbm6dg1F6gyEggDNtd5t3MrDmGZBgSgE4NjHwEmS33` | [escrow-deploy-mainnet-20261111.json](evidence/escrow-deploy-mainnet-20261111.json), `wasmSha256` `57fb29aa…3d6a` |
| Relay `jury.stated-court-relay.testnet` | 0 access keys | [jury-relay-deploy-testnet-20261112.json](evidence/jury-relay-deploy-testnet-20261112.json) |
| Court DAO `stated-court.sputnik-v2.testnet` | the relay is the only jury member; the council holds only `call:VoteReject` and `call:VoteRemove`; two roles, no role-specific voting rule | [court-harden-testnet-20261112.json](evidence/court-harden-testnet-20261112.json); the rule is the one the server enforces in [court-dao.mjs](server/src/court-dao.mjs) |
| Bet `3668aa04-7009-4b85-b19d-debfabebbf96` on the testnet escrow | `status` `settled`, `resolution.outcome` `yes` | [hosted-court-payout-testnet-20261112.json](evidence/hosted-court-payout-testnet-20261112.json) |

The mainnet line checks the escrow deployment. The pilot round settled by agreement and is outside the scope of this command.

## 5. Look at the chain without our code (optional, 1 minute)

The same facts by hand, with `curl` and a public RPC, are in [README, "Check the chain yourself"](README.md#check-the-chain-yourself). Or open the accounts in an explorer: [testnet escrow](https://testnet.nearblocks.io/address/stated-escrow-52081551be.testnet), [relay](https://testnet.nearblocks.io/address/jury.stated-court-relay.testnet), [mainnet escrow](https://nearblocks.io/address/escrow.statedforecast.near). You see the contract accounts with no access keys.

## 6. Run the tests (optional)

```sh
npm test
```

Runs the whole suite when PostgreSQL 15+ (`initdb`, `pg_ctl`) is on PATH, otherwise the files that need no database and a note saying which it skipped. `STATED_TEST_REQUIRE_PG=1 npm test` fails instead of skipping.

## 7. How the jury did on hard cases

[results-three-makers.json](evidence/jury-eval-20261112/results-three-makers.json), `summary.tally`: 116 cases, 116 correct, 0 wrong winner, 0 paid instead of a refund. The cases are written text, not real disputes, and the drill does not test the enclave ([README](README.md) says so as well).

## 8. Read what is open

[docs/SECURITY.md](docs/SECURITY.md) lists each finding, its fix and its test, and ends with what is still open, including that the council is one operator account.

## 9. Make a bet yourself (needs an X account)

Reply to any post on X with `@statedforecast bet 0.1 no` (the amount is test NEAR). The [home page](https://stated-production.up.railway.app) says which bot account is live. Nothing here is required to judge the entry; if you do take a bet and you are not on the team, the home page will show it in its "bets taken by people outside the team" line.
