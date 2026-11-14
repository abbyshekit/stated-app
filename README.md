# Stated

Stated turns a claim on X into a bet between two people: a NEAR contract with no access keys holds both stakes, a jury of three AI models from three makers rules, and the winner is paid.

Built at NEAR HACKATHON, November 2026. [Code and library disclosure](JUDGE.md#hackathon-disclosure).

## Proven on mainnet

Keyless escrow `escrow.statedforecast.near` and referee `referee.statedforecast.near` ruled and paid two bets on 14 November 2026, one Yes and one No, between our own accounts. [Evidence](evidence/mainnet-demo-20261114.json).

After `npm ci`, run `node scripts/verify-mainnet-demo.mjs`. Its exact last line is `PASS mainnet demo: 2/2 cases; 15/15 checks`. This mainnet path does not verify per-model enclave attestation.

## Proven on testnet

The testnet three-model enclave jury is proven with verified Intel TDX quotes, NVIDIA GPU evidence and response signatures. `npm run verify` replays saved evidence, checks testnet ruling `0bf4f3a7-8dfc-44e2-a139-1e33ce844178` and checks the earlier `3668aa04` Court payout; the live ruling ends `37 checks passed, 0 failed, 0 not checked`, then the runner ends `final: PASS (3 verification steps)`. [Judge steps](JUDGE.md#start-here).

[Mainnet app](https://stated-mainnet-production.up.railway.app/) · [Demo page](https://stated-mainnet-production.up.railway.app/demo) · [Mainnet video](docs/stated-demo-mainnet.mp4)

Tracks: Open Innovation `open`; Privacy & Private AI `privacy`; Social Money `social`; AI Security & Defense `security`. [Proof by track and network](#why-each-track).

## Check it yourself

The mainnet trials use IANA documentation-domain claims, with both sides held by the team; each paid 0.2 NEAR to the same team wallet. [Public demo post](https://x.com/statedforecast/status/2121639324454424641). The separate [X test thread](https://x.com/AbhishekEsq/status/2121456040327922071) reached review and expired unfunded. The video stops before funding a new stake.

The [testnet app](https://stated-production.up.railway.app/), [earlier video](docs/stated-demo-live-testnet.mp4) and [signed ruling checks](JUDGE.md#verify-the-demo-bet) cover the Stated Court path. They do not establish who controls the participating X handles.

| | |
| --- | --- |
| Tracks | [Proof by track and network](#why-each-track) |
| Hosted app | [Mainnet](https://stated-mainnet-production.up.railway.app/) · [Testnet](https://stated-production.up.railway.app/) |
| Demo | [Mainnet outcomes and withdrawals](https://stated-mainnet-production.up.railway.app/demo) · [Earlier testnet video](docs/stated-demo-live-testnet.mp4) |
| Judge path | [JUDGE.md](JUDGE.md): read-only; `node scripts/verify-mainnet-demo.mjs` checks both mainnet payouts through public NEAR RPC |
| Quick check | `npm ci`, then `npm run verify`: testnet `0bf4f3a7` signed ruling and earlier `3668aa04` Court payout; last line `final: PASS (3 verification steps)`. Without network, `npm run verify:offline` |
| Tests | `npm test`: the whole suite with PostgreSQL 15+, otherwise the files that need no database |
| Security | [docs/SECURITY.md](docs/SECURITY.md): automated review of commit `847c720` (12 November 2026); later changes, including the mainnet OutLayer path, were outside this review |
| Terms and privacy | Mainnet [Terms](https://stated-mainnet-production.up.railway.app/terms) and [Privacy](https://stated-mainnet-production.up.railway.app/privacy); testnet [Terms](https://stated-production.up.railway.app/terms) and [Privacy](https://stated-production.up.railway.app/privacy) |

The GPU check tries NVIDIA’s live keys first. If a token’s signing key has rotated out, it uses `evidence/nvidia-jwks-snapshot-20261114.json` after verifying that key’s certificate chain, and prints which source matched.

## Try it

New real-NEAR bets are open, up to 1 NEAR per bet, subject to the [mainnet terms](https://stated-mainnet-production.up.railway.app/terms).

1. Open the [mainnet app](https://stated-mainnet-production.up.railway.app/), type a claim with a deadline, stake and side, and choose **Review bet**.
2. Sign in with X. The review shows the prepared terms, stake and dates before any wallet signature. Correct them there if needed.
3. Connect a wallet to fund the reviewed offer. Share its bet link so someone can take the other side.
4. For a read-only demonstration, open [Demo](https://stated-mainnet-production.up.railway.app/demo) and follow either withdrawal link. Run `node scripts/verify-mainnet-demo.mjs` to recheck both outcomes.

[Earlier testnet walkthrough and historical offers](docs/TESTNET-HISTORY.md#earlier-testnet-walkthrough).

## How it works

On mainnet, type the sentence in the app or tag `@statedforecast` on X with the claim, deadline, stake and side. The app prepares an unsigned draft. Review it, connect a wallet and fund the offer; the shared bet link lets another bettor escrow the opposite stake. After the deadline and evidence window, the OutLayer jury runs the three configured models. Unanimous Yes or No verdicts at the confidence threshold settle the escrow; an undecided jury retries, with a refund after the configured limit. Withdrawal moves the winning credit from escrow to the winning account. [OutLayer design](docs/OUTLAYER.md)

The earlier testnet Court flow works as follows:

1. Reply under a post with `@statedforecast bet 0.1 yes`; the reply may carry its own deadline, such as `bet 0.1 yes by 30 nov`.
2. Someone takes the other side by replying `take` or on the bet's page, without bringing a wallet: Stated creates a named NEAR account per X handle, and a Rust escrow contract holds both stakes.
3. After the deadline, an enclave model chooses where the answer comes from: Coinbase price candles, or links the two bettors submit by replying `yes <link>` / `no <link>` or on the bet's page (on the hosted app, for an hour after the deadline; the bet's evidence page shows when links close; the code default is a day).
4. On the hosted app, three models from three makers, each in its own NEAR AI Cloud enclave, must all agree on Yes or No at 80% confidence or more (the engine takes two to ten models). If they do not, the jury tries again, and after three undecided juries both stakes go back.
5. The ruling becomes a proposal in Stated Court. The council can vote it down for ten minutes; after that anyone can trigger the relay's approval, and the DAO settles the escrow. For an account whose key Stated still holds, the winner's payout is withdrawn to it automatically; a person who has claimed their account withdraws with their own wallet.

## Why NEAR

- **Native NEAR escrow:** the Rust contract holds equal stakes, credits settlement and pays only the withdrawing bettor ([contract](contracts/bilateral-escrow/src/lib.rs)).
- **Keyless contracts:** the mainnet escrow and OutLayer referee have zero access keys, preventing key-based code replacement ([checks](JUDGE.md#verify-the-mainnet-demo)).
- **OutLayer:** a pinned jury program calls the three models and returns the result to the mainnet referee, which settles the escrow ([jury](outlayer/stated-jury/src/lib.rs), [referee](contracts/outlayer-referee/src/lib.rs)).
- **NEAR AI Cloud and Sputnik DAO on testnet:** attested inference supplies the signed jury record; the DAO and keyless relay enforce the veto window before settlement ([ruling engine](server/src/enclave-ruling.mjs), [relay](contracts/jury-relay/src/lib.rs)).

## Why each track

| Track | What it asks for | Where to see it |
| --- | --- | --- |
| Privacy & Private AI | Attestation verified end to end on the testnet Court path; mainnet OutLayer runs a pinned jury but does not verify per-model attestation | [The ruling page](https://stated-production.up.railway.app/bets/3668aa04-7009-4b85-b19d-debfabebbf96/ruling): each model's verdict, then "Check it yourself"; `npm run verify` re-checks it from outside |
| AI Security & Defense | Mainnet: keyless escrow and referee. Testnet: keyless relay and Court | The [jury relay](contracts/jury-relay/src/lib.rs) can only file one `referee_resolve` per bet and approve it ten minutes later; the [escrow](contracts/bilateral-escrow/src/lib.rs) has no access keys; stake ceilings of 0.25, 0.5 and 1 test NEAR follow settled bets |
| Social Money: Sputnik DAO | Shared rules on a DAO | [Stated Court](https://stated-production.up.railway.app/court), a Sputnik DAO with a frozen policy ([freeze record](evidence/court-harden-testnet-20261112.json)) |
| Social Money: named accounts | Readable accounts | Each X handle gets one, such as [`chainabstracted.stated-play-6cf0876dd7.testnet`](https://testnet.nearblocks.io/address/chainabstracted.stated-play-6cf0876dd7.testnet) |
| Social Money: reputation-based access | Access that grows with reputation | Stake ceilings rise with settled bets ([code](server/src/reputation.mjs)) |
| Social Money: Trezu | | Not used |
| Open Innovation | A claim on X becomes a funded bet | Mainnet: OutLayer jury and keyless escrow. Testnet: attested jury, DAO veto and keyless escrow |

### Privacy & Private AI (`privacy`)

- **Confidential computation on testnet.** Every Court jury call runs in an Intel TDX enclave on NEAR AI Cloud. The app fetches an attestation with a fresh nonce, verifies the gateway's and signing model's quotes back to Intel's pinned root and their key and nonce bindings, checks each model's NVIDIA GPU evidence with NVIDIA's attestation service, replays the event log against RTMR3, and verifies the response signature over the exact request and response bytes.
- **Fail closed.** A call counts only with the signing model's GPU evidence, a dstack verifier that answers, the published production dstack image and an Intel TCB that is up to date. Otherwise it gives no verdict and is retried. The app refuses to start rulings without a dstack verifier, and it refuses the switch that turns GPU evidence off for any NEAR AI host but a local or `.test` fake, so only test stacks can use it. On 12 November 2026 a test call to each of the three current jury models passed this policy, and the full signed records are saved ([evidence](evidence/jury-models-policy-check-20261112.json)); the current roster then ruled on bet `3668aa04`, and every one of its reports matched the published dstack 0.5.12 production images with an Intel TCB that is up to date (the verify script's output in Try it, step 2, checked through a Stated-hosted copy of the official verifier image). The earlier roster's reports on `c171de89` passed the same checks ([evidence](evidence/dstack-verifier-2026-11-12.json)). Changed by one byte of the quote, half the VM's memory or a different compose-hash event, the same report is rejected, and the verifier names the mismatch (same file).
- **Data stays where it belongs.** The escrow stores only a salted fingerprint of a bet's terms; the claim and notes stay off chain. A private bet's page, evidence and ruling are not public, and a post's shared Result never carries a private bet's evidence or a juror's reason about it.

### AI Security & Defense (`security`)

- **The AI holds no keys.** For a bet that names Stated Court, a jury ruling reaches the escrow only through the [jury relay](contracts/jury-relay/src/lib.rs) and the DAO. The relay's operator can only file a `referee_resolve` for one bet and outcome; the relay approves only its own filing, exactly as filed, ten minutes after the DAO recorded it (the window is fixed at deployment: 600 seconds). The escrow lets its referee choose only Yes, No or Void between the two bettors; it also settles when both bettors agree, and refunds both stakes seven days after the deadline if nothing settled. Bets made before the Court name the server's referee account. Neither contract has an access key or an upgrade path.
- **Spending limits that follow reputation.** A new handle can stake at most 0.25 test NEAR; after one settled bet, 0.5; after three, 1.
- **Testnet TEE attestation, checked twice.** Inside the Court path before a verdict counts, and from outside by anyone with the verify script. Mainnet OutLayer does not verify per-model attestation.
- **Review scope.** The automated security review covers commit `847c720` on 12 November 2026; later changes, including the mainnet OutLayer path, were not reviewed by this process. The review found a crash, a page-parsing denial of service, an escrow that a deleted post could orphan, a court that one key could run and a private-evidence leak. Each is fixed with a test; see [docs/SECURITY.md](docs/SECURITY.md).

### Social Money (`social`)

- **Sputnik DAO on testnet.** [Stated Court](https://stated-production.up.railway.app/court) holds the referee seat of new bets. Its council can veto a ruling; nobody, including the operator, can approve one early or change the court's rules ([freeze record](evidence/court-harden-testnet-20261112.json)).
- **Named accounts.** Each X handle gets a NEAR account named for it, such as `chainabstracted.stated-play-6cf0876dd7.testnet`.
- **Reputation-based access.** Stake ceilings rise with each handle's settled bets.
- Bets happen between people in the thread where the argument happened, and published bet pages record who took each side and the Result.

### Open Innovation (`open`)

A Node.js and PostgreSQL app joins X reply intake, a jury of enclave models that reads evidence from both sides, a Sputnik DAO court and Rust escrow on NEAR, with a Docker walkthrough and scripts that re-check the hosted ruling, its payout and the contracts' code and keys from public sources.

## Who decides the result

This section describes the earlier signed testnet Court flow. The hosted mainnet app uses the [OutLayer referee and jury](docs/OUTLAYER.md), with [completed Yes and No payout checks](JUDGE.md#verify-the-mainnet-demo).

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

The testnet Court jury is three models from three makers, each in its own enclave: Qwen3.8 27B (Qwen), DeepSeek V4.1 Flash (DeepSeek) and GLM-5.3 Flash (Z.ai). The [saved policy check](evidence/jury-models-policy-check-20261112.json) covers a call to each on 12 November 2026.

On 116 adversarial cases written by four model families (Gemini 3.1 Pro, GPT-5.6, Claude Opus 5.5, Mistral Large) and kept only where a second family's label agreed, this jury reached the outcome its rules require in all 116: 36 yes, 53 no and 27 refunds ([results-three-makers.json](evidence/jury-eval-20261112/results-three-makers.json)). Alone, the models missed 2, 1 and 2 cases; the every-model-must-agree rule turned each of those into a refund or the right answer. An earlier roster with two Qwen models reached 115; its one miss was a refund where yes was due ([results.json](evidence/jury-eval-20261112/results.json)). No run paid the wrong side. The cases include satire, rumours about public figures, reports dated after the deadline, namesakes, contradicting sources and instructions hidden in the evidence. This is a drill on written text: it does not test the enclave, and the cases are not real disputes. Recorded testnet Court payouts include `3668aa04` and [`0bf4f3a7`](evidence/hosted-demo-payout-testnet-20261113.json); the [mainnet trials](evidence/mainnet-demo-20261114.json) are two OutLayer rulings between our own accounts, both paid; the stored second opinion on the earlier bet `c171de89` was made by the two-Qwen roster.

The evaluation uses live NEAR AI Cloud calls and supplied text only; [rerun instructions](docs/TESTNET-HISTORY.md#jury-evaluation-reference) require a funded API account.

## Verify a ruling yourself

```sh
npm run verify
# No network? Run only the saved-record replay:
npm run verify:offline
# Check the current testnet demo ruling:
node scripts/verify-enclave-ruling.mjs https://stated-production.up.railway.app 0bf4f3a7-8dfc-44e2-a139-1e33ce844178
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

The dstack verifier it calls by default is a Stated-hosted instance of the official image, and the script's output says so. An independently hosted official verifier can be selected with `--dstack-verifier`; see [deployment guidance](docs/DEPLOY.md). Exit `0` means no check failed and none that could be run was left unchecked; `2` means none failed but some could not be checked, each saying why (offline, the run prints 17 passed, 0 failed, 21 not checked); `1` means at least one FAIL. For a ruling decided on submitted links, the linked pages are listed as NOT RE-READ and do not change the exit code. These checks authenticate a record; they do not prove the jury reached the right answer.

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

[Docker walkthrough and prerequisites](docs/DEMO.md). It uses simulated X, a funded NEAR testnet treasury and human-recorded Results; it does not demonstrate the enclave jury.

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

`npm test` runs the whole suite when a throwaway PostgreSQL 15+ cluster can start (`initdb` and `pg_ctl` on PATH); otherwise it names the database test files it skipped. The runner prints the test/pass/fail/skip counts. `STATED_TEST_REQUIRE_PG=1` makes a missing database an error. [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs these commands and `npm audit --omit=dev --audit-level=high` on every push. Server tests use throwaway clusters and a fake X API; they do not establish live X or enclave behaviour. The escrow has 71 Rust tests and the relay 17; run the contract commands above for their current counts, and use clippy and rustfmt with each manifest to check lint and format.

A full-suite record identifies the commit it tested, its runtime versions and the actual counts; it does not cover later commits.

<!-- test-run-record -->Historical full-suite record (12 November 2026, private commit `ca6d0d03cfab581c2e61b6ea8a746fc3d542dd81`, not the submission commit): [test-run-ca6d0d03cfab.json](evidence/test-run-ca6d0d03cfab.json) (passed).

Main’s successful [checks run](https://github.com/abbyshekit/stated-app/actions/runs/43616223473) covers `9a17e8ebf2660bce2ae07a9740ffc408a0d4e99d` on 14 November 2026: PostgreSQL-backed app tests, production dependency audit, escrow/relay Rust tests, clippy and format. Its successful [Judge run](https://github.com/abbyshekit/stated-app/actions/runs/43616223461) ran offline verification, judge tests and OutLayer referee/jury Rust tests; the live mainnet job was skipped. These runs do not cover later commits.

## Built during NEAR HACKATHON

The author reports that project code was written during the hackathon, beginning on 5 November 2026 in a folder without version control, with no pre-hackathon project code. Git establishes the public history’s start on 11 November, rather than the earlier working-folder date. The public repository was copied from the private working repository without unrelated folders. Built with `near-api-js` and `@near-js/*`, the Meteor Wallet SDK, `pg`, `decimal.js`, `@resvg/resvg-js`, `qrcode-generator` and `esbuild`; Rust `near-sdk` 5.29 for both contracts; and the services NEAR AI Cloud, NVIDIA's attestation service, the dstack verifier image 0.6.3, Sputnik DAO v2, Coinbase Exchange's public candles and the X API.

## Evidence files

- [Jury ruling on bet 3668aa04](evidence/enclave-ruling-3668aa04.json): the signed record the Court proposal anchors, with each model's GPU and dstack evidence, and [the verify script's output](evidence/verify-enclave-ruling-3668aa04-20261112.txt) on it.
- [Court payout of bet 3668aa04](evidence/hosted-court-payout-testnet-20261112.json): the X posts, every transaction from offer to withdrawal, the three approvals the relay refused before its window ended, and the referee account's top-up; [verifier output](evidence/hosted-court-payout-testnet-20261112.verification.json).
- [Stated Court freeze](evidence/court-harden-testnet-20261112.json) and [relay deployment](evidence/jury-relay-deploy-testnet-20261112.json); [rehearsal on a test DAO](evidence/court-harden-rehearsal-testnet-20261112.json) with its [21 live checks](evidence/court-relay-live-test-2026-11-12.json).
- [Earlier Stated Court live check](evidence/court-live-2026-11-12.json): two bets on the escrow; one approved and paid, one voted down and left open.
- [Hosted real-X payout](evidence/hosted-real-x-testnet-20261111.json): two operator-controlled identities, 0.1 test NEAR each, 0.2 test NEAR paid after a human-recorded Result; [starting another bet from the Result](evidence/make-a-bet-real-x-20261111.json).
- [dstack verification](evidence/dstack-verifier-2026-11-12.json) of the hosted ruling, with the tamper checks.
- [Existing recording](docs/stated-demo-70s.mp4); [simulated-X run with a 0.4 test NEAR payout](evidence/hackathon-demo-20261111.json); [funded Docker run](evidence/funded-judge-testnet-20261111.json); [web acceptance and payout](evidence/web-take-testnet-20261111.json).

## Where each number comes from

The [provenance table](docs/TESTNET-HISTORY.md#where-each-number-comes-from) retains the historical testnet evidence. Mainnet amounts and outcomes come from [mainnet-demo-20261114.json](evidence/mainnet-demo-20261114.json). The current testnet demo payout comes from [hosted-demo-payout-testnet-20261113.json](evidence/hosted-demo-payout-testnet-20261113.json).

## Limits

The mainnet video shows real-NEAR payouts between our own accounts. The earlier testnet video uses test NEAR, which has no monetary value; its receipts establish wallets and delivery, while control of the X handles remains unverified.

One operator account serves as the testnet Court council. The server holds the keys for unclaimed managed wallets until their owners claim the accounts and replace those keys. Live cross-chain funding and mobile wallet handoff remain unverified.

## AI assistance

OpenAI Codex and Claude Code helped write the code under the author's direction. Saved test runs and verification commands above define the available evidence.

## Licence

[MIT](LICENSE).
