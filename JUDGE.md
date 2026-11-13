# Judge path

Five minutes, nine steps. Each is a command or a link, then exactly what you should see. Steps 1 to 3 and 5 need only a browser or Node 22.9 or later; none needs an X account, wallet or API key, and every command is read-only (no transaction is sent, no key is read). Every number below comes from a file in [evidence/](evidence/) or from a command you can run.

## What this is, and what it is not

- Stated lets two people bet on a post on X. Three models from three makers, each in its own NEAR AI enclave, must all agree on the outcome (80% confidence or more) or both stakes go back. A NEAR escrow contract pays the winner.
- It runs on NEAR **testnet, with test NEAR**. One bet has been paid on a jury ruling, `3668aa04`, and **both of its sides belong to the operator**. No one outside the team has taken a bet yet ([README, status](README.md)). The mainnet escrow is deployed with no access keys; the mainnet pilot is allowlisted and has not run.
- The home page shows "N bets taken by people outside the team" only when N is at least 1, counting public bets whose taker is not an operator account. It does not appear until someone outside the team takes one.

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

The mainnet line proves what is deployed there (no keys, version 2, a recorded hash). It does not show a mainnet bet, because none has been made.

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
