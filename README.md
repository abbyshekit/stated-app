# Stated

[![checks](https://github.com/abbyshekit/stated-app/actions/workflows/checks.yml/badge.svg)](https://github.com/abbyshekit/stated-app/actions/workflows/checks.yml)

Bet on anything said on X by replying to it. Three models from three makers, each in its own NEAR AI enclave, must all agree who won, or both stakes go back; a NEAR contract pays the winner, and one command re-checks the ruling from outside.

Status on 12 November 2026: running on NEAR testnet with test NEAR. The hosted app paid its first bet on a jury ruling: three models in NEAR AI enclaves agreed on a Coinbase price, Stated Court approved the ruling after its ten-minute window, and the escrow paid the winner. Both sides of that bet belong to the operator. Nobody outside the team has taken a bet yet; the offers below are open to anyone with an X account.

| | |
| --- | --- |
| Tracks | Open Innovation `open`; Privacy & Private AI `privacy`; Social Money `social`; AI Security & Defense `security` |
| Hosted app | https://stated-production.up.railway.app (NEAR testnet, test NEAR) |
| Demo video | [docs/stated-demo-70s.mp4](docs/stated-demo-70s.mp4) (recorded on 11 November, before the jury ruled on a bet) |
| Quick check | `npm ci`, then `npm run verify`; without network access, `npm run verify:offline` |
| Tests | `npm test`: the whole suite with PostgreSQL 15+, otherwise the files that need no database |
| Security | [docs/SECURITY.md](docs/SECURITY.md): a security review of the code and the hosted app, each finding and its fix |
| Terms and privacy | [Terms of Service](https://stated-production.up.railway.app/terms) and [Privacy Policy](https://stated-production.up.railway.app/privacy) on the hosted app |

## Try it

Each step says what to do and what you should see. Steps 1 to 6 need no X account, wallet or API key.

1. Open the ruling on the first bet Stated paid on a jury ruling: https://stated-production.up.railway.app/bets/3668aa04-7009-4b85-b19d-debfabebbf96/ruling. Both sides belong to the operator: @ChainAbstracted offered it on X, and an operator-held NEAR account took it directly on the escrow. The claim was NEAR above US$3.30 on Coinbase at 19:15 UTC on 12 November. At 19:17 UTC Qwen3.8 27B, DeepSeek V4.1 Flash and GLM-5.3 Flash each read that minute's candle (open US$3.4206) and said yes, at confidence 1, 0.98 and 0.98. You see the three verdicts, why each decided, and under "Check it yourself" what was verified and the command that checks it again.
2. Run `npm ci && npm run verify` (Node 22.9 or later, outbound HTTPS). It replays the saved ruling offline, checks the live ruling, then checks the Court payout. Each step gets a summary and the command ends with a final status. The live ruling check ended `37 checks passed, 0 failed, 0 not checked` on 12 November 2026 ([saved output](evidence/verify-enclave-ruling-3668aa04-20261112.txt)). The checks cover the Intel TDX quotes back to Intel's root, the Ed25519 signatures over the exact request and response, each model's NVIDIA GPU evidence (a stored NVIDIA-signed verdict checked against NVIDIA's keys, or raw evidence sent to NVIDIA's attestation service), the enclaves' boot measurements against the published dstack image (through a Stated-hosted copy of the official dstack verifier unless you pass your own; the script says which), Intel's TCB status, the Coinbase prices fetched again, the Stated Court proposal that settled the bet (it must resolve the bet with the signed outcome and carry the ruling record's SHA-256), and the public page against the signed ruling.
3. Run `node scripts/verify-hosted-payout.mjs evidence/hosted-court-payout-testnet-20261112.json`. It prints `"overall": "PASS"` after two archival RPCs agree: the relay's approval of Stated Court proposal 3 made the DAO settle that bet as yes, 0.02 test NEAR reached the winner's account, the relay holds no keys and is the DAO's only jury member, and the contract that paid still runs code `Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg` (any other code fails the check) with no access keys. Without an argument it checks the earlier bet `c171de89`, paid 0.2 test NEAR on 11 November on a Result a human reviewer recorded.
4. Open https://stated-production.up.railway.app/court. You see Stated Court, the Sputnik DAO that referees new bets, read from chain: its jury member is a relay contract that cannot approve a ruling until ten minutes after it was filed, and its council can only vote a ruling down.
5. Check the chain with nothing of ours: the `curl` lines under [Check the chain yourself](#check-the-chain-yourself) print the access keys of the escrow, the relay and the DAO (none) and decode the relay's configuration and the DAO's policy.
6. Run `npm test`. With PostgreSQL 15+ tools (`initdb`, `pg_ctl`) on PATH it runs the whole suite; without them it runs the test files that need no database and names the rest as skipped.
7. With an X account, take one of the live bets below. You see the bot reply in the thread and a NEAR account made for your handle; at the deadline the jury rules, and the winner is paid after the ten-minute window.

## Take a live bet

These are real offers on X, each funded in a NEAR testnet escrow. Open a link with your own X account and post the reply it prepares; Stated makes you a NEAR account and funds your 0.1 test NEAR stake, so no wallet is needed. The offers were posted by the operator's account, @ChainAbstracted; whoever takes the other side is the first person outside the team to bet.

| Decides | The claim | Referee | Take it | Bet page |
| --- | --- | --- | --- | --- |
| 13 Nov, 16:00 UTC | NEAR above US$3.50 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120776695028576644&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/0bf4f3a7-8dfc-44e2-a139-1e33ce844178) |
| 14 Nov, 16:00 UTC | NEAR below US$3.50 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120776948846846333&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/009ce5b5-8b52-4f38-9117-96ae0e1a1b43) |
| 16 Nov, 16:00 UTC | NEAR above US$3.40 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120944717152317638&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/5814089a-7d17-4c05-913a-9ee7fde3e865) |
| 17 Nov, after the 13:30 UTC BLS release | US import prices fell in October 2026 | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120754423999914191&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/393238b4-34a5-4c27-b54f-01d3d4106c40) |
| 17 Nov, 16:00 UTC | BTC above US$72,000 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120945225120227684&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/3bcc8870-8a4e-4b52-9f6a-e5b8a602ccac) |
| 18 Nov, 16:00 UTC | NEAR below US$3.40 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120945480024867283&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/506505ee-bbe1-4346-acc4-0aa0eb0e50b2) |
| 19 Nov, 18:00 UTC | NEAR above US$3.50 on Coinbase | Stated Court | [take on X](https://x.com/intent/tweet?in_reply_to=2120754677759533081&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/4c71bdc7-0eab-47e6-88bb-f3fbe9a016a4) |
| 20 Nov, 20:00 UTC | NEAR above US$5 on Coinbase | Stated's referee account | [take on X](https://x.com/intent/tweet?in_reply_to=2120656329614430515&text=%40statedforecast+take) | [open](https://stated-production.up.railway.app/bets/b29c28c0-4642-4115-b3e9-98512ae4ef07) |

The import-price bet is settled from links: after the release, whoever is right replies `yes <link>` or `no <link>` with the BLS page, or adds it on the bet's page, and the jury reads it. An offer can be taken until a minute before its deadline, and for at most seven days after it was made.

## How it works

1. Reply under a post with `@statedforecast bet 0.1 yes`; the reply may carry its own deadline, such as `bet 0.1 yes by 30 nov`.
2. Someone takes the other side by replying `take` or on the bet's page, without bringing a wallet: Stated creates a named NEAR account per X handle, and a Rust escrow contract holds both stakes.
3. After the deadline, an enclave model chooses where the answer comes from: Coinbase price candles, or links the two bettors submit by replying `yes <link>` / `no <link>` or on the bet's page (on the hosted app, for an hour after the deadline; the bet's evidence page shows when links close; the code default is a day).
4. On the hosted app, three models from three makers, each in its own NEAR AI Cloud enclave, must all agree on Yes or No at 80% confidence or more (the engine takes two to ten models). If they do not, the jury tries again, and after three undecided juries both stakes go back.
5. The ruling becomes a proposal in Stated Court. The council can vote it down for ten minutes; after that anyone can trigger the relay's approval, and the DAO settles the escrow. For an account whose key Stated still holds, the winner's payout is withdrawn to it automatically; a person who has claimed their account withdraws with their own wallet.

