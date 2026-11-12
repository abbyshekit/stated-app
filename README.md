# Stated

[![checks](https://github.com/abbyshekit/stated-app/actions/workflows/checks.yml/badge.svg)](https://github.com/abbyshekit/stated-app/actions/workflows/checks.yml)

Bet on anything said on X. A NEAR AI enclave jury decides who won, and a NEAR contract pays.

Status on 12 November 2026: running on NEAR testnet with test NEAR. The jury has ruled on a settled bet as a second opinion; no bet has yet been paid on a jury ruling, and the first is due when one of the Court-refereed offers below is taken.

| | |
| --- | --- |
| Tracks | Open Innovation `open`; Privacy & Private AI `privacy`; Social Money `social`; AI Security & Defense `security` |
| Hosted app | https://stated-production.up.railway.app (NEAR testnet, test NEAR) |
| Demo video | [docs/stated-demo-70s.mp4](docs/stated-demo-70s.mp4) (recorded before the jury; a new cut follows the first live jury payout) |
| Quick check | `npm ci`, then `node scripts/verify-enclave-ruling.mjs` and `node scripts/verify-hosted-payout.mjs` |
| Tests | `npm test`: the whole suite with PostgreSQL 15+, otherwise the files that need no database |
| Security | [docs/SECURITY.md](docs/SECURITY.md): a security review of the code and the hosted app, each finding and its fix |

## Try it

Each step says what to do and what you should see. Steps 1 to 6 need no X account, wallet or API key.

1. Open the ruling on a finished real-X bet: https://stated-production.up.railway.app/bets/c171de89-f223-4309-886e-180ad69af092/ruling. This bet was paid at 19:22 UTC on 11 November on a Result a human reviewer recorded; at 03:44 UTC on 12 November the enclave jury, then two Qwen models and DeepSeek, ruled on it as a second opinion and agreed. You see the three verdicts, why each decided, and under "Check it yourself" what was verified and the command that checks it again. No bet has yet been paid on a jury ruling: the first is due when one of the Court-refereed offers below is taken.
2. Run `npm ci && node scripts/verify-enclave-ruling.mjs` (Node 22.9 or later, outbound HTTPS). It re-checks that ruling from outside and ends `28 checks passed, 0 failed, 0 not checked, 1 not applicable` (12 November 2026). The checks cover the Intel TDX quotes back to Intel's root, the Ed25519 signatures over the exact request and response, each model's NVIDIA GPU evidence (a stored NVIDIA-signed verdict checked against NVIDIA's keys, or raw evidence sent to NVIDIA's attestation service), the enclaves' boot measurements against the published dstack image (through a Stated-hosted copy of the official dstack verifier unless you pass your own; the script says which), Intel's TCB status, the Coinbase prices fetched again, and the public page against the signed ruling. The one not-applicable line is the Court proposal check: this bet was made before Stated Court existed.
3. Run `node scripts/verify-hosted-payout.mjs`. It prints `"overall": "PASS"` after two archival RPCs agree: the escrow settled that bet on the reviewer's Result, paid 0.2 test NEAR to the winner's account, and the contract that paid still runs code `Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg` (any other code fails the check) and has no access keys.
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
- **Fail closed.** A call counts only with the signing model's GPU evidence, a dstack verifier that answers, the published production dstack image and an Intel TCB that is up to date. Otherwise it gives no verdict and is retried, and the app will not run rulings at all without a dstack verifier configured. On 12 November 2026 a test call to each of the three current jury models passed this policy, and the full signed records are saved ([evidence](evidence/jury-models-policy-check-20261112.json)); every stored report of the hosted ruling, made by the earlier roster, passed the official verifier: dstack 0.5.12 production images, TCB UpToDate ([evidence](evidence/dstack-verifier-2026-11-12.json)). No bet has yet been ruled by the current roster. Changed by one byte of the quote, half the VM's memory or a different compose-hash event, the same report is rejected, and the verifier names the mismatch (same file).
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

Enclave rulings require `STATED_ENCLAVE_RULINGS=1`, `NEARAI_API_KEY` and `NEARAI_RULING_MODELS` listing at least two distinct models (the hosted jury lists three). `NEARAI_RULING_MIN_CONFIDENCE` defaults to `0.8`. `STATED_REQUIRE_GPU_EVIDENCE` defaults on; only test stacks whose fake NEAR AI has no GPU turn it off. Rulings also need `STATED_DSTACK_VERIFIER_URL`: the app refuses to start them without it (test stacks, whose fake NEAR AI has no GPU, are the exception), and an unreachable verifier fails the call.

The routing model selects a Coinbase product and time window or bettor-submitted evidence. The server builds the Coinbase URLs and fetches the candles; for other claims, fetched page text enters the signed jury request. Pages are read in a worker with a three-second limit. For a claim that something will happen, no credible evidence of it happening by the deadline means No; a claim that it will not happen applies the reverse rule.

All jurors must agree at the threshold. Three completed undecided attempts produce a void and return both stakes; network errors, invalid signatures, failed attestation and empty responses retry separately. With rulings off, a human reviewer records the Result. A saved second opinion on an already settled bet changes neither its Result nor its payout.

New reply bets name `stated-court.sputnik-v2.testnet` as referee, once the server has checked the DAO's network, policy, relay, window and bond; if a check fails, the bet names the server's referee account instead, and its page says so. The server files the jury's ruling through the relay [`jury.stated-court-relay.testnet`](https://testnet.nearblocks.io/address/jury.stated-court-relay.testnet) as a DAO proposal whose only action is the escrow's `referee_resolve`; the proposal's description carries the ruling record's SHA-256, which the verify script checks on chain. The council, `stated-court-18ecdebd.testnet`, can vote the proposal down for 600 seconds. After that the relay approves it and the DAO settles the bet. The relay counts those 600 seconds from the filing, not from the bet's deadline, and the escrow does not check the deadline either: the server is trusted to file only after the deadline, and a filing made early can still be vetoed. The frozen DAO cannot swap its relay, so a court that also checks the deadline on chain would be a new DAO for new bets. Bets made before the DAO existed keep the server's referee account.

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

The hosted jury is three models from three makers, each in its own enclave: Qwen3.8 27B (Qwen), DeepSeek V4.1 Flash (DeepSeek) and GLM-5.3 Flash (Z.ai). On 12 November 2026 NEAR AI Cloud served five open models with an enclave attestation and GPU evidence, from these three makers; the jury takes one from each.

On 116 adversarial cases written by four model families (Gemini 3.1 Pro, GPT-5.6, Claude Opus 5.5, Mistral Large) and kept only where a second family's label agreed, this jury reached the outcome its rules require in all 116: 36 yes, 53 no and 27 refunds ([results-three-makers.json](evidence/jury-eval-20261112/results-three-makers.json)). Alone, the models missed 2, 1 and 2 cases; the every-model-must-agree rule turned each of those into a refund or the right answer. An earlier roster with two Qwen models reached 115; its one miss was a refund where yes was due ([results.json](evidence/jury-eval-20261112/results.json)). No run paid the wrong side. The cases include satire, rumours about public figures, reports dated after the deadline, namesakes, contradicting sources and instructions hidden in the evidence. This measures the models' judgment on text; it does not test the enclave, and the cases are written, not real disputes. The stored ruling on bet `c171de89` was made by the earlier roster, before the three-maker jury.

```sh
NEARAI_API_KEY=... node scripts/jury-eval.mjs evidence/jury-eval-20261112/cases.json
```

The script sends written cases through the production verdict prompt, input builders and unanimity rule, then compares outcomes with each case's `expect`. It defaults to the hosted three-maker jury and 80% confidence, both configurable; it makes live NEAR AI Cloud calls and measures judgment on supplied text only.

## Verify a ruling yourself

```sh
node scripts/verify-enclave-ruling.mjs
# For another public bet with a saved ruling:
node scripts/verify-enclave-ruling.mjs https://stated-production.up.railway.app <bet-id>
# No network? Replay the saved record; checks that need the network say NOT CHECKED (offline):
node scripts/verify-enclave-ruling.mjs --offline evidence/enclave-ruling-c171de89.json
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

The dstack verifier it calls by default is a Stated-hosted instance of the official image, and the script's output says so. To use your own: `docker run -p 8080:8080 ghcr.io/dstack-tee/dstack-verifier:0.6.3`, then pass `--dstack-verifier http://localhost:8080`. Exit `0` means no check failed and none that could be run was left unchecked; `2` means none failed but some could not be checked, each saying why (offline, the run prints 9 passed, 0 failed, 21 not checked); `1` means at least one FAIL. For a ruling decided on submitted links, the linked pages are listed as NOT RE-READ and do not change the exit code. These checks authenticate a record; they do not prove the jury reached the right answer.

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

## Tests

```sh
npm test
cargo test --manifest-path contracts/bilateral-escrow/Cargo.toml --locked
cargo test --manifest-path contracts/jury-relay/Cargo.toml --locked
```

`npm test` runs the whole suite when a throwaway PostgreSQL 15+ cluster can start (`initdb` and `pg_ctl` on PATH): 794 tests passed on 12 November 2026. `STATED_TEST_REQUIRE_PG=1` makes a missing database an error. [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs these commands and `npm audit --omit=dev --audit-level=high` on every push. Server tests use throwaway clusters and a fake X API; they do not establish live X or enclave behaviour. The escrow has 71 Rust tests and the relay 9; both pass `cargo clippy -- -D warnings` and `cargo fmt -- --check`.

## Built during NEAR HACKATHON

All code was written during the hackathon, from 5 November 2026. The public history starts on 11 November because it was copied from a private repository without its unrelated folders. Built with `near-api-js` and `@near-js/*`, the Meteor Wallet SDK, `pg`, `decimal.js`, `@resvg/resvg-js`, `qrcode-generator` and `esbuild`; Rust `near-sdk` 5.29 for both contracts; and the services NEAR AI Cloud, NVIDIA's attestation service, the dstack verifier image 0.6.3, Sputnik DAO v2, Coinbase Exchange's public candles and the X API.

## Evidence files

- [Stated Court freeze](evidence/court-harden-testnet-20261112.json) and [relay deployment](evidence/jury-relay-deploy-testnet-20261112.json); [rehearsal on a test DAO](evidence/court-harden-rehearsal-testnet-20261112.json) with its [21 live checks](evidence/court-relay-live-test-2026-11-12.json).
- [Earlier Stated Court live check](evidence/court-live-2026-11-12.json): two bets on the escrow; one approved and paid, one voted down and left open.
- [Hosted real-X payout](evidence/hosted-real-x-testnet-20261111.json): two operator-controlled identities, 0.1 test NEAR each, 0.2 test NEAR paid after a human-recorded Result; [starting another bet from the Result](evidence/make-a-bet-real-x-20261111.json).
- [dstack verification](evidence/dstack-verifier-2026-11-12.json) of the hosted ruling, with the tamper checks.
- [Existing recording](docs/stated-demo-70s.mp4); [simulated-X run with a 0.4 test NEAR payout](evidence/hackathon-demo-20261111.json); [funded Docker run](evidence/funded-judge-testnet-20261111.json); [web acceptance and payout](evidence/web-take-testnet-20261111.json).

## Limits

The hosted payout record demonstrates functionality with operator-controlled participants and test NEAR, which has no monetary value; no one outside the team has taken a bet yet. No bet has yet been settled through the relay by the hosted app: the first is due when one of the Court-refereed offers above is taken. The council is one operator account. The server holds unclaimed managed-account keys; claiming an account replaces the server's key with the owner's. Testnet cross-chain quotes are NEAR Intents dry runs and move no funds. The mainnet pilot is allowlisted and has not run; mainnet payout, live cross-chain funding and mobile wallet handoff remain unverified.

## AI assistance

OpenAI Codex and Claude Code helped write the code under the author's direction. Saved test runs and verification commands above define the available evidence.

## Licence

[MIT](LICENSE).