## Why each track

### Privacy & Private AI (`privacy`)

- **Confidential computation.** Every jury call runs in an Intel TDX enclave on NEAR AI Cloud. The app fetches an attestation with a fresh nonce, verifies the gateway's and signing model's quotes back to Intel's pinned root and their key and nonce bindings, checks each model's NVIDIA GPU evidence with NVIDIA's attestation service, replays the event log against RTMR3, and verifies the response signature over the exact request and response bytes.
- **Fail closed.** A call counts only with the signing model's GPU evidence, a dstack verifier that answers, the published production dstack image and an Intel TCB that is up to date. Otherwise it gives no verdict and is retried. The app refuses to start rulings without a dstack verifier, and it refuses the switch that turns GPU evidence off for any NEAR AI host but a local or `.test` fake, so only test stacks can use it. On 12 November 2026 a test call to each of the three current jury models passed this policy, and the full signed records are saved ([evidence](evidence/jury-models-policy-check-20261112.json)); the current roster then ruled on bet `3668aa04`, and every one of its reports matched the published dstack 0.5.12 production images with an Intel TCB that is up to date (the verify script's output in Try it, step 2, checked through a Stated-hosted copy of the official verifier image). The earlier roster's reports on `c171de89` passed the same checks ([evidence](evidence/dstack-verifier-2026-11-12.json)). Changed by one byte of the quote, half the VM's memory or a different compose-hash event, the same report is rejected, and the verifier names the mismatch (same file).
- **Data stays where it belongs.** The escrow stores only a salted fingerprint of a bet's terms; the claim and notes stay off chain. A private bet's page, evidence and ruling are not public, and a post's shared Result never carries a private bet's evidence or a juror's reason about it.

### AI Security & Defense (`security`)

- **The AI holds no keys.** For a bet that names Stated Court, a jury ruling reaches the escrow only through the [jury relay](contracts/jury-relay) and the DAO. The relay's operator can only file a `referee_resolve` for one bet and outcome; the relay approves only its own filing, exactly as filed, ten minutes after the DAO recorded it (the window is fixed at deployment: 600 seconds). The escrow lets its referee choose only Yes, No or Void between the two bettors; it also settles when both bettors agree, and refunds both stakes seven days after the deadline if nothing settled. Bets made before the Court name the server's referee account. Neither contract has an access key or an upgrade path.
- **Spending limits that follow reputation.** A new handle can stake at most 0.25 test NEAR; after one settled bet, 0.5; after three, 1.
- **TEE attestation, checked twice.** Inside the app before a verdict counts, and from outside by anyone with the verify script.
- **Reviewed.** A security review of the code and the hosted app, run with automated tools rather than an independent auditor, found a crash, a page-parsing denial of service, an escrow that a deleted post could orphan, a court that one key could run and a private-evidence leak. Each is fixed with a test; see [docs/SECURITY.md](docs/SECURITY.md).

### Social Money (`social`)

- **Sputnik DAO.** [Stated Court](https://stated-production.up.railway.app/court) holds the referee seat of new bets. Its council can veto a ruling; nobody, including the operator, can approve one early or change the court's rules ([freeze record](evidence/court-harden-testnet-20261112.json)).
- **Named accounts.** Each X handle gets a NEAR account named for it, such as `chainabstracted.stated-play-6cf0876dd7.testnet`.
- **Reputation-based access.** Stake ceilings rise with each handle's settled bets.
- Bets happen between people in the thread where the argument happened, and published bet pages record who took each side and the Result.

### Open Innovation (`open`)

A Node.js and PostgreSQL app joins X reply intake, a jury of enclave models that reads evidence from both sides, a Sputnik DAO court and Rust escrow on NEAR, with a Docker walkthrough and scripts that re-check the hosted ruling, its payout and the contracts' code and keys from public sources.

## Who decides the result

Enclave rulings require `STATED_ENCLAVE_RULINGS=1`, `NEARAI_API_KEY` and `NEARAI_RULING_MODELS` listing at least two distinct models (the hosted jury lists three). `NEARAI_RULING_MIN_CONFIDENCE` defaults to `0.8`. `STATED_REQUIRE_GPU_EVIDENCE` defaults on, and setting it to `0` is refused unless the NEAR AI URL is a loopback or `.test` host, as in the test stacks, whose fake NEAR AI has no GPU. Rulings also need `STATED_DSTACK_VERIFIER_URL`: the app refuses to start them without it, and an unreachable verifier fails the call.

The routing model selects a Coinbase product and time window or bettor-submitted evidence. The server builds the Coinbase URLs and fetches the candles; for other claims, fetched page text enters the signed jury request. Pages are read in a worker with a three-second limit. For a claim that something will happen, no credible evidence of it happening by the deadline means No; a claim that it will not happen applies the reverse rule.

All jurors must agree at the threshold. Three completed undecided attempts produce a void and return both stakes; network errors, invalid signatures, failed attestation and empty responses retry separately. With rulings off, a human reviewer records the Result. A saved second opinion on an already settled bet changes neither its Result nor its payout.

New reply bets name `stated-court.sputnik-v2.testnet` as referee, once the server has checked the DAO's network, policy, relay, window and bond; if a check fails, the bet names the server's referee account instead, and its page says so. The server files the jury's ruling through the relay [`jury.stated-court-relay.testnet`](https://testnet.nearblocks.io/address/jury.stated-court-relay.testnet) as a DAO proposal whose only action is the escrow's `referee_resolve`; the proposal's description carries the ruling record's SHA-256, which the verify script checks on chain. The council, `stated-court-18ecdebd.testnet`, can vote the proposal down for 600 seconds. After that the relay approves it and the DAO settles the bet. The server waits until the bet's `resolve_at` before filing any Court ruling, including a reviewer's early Yes. The deployed relay counts its 600 seconds from filing and does not read the bet's deadline; the escrow does not check it either. Relay `0.2.0`, not yet deployed, refuses on chain both a ruling filed before the bet's deadline and an approval before it, and checks that the bet names this DAO as referee. The frozen DAO cannot swap its relay, so the new relay would serve a new DAO for new bets, and deploying it waits until the server can serve two Courts at once: the open offers above name this one. A Result corrected after filing does not withdraw the earlier proposal; the council has to vote it down. One open limit remains: an approval sent more than the DAO's seven-day proposal period after filing only expires the proposal and does not settle the bet. Bets made before the DAO existed keep the server's referee account.

| Account | Who holds its key | What it can do |
| --- | --- | --- |
| `stated-escrow-52081551be.testnet` (escrow) | Nobody: no access keys | Hold stakes; pay only the two bettors; accept a Result from the bet's named referee, or from both bettors agreeing on it (an unanswered proposal cannot settle a bet that names a referee) |
| `jury.stated-court-relay.testnet` (relay) | Nobody: no access keys | File and approve one `referee_resolve` per ruling, and approve only after 600 seconds |
| `stated-court.sputnik-v2.testnet` (DAO) | Nobody: no access keys | Execute the proposals its members pass; its policy cannot be changed |
| `referee.stated-play-6cf0876dd7.testnet` | The server | Ask the relay to file a ruling; be the referee of bets made before the DAO |
| `stated-court-18ecdebd.testnet` (council) | The operator | Vote a ruling down or remove it |
| `<handle>.stated-play-6cf0876dd7.testnet` | The server, until the person claims the account | Stake and withdraw for that handle; claiming replaces the server's key with the person's |

Known limits: Coinbase evidence may omit up to a tenth of a segment's candles; moment claims use the minute's opening price, and range boundaries round outward to whole minutes. Submitted pages are read once, with late reads allowed up to two minutes after evidence closes; signed text establishes what the jury read, not the source's truth or the verdict's correctness.

## How good is the jury

The hosted jury is three models from three makers, each in its own enclave: Qwen3.8 27B (Qwen), DeepSeek V4.1 Flash (DeepSeek) and GLM-5.3 Flash (Z.ai). The [saved policy check](evidence/jury-models-policy-check-20261112.json) covers a call to each on 12 November 2026.

On 116 adversarial cases written by four model families (Gemini 3.1 Pro, GPT-5.6, Claude Opus 5.5, Mistral Large) and kept only where a second family's label agreed, this jury reached the outcome its rules require in all 116: 36 yes, 53 no and 27 refunds ([results-three-makers.json](evidence/jury-eval-20261112/results-three-makers.json)). Alone, the models missed 2, 1 and 2 cases; the every-model-must-agree rule turned each of those into a refund or the right answer. An earlier roster with two Qwen models reached 115; its one miss was a refund where yes was due ([results.json](evidence/jury-eval-20261112/results.json)). No run paid the wrong side. The cases include satire, rumours about public figures, reports dated after the deadline, namesakes, contradicting sources and instructions hidden in the evidence. This is a drill on written text: it does not test the enclave, and the cases are not real disputes. On a real hosted bet the three-maker jury has ruled once, on `3668aa04` (12 November, paid through Stated Court); the stored second opinion on the earlier bet `c171de89` was made by the two-Qwen roster.

```sh
NEARAI_API_KEY=... node scripts/jury-eval.mjs evidence/jury-eval-20261112/cases.json
```

The script sends written cases through the production verdict prompt, input builders and unanimity rule, then compares outcomes with each case's `expect`. It defaults to the hosted three-maker jury and 80% confidence, both configurable; it makes live NEAR AI Cloud calls and measures judgment on supplied text only.

## Verify a ruling yourself

```sh
npm run verify
# No network? Run only the saved-record replay:
npm run verify:offline
# Run individual live checks or choose another ruling:
node scripts/verify-enclave-ruling.mjs
# For another public bet with a saved ruling, such as the earlier second opinion on c171de89:
node scripts/verify-enclave-ruling.mjs https://stated-production.up.railway.app c171de89-f223-4309-886e-180ad69af092
# No network? Replay the saved record; checks that need the network say NOT CHECKED (offline):
node scripts/verify-enclave-ruling.mjs --offline evidence/enclave-ruling-3668aa04.json
```

The script reads `/bets/<id>/enclave-ruling.json` and prints a status per check:

| Output | Check |
| --- | --- |
| Signed ruling / Intel TDX quotes | Exact-byte hashes and Ed25519 signatures verify; gateway and signing-model quotes chain to Intel's root and bind signing keys and nonces; supplied event logs replay to the quote's RTMR3 |
| GPU attestation | Re-verifies each stored NVIDIA signed verdict and its nonce, or checks the stored raw evidence through NVIDIA's attestation service now |
| Quote measurements / Intel collateral | The official dstack verifier recomputes MRTD and RTMR0-2 from the published production image and checks Intel's TCB status and advisories |
| Bet coverage / Jury policy / Signed model verdict | The signed material names the bet and terms hash; the roster, threshold and verdicts produce the recorded outcome |
| Coinbase source / Coinbase evidence hash | Every candle URL is fetched again and the rebuilt evidence matches its signed hash |
| Court proposal | The DAO proposal that settled the bet, read from an archival RPC, resolves it with the recorded outcome and carries the SHA-256 of the fetched record; not applicable to bets made before the Court |
| Public claim / deadline / terms hash / outcome | The bet page matches the signed ruling |

The dstack verifier it calls by default is a Stated-hosted instance of the official image, and the script's output says so. To use your own: `docker run -p 8080:8080 ghcr.io/dstack-tee/dstack-verifier:0.6.3`, then pass `--dstack-verifier http://localhost:8080`. Exit `0` means no check failed and none that could be run was left unchecked; `2` means none failed but some could not be checked, each saying why (offline, the run prints 17 passed, 0 failed, 21 not checked); `1` means at least one FAIL. For a ruling decided on submitted links, the linked pages are listed as NOT RE-READ and do not change the exit code. These checks authenticate a record; they do not prove the jury reached the right answer.

The combined command runs every step even if an earlier one fails. It accepts the offline replay's expected exit `2`; a live exit `2` leaves the combined run incomplete and nonzero. `verify:offline` applies the same offline rule. Each network request reports its endpoint, call, attempt, elapsed time and deadline to stderr. Transient timeouts, transport failures, HTTP 429 and 5xx responses get at most three attempts, with 250 ms then 1,000 ms backoff. Each attempt allows 30 seconds for hosted pages, Coinbase and RPC, 20 seconds for NVIDIA, or 90 seconds for dstack, including the response body. A negative attestation verdict is a rejection. Payout retries stay on their original provider, and both archival providers must still agree.

## Check the chain yourself

These read NEAR testnet through a public RPC and print what the chain holds, with none of Stated's code.

```sh
# Access keys: each answer contains "keys":[]
for a in stated-escrow-52081551be.testnet jury.stated-court-relay.testnet stated-court.sputnik-v2.testnet; do
  curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$a\"}}"; echo
done
# The relay's configuration (600 s window) and the DAO's policy (jury = the relay; council may only reject or remove)
view() { curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"e30=\"}}" \
  | python3 -c 'import sys, json; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }
view jury.stated-court-relay.testnet get_config
view stated-court.sputnik-v2.testnet get_policy
```

## Run locally with Docker

```sh
docker compose up --build
```

Wait for `Ready:`, then open Stated at `http://127.0.0.1:4310` and simulated X at `http://127.0.0.1:4311`. Browsing and prediction capture need no X account, API key or wallet; reply bets use real NEAR testnet and need outbound RPC access plus a funded treasury, provisioned through the faucet when available. Check `/demo-readiness`, then try `/demo-challenge`; `/demo-proof` rechecks the recorded testnet payout. Docker uses human-recorded Results and a zero settlement delay, so it does not demonstrate the enclave jury. [Walkthrough](docs/DEMO.md)

## The contracts

[bilateral-escrow](contracts/bilateral-escrow/src/lib.rs) holds equal stakes and stores hashed terms. Settlement creates withdrawal credit; a separate withdrawal and successful callback establish delivery. Stakes are greater than zero and at most one NEAR; the creator also pays 0.01 test NEAR for storage. Without a referee, an agreed result settles; an unanswered proposal can stand after two days, and unresolved bets can refund seven days after the resolution date. The hosted escrow, `stated-escrow-52081551be.testnet`, has code hash `Bqr2Tsgy…` and no access keys (checked by `verify-hosted-payout.mjs`). A later build of the same contract, sha256 `57fb29aa…`, runs at `escrow.stated-play-52ee8531f8.testnet` and on mainnet at `escrow.statedforecast.near`, also with no keys ([testnet](evidence/escrow-deploy-testnet-20261111.json), [mainnet](evidence/escrow-deploy-mainnet-20261111.json)). The build is not byte-for-byte reproducible, so each deployment record gives the hash its own build produced.

[jury-relay](contracts/jury-relay/src/lib.rs) is the court's jury member: [deployment record](evidence/jury-relay-deploy-testnet-20261112.json) (WASM sha256 `18545bdc…`, code hash matches the build, no access keys). Before the live DAO was frozen, the same scripts froze a rehearsal DAO with the live policy's roles and permissions (its own relay, a test operator and a 60-second window in place of 600 seconds) and passed 21 of 21 checks on chain: the council could not propose or approve, an early approval was refused, a veto held, and an approval after the window settled the escrow ([record](evidence/court-relay-live-test-2026-11-12.json)).

Relay version `0.2.0`, for the next deployment, also reads the escrow's `get_bet` after validating the proposal and challenge window. It approves only if the returned bet ID matches, the bet names this DAO as referee, its status is `accepted`, `proposed` or `disputed`, the ruling was filed no earlier than `resolve_at_ns`, and the on-chain time has reached it. It has 17 Rust tests. In a mutation run by an AI review agent, which deleted or loosened each check in turn, a test caught every mutant except two that cannot change behaviour on chain ([record](evidence/jury-relay-0.2.0-mutation-run-20261112.json)). It is not deployed: the deployed relay checks only the proposal and challenge window, and moving new bets to a second Court waits until the server can serve both.

## Tests

```sh
npm test
cargo test --manifest-path contracts/bilateral-escrow/Cargo.toml --locked
cargo test --manifest-path contracts/jury-relay/Cargo.toml --locked
```

`npm test` runs the whole suite when a throwaway PostgreSQL 15+ cluster can start (`initdb` and `pg_ctl` on PATH); otherwise it names the database test files it skipped. The runner prints the test/pass/fail/skip counts. `STATED_TEST_REQUIRE_PG=1` makes a missing database an error. [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs these commands and `npm audit --omit=dev --audit-level=high` on every push. Server tests use throwaway clusters and a fake X API; they do not establish live X or enclave behaviour. The escrow has 71 Rust tests and the relay 17; run the contract commands above for their current counts, and `cargo clippy -- -D warnings` and `cargo fmt -- --check` for each manifest to check lint and format.

To record the submission commit, run `node scripts/record-test-run.mjs` with PostgreSQL tools on PATH. It writes `evidence/test-run-<12-character HEAD>.json` with the commit, whether the worktree had changes, Node/PostgreSQL versions, parsed counts and duration; it saves no environment values. A complete run updates the link below, including its passed/failed status. A missing database or incomplete runner output exits nonzero and leaves the latest complete link alone. Commit the generated record with the updated link.

<!-- test-run-record -->Latest full-suite record: [test-run-ca6d0d03cfab.json](evidence/test-run-ca6d0d03cfab.json) (passed).

## Built during NEAR HACKATHON

All code was written during the hackathon. Work began on 5 November 2026 in a working folder without version control; the private repository's history starts on 11 November, and this public repository was copied from it without its unrelated folders. No code predates the hackathon, so there is no baseline to disclose. Built with `near-api-js` and `@near-js/*`, the Meteor Wallet SDK, `pg`, `decimal.js`, `@resvg/resvg-js`, `qrcode-generator` and `esbuild`; Rust `near-sdk` 5.29 for both contracts; and the services NEAR AI Cloud, NVIDIA's attestation service, the dstack verifier image 0.6.3, Sputnik DAO v2, Coinbase Exchange's public candles and the X API.

## Evidence files

- [Jury ruling on bet 3668aa04](evidence/enclave-ruling-3668aa04.json): the signed record the Court proposal anchors, with each model's GPU and dstack evidence, and [the verify script's output](evidence/verify-enclave-ruling-3668aa04-20261112.txt) on it.
- [Court payout of bet 3668aa04](evidence/hosted-court-payout-testnet-20261112.json): the X posts, every transaction from offer to withdrawal, the three approvals the relay refused before its window ended, and the referee account's top-up; [verifier output](evidence/hosted-court-payout-testnet-20261112.verification.json).
- [Stated Court freeze](evidence/court-harden-testnet-20261112.json) and [relay deployment](evidence/jury-relay-deploy-testnet-20261112.json); [rehearsal on a test DAO](evidence/court-harden-rehearsal-testnet-20261112.json) with its [21 live checks](evidence/court-relay-live-test-2026-11-12.json).
- [Earlier Stated Court live check](evidence/court-live-2026-11-12.json): two bets on the escrow; one approved and paid, one voted down and left open.
- [Hosted real-X payout](evidence/hosted-real-x-testnet-20261111.json): two operator-controlled identities, 0.1 test NEAR each, 0.2 test NEAR paid after a human-recorded Result; [starting another bet from the Result](evidence/make-a-bet-real-x-20261111.json).
- [dstack verification](evidence/dstack-verifier-2026-11-12.json) of the hosted ruling, with the tamper checks.
- [Existing recording](docs/stated-demo-70s.mp4); [simulated-X run with a 0.4 test NEAR payout](evidence/hackathon-demo-20261111.json); [funded Docker run](evidence/funded-judge-testnet-20261111.json); [web acceptance and payout](evidence/web-take-testnet-20261111.json).

## Where each number comes from

| Numbers, dates or versions used above | Evidence or command |
| --- | --- |
| Status date, bet `3668aa04`, 19:15 price window, 19:17 decision, US$3.30 / US$3.4206, proposal 3, 0.02 test NEAR, three early refusals, transaction/receipt hashes | [Court payout record](evidence/hosted-court-payout-testnet-20261112.json), its `evidence`, `court`, `transactions` and `payout` fields; `npm run verify` rechecks the ruling and payout |
| Three hosted models/makers, model version names, 80% threshold and confidence 1 / 0.98 / 0.98; one hosted Court ruling | [Signed ruling](evidence/enclave-ruling-3668aa04.json), `record.jury`, `record.verdicts`, `record.decidedAt`; the payout record establishes the operator-run example, not an exhaustive adoption count |
| Live ruling's saved 37 / 0 / 0 checks; offline 17 / 0 / 21 | [Saved live output](evidence/verify-enclave-ruling-3668aa04-20261112.txt); `npm run verify:offline` prints the current replay counts |
| Earlier bet `c171de89`, 11 November, 0.1 stakes / 0.2 payout, human Result; managed account suffixes | [Earlier payout](evidence/hosted-real-x-testnet-20261111.json); [earlier signed second opinion](evidence/enclave-ruling-c171de89.json) |
| Live offers' dates, UTC times, price thresholds, 0.1 stakes, bet UUIDs and X post IDs | Each linked Bet page in **Take a live bet** shows its claim/deadline/stake and X links; `curl --fail https://stated-production.up.railway.app/bets/<UUID>` reads it again |
| One-minute acceptance cutoff, seven-day offer limit, hosted one-hour evidence window and one-day default | [Reply-bet terms](server/src/reply-bets.mjs), [configuration defaults](server/src/config.mjs); the linked live Bet and evidence pages show the hosted deadlines |
| Two-to-ten-model policy, three undecided juries, 80% default, three-second page read, candle coverage and two-minute late-read limits | [Ruling engine](server/src/enclave-ruling.mjs), [configuration](server/src/config.mjs), [evidence intake](server/src/bet-evidence.mjs) and [page extraction pool](server/src/extraction-pool.mjs) |
| Reputation tiers 0.25 / 0.5 / 1 after 0 / 1 / 3 settled bets | [Default tiers](server/src/reputation.mjs) |
| Ten-minute / 600-second deployed window, seven-day DAO proposal period, council/relay accounts, zero keys and frozen policy | [Relay deployment](evidence/jury-relay-deploy-testnet-20261112.json), [Court freeze](evidence/court-harden-testnet-20261112.json); the **Check the chain yourself** commands read current configuration and keys |
| Escrow one-NEAR maximum, 0.01 storage, two-day unanswered proposal and seven-day refund | [Escrow contract constants and methods](contracts/bilateral-escrow/src/lib.rs) |
| Escrow code `Bqr2Tsgy…`, build SHA-256 `57fb29aa…`, testnet/mainnet account versions and zero keys | [Hosted verification](evidence/hosted-court-payout-testnet-20261112.verification.json), [testnet deployment](evidence/escrow-deploy-testnet-20261111.json), [mainnet deployment](evidence/escrow-deploy-mainnet-20261111.json) |
| Deployed relay build SHA-256 `18545bdc…`; rehearsal 60 vs 600 seconds, 21 passing checks | [Relay deployment](evidence/jury-relay-deploy-testnet-20261112.json); [rehearsal steps](evidence/court-relay-live-test-2026-11-12.json), count `steps` and check each `pass` |
| Local relay 0.2.0, 17 Rust tests, two harmless surviving mutants; escrow 71 Rust tests | [Relay manifest](contracts/jury-relay/Cargo.toml), [mutation run](evidence/jury-relay-0.2.0-mutation-run-20261112.json); run the two `cargo test` commands in **Tests** for current counts. Local relay source is not the deployed build |
| 116 cases; 36 yes / 53 no / 27 refunds; individual misses 2 / 1 / 2; earlier 115 correct and no wrong-side payout; four author families | [Current results](evidence/jury-eval-20261112/results-three-makers.json), [earlier results](evidence/jury-eval-20261112/results.json), [case authors and review labels](evidence/jury-eval-20261112/cases.json); tally `results[].jury` for the outcome split |
| Policy-check date; dstack production image 0.5.12 and verifier image 0.6.3; one-byte / half-memory / compose-event tamper tests | [Model policy checks](evidence/jury-models-policy-check-20261112.json), [saved verifier output](evidence/verify-enclave-ruling-3668aa04-20261112.txt), [dstack tamper checks](evidence/dstack-verifier-2026-11-12.json) |
| Node 22.9 minimum, Docker/CI Node 26, PostgreSQL 15+ / container 17, SDK 5.29 and Sputnik v2 | [Package engines](package.json), [CI](.github/workflows/checks.yml), [test database helper](server/test/support/pg.mjs), [test image](Dockerfile.tests), contract manifests above, deployed DAO's `.sputnik-v2.testnet` account |
| Verification exits, three attempts, 250 / 1,000 ms backoff and 20 / 30 / 90-second deadlines | [Verification runner](scripts/verify.mjs), [request transport](scripts/verification-network.mjs), individual verifier CLI exit handling |
| Full-suite tests/pass/fail/skip counts, duration, commit and runtime versions | Latest full-suite record linked in **Tests**; `node scripts/record-test-run.mjs` creates it from the actual PostgreSQL-backed runner output |
| Local ports 4310 / 4311 / 8080, zero demo delay and Docker PostgreSQL version | [Demo Compose](compose.yaml), [demo walkthrough](docs/DEMO.md), verifier Docker command in **Verify a ruling yourself** |
| Video date/name, 0.4 demo payout, earlier live Court's two bets | [Demo run](evidence/hackathon-demo-20261111.json), [video](docs/stated-demo-70s.mp4), [earlier Court check](evidence/court-live-2026-11-12.json) |
| Repository history's 11 November start | `git log --reverse --format='%aI %h'`; pre-git origin and absence of outside participants are the author's account, not independently established by the receipts |

## Limits

The hosted payout records demonstrate functionality with operator-controlled participants and test NEAR, which has no monetary value; no one outside the team has taken a bet yet. One bet has been settled through the relay by the hosted app, `3668aa04`, and both of its sides belong to the operator. The council is one operator account. The server holds unclaimed managed-account keys; claiming an account replaces the server's key with the owner's. Testnet cross-chain quotes are NEAR Intents dry runs and move no funds. The mainnet pilot is allowlisted and has not run; mainnet payout, live cross-chain funding and mobile wallet handoff remain unverified.

## AI assistance

OpenAI Codex and Claude Code helped write the code under the author's direction. Saved test runs and verification commands above define the available evidence.

## Licence

[MIT](LICENSE).
