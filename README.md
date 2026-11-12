# Stated

Bet on anything said on X. A NEAR AI enclave jury decides who won, and a NEAR contract pays.

| | |
| --- | --- |
| Tracks | Open Innovation `open`; Privacy & Private AI `privacy`; Social Money `social`; AI Security & Defense `security` |
| Hosted app | https://stated-production.up.railway.app |
| Demo video | [docs/stated-demo-70s.mp4](docs/stated-demo-70s.mp4) (recorded before the jury; a new cut follows the first live jury payout) |
| 30-second check | `npm ci && node scripts/verify-hosted-payout.mjs`<br>`node scripts/verify-enclave-ruling.mjs` |
| Tests | `npm test` (659 tests on 12 November 2026) |

The payout check verifies a recorded test NEAR transfer from two public RPC endpoints. The enclave check verifies the jury's signed second opinion on the same real-X Bet: on 12 November 2026 it printed 14 checks passed, 0 failed, 5 not checked. Read the ruling as a page: https://stated-production.up.railway.app/bets/c171de89-f223-4309-886e-180ad69af092/ruling

## How it works

1. Reply under a post with `@statedforecast bet 0.1 yes`; your reply may supply its own deadline, such as `bet 0.1 yes by 30 nov`.
2. Someone takes the other side by replying `take` or on the Bet's page, without bringing a wallet: Stated creates a named NEAR account per X handle.
3. After the deadline, an enclave model chooses where the answer comes from: Coinbase price candles, or links the bettors submit by replying `yes <link>` / `no <link>` or on the Bet's page.
4. With three models configured and the default 80% confidence threshold, every juror in NEAR AI Cloud enclaves must agree on Yes or No at that confidence or more, or both stakes go back after the undecided retries.
5. After the default ten-minute correction window, the referee worker sends the Result to escrow and withdraws the winner's payout for an unclaimed managed account.

## Why each track

### Privacy & Private AI (`privacy`)

Every production jury call runs on NEAR AI Cloud in an Intel TDX enclave: the app fetches an attestation with a fresh nonce, verifies the gateway and signing model's TDX quote chains to Intel's pinned root and their signing-key/nonce bindings, and verifies the response signature over the exact request and response hashes. The **Verified** panel at `/bets/<id>/ruling` shows these checks; measurements against a published list, TCB level and revocation, GPU attestation and event-log replay remain unchecked.

### AI Security & Defense (`security`)

The AI decides an outcome but holds no keys: the contract lets the named referee choose only Yes, No or Void, stakes can go only to the two bettors, and the deployed testnet contract has no access keys. The application settles a jury Result only for a Bet named in its signed ruling with its terms hash; the contract itself trusts the referee and does not verify enclave signatures.

### Social Money (`social`)

Bets happen between people in the thread where the argument happened, using NEAR accounts named for their X handles. Published Bet pages record who took each side and the Result.

### Open Innovation (`open`)

The Node.js/PostgreSQL app joins X reply intake, evidence-backed Results and Rust escrow on NEAR, with a Docker walkthrough and public verification scripts.

## Who decides the result

Enclave rulings require `STATED_ENCLAVE_RULINGS=1`, `NEARAI_API_KEY` and `NEARAI_RULING_MODELS` listing at least two distinct models. The three-model flow above requires a three-model roster; the engine accepts two to ten, and `NEARAI_RULING_MIN_CONFIDENCE` defaults to `0.8`.

The routing model selects a Coinbase product and time window or bettor-submitted evidence. The server builds the Coinbase URLs and fetches the candles; for other claims, the evidence window defaults to a day after the deadline, and fetched page text enters the signed jury request. For a claim that something will happen, no credible evidence of it happening by the deadline means No; a claim that it will not happen applies the reverse rule.

All jurors must agree at the configured confidence threshold. Three completed undecided attempts produce a void and return both stakes; network errors, invalid signatures and empty responses retry separately. A reviewer can correct the Result during the settlement delay, and the Bet page identifies a correction. With rulings off, a human reviewer records the Result. A saved second opinion on an already settled Bet changes neither its Result nor its payout.

Known limits: Coinbase evidence may omit up to a tenth of a segment's candles; moment claims use the minute's opening price, and range boundaries round outward to whole minutes. Submitted pages are read once, with late reads allowed up to two minutes after evidence closes; signed text establishes what the jury read, not the source's truth or the verdict's correctness. The attestation exclusions are listed above.

## How good is the jury

On 116 adversarial cases written by four model families (Gemini 3.1 Pro, GPT-5.6, Claude Opus 5.5, Mistral Large) and kept only where a second family's label agreed, the three-model jury reached the outcome its rules require in 115 (run of 12 November 2026: 36 yes, 53 no, 27 refunds expected). The one miss was a refund where yes was due: all three models said yes, one with 60% confidence, below the 80% bar. No case paid the wrong side. Alone, the models missed 2, 4 and 0 cases; the every-model-must-agree rule turned each of those into a refund or the right answer. The cases include satire, rumours about public figures, reports dated after the deadline, namesakes, contradicting sources and instructions hidden in the evidence. Cases and every verdict: [evidence/jury-eval-20261112](evidence/jury-eval-20261112). This measures the models' judgment on text; it does not test the enclave, and the cases are written, not real disputes.

```sh
NEARAI_API_KEY=... node scripts/jury-eval.mjs evidence/jury-eval-20261112/cases.json
```

The cases file is not present in this checkout yet. The script sends written cases through the production verdict prompt, input builders and unanimity rule, then compares outcomes with each case's `expect`: correct decisions, wrong winners, unnecessary refunds, payouts where a refund was expected, and failed calls. It defaults to three models and 80% confidence, both configurable; it measures judgment on supplied text, excluding routing, evidence fetching, attestation/signature checks, settlement and payout. It makes live NEAR AI Cloud calls; an optional second output-path argument saves per-model results including latency.

## Verify a ruling yourself

With Node.js 22.9 or later, dependencies installed and outbound HTTPS:

```sh
node scripts/verify-enclave-ruling.mjs
# For another public Bet with a saved ruling:
node scripts/verify-enclave-ruling.mjs https://stated-production.up.railway.app <bet-id>
```

The script reads `/bets/<id>/enclave-ruling.json` and prints a status per check:

| Output | Check |
| --- | --- |
| Arguments | Origin and Bet ID are valid. |
| Signed ruling / Intel TDX quotes | Exact-byte hashes and Ed25519 signatures verify; gateway and signing-model quotes chain to Intel's root and bind signing keys and nonces. |
| Bet coverage / Jury policy / Signed model verdict | The signed material names the Bet and terms hash; the roster, confidence threshold and verdicts produce the recorded outcome. |
| Quote measurements / Attestation limits | Measurements are printed as NOT CHECKED, together with the excluded hardware checks. |
| Coinbase source / Coinbase evidence hash | Every candle URL is fetched again and rebuilt evidence matches its signed hash; unavailable sources are NOT CHECKED. |
| Submitted evidence / Evidence link | NOT RE-READ: prints the side, final URL, posted URL when different, and stored text hash. |
| Public claim / Public deadline / Public terms hash / Public outcome | Compares the Bet page with the signed ruling; a missing page terms hash or pending settlement is NOT CHECKED. |

Exit `1` means at least one FAIL; exit `0` can still include NOT CHECKED or NOT RE-READ. A missing or private ruling returns HTTP 404 and fails verification. These checks authenticate a record; they do not prove the jury reached the right answer.

## Run locally with Docker

```sh
docker compose up --build
```

Wait for `Ready:`, then open Stated at `http://127.0.0.1:4310` and simulated X at `http://127.0.0.1:4311`. Browsing and prediction capture need no X account, API key or wallet; reply Bets use real NEAR testnet and need outbound RPC access plus a funded treasury, provisioned through the faucet when available.

Check `/demo-readiness`, then try `/demo-challenge`; `/demo-proof` rechecks the recorded testnet payout without funding a new Bet. Docker uses human-recorded Results and a zero settlement delay, so it does not demonstrate the enclave jury. [Walkthrough](docs/DEMO.md) · [Funded treasury fallback](docs/DEMO.md#use-a-funded-testnet-treasury)

`docker compose down` keeps data; `docker compose down -v` deletes it. For a connected deployment, use [.env.example](.env.example) and [deployment instructions](docs/DEPLOY.md); X callbacks and bot credentials must match that deployment.

## The contract

[bilateral-escrow](contracts/bilateral-escrow/src/lib.rs) holds equal stakes and stores hashed terms. Settlement creates withdrawal credit; a separate withdrawal and successful callback establish delivery. Stakes are greater than zero and at most one test NEAR on testnet; the creator also pays 0.01 test NEAR for storage, which is excluded from stake refunds.

The Docker stack uses version 2 at `stated-escrow-52081551be.testnet`. [Recorded testnet](evidence/escrow-deploy-testnet-20261111.json) and [mainnet](evidence/escrow-deploy-mainnet-20261111.json) deployments also show version 2 with zero access keys. Without a referee, an agreed result settles; an unanswered proposal can stand after two days, and unresolved accepted/disputed Bets can refund seven days after the resolution date.

## Tests

`npm test` requires Node.js 22.9+ and PostgreSQL 15+ tools, including `initdb` and `pg_ctl` on PATH. Server tests use throwaway PostgreSQL clusters and a fake X API; they do not establish live X or enclave behavior.

```sh
npm test
cargo test --manifest-path contracts/bilateral-escrow/Cargo.toml --locked
cargo clippy --manifest-path contracts/bilateral-escrow/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path contracts/bilateral-escrow/Cargo.toml -- --check
```

## Evidence files

- [Hosted real-X payout](evidence/hosted-real-x-testnet-20261111.json): two operator-controlled identities, 0.1 test NEAR each, 0.2 test NEAR paid after a human-recorded Result; [starting another Bet from the Result](evidence/make-a-bet-real-x-20261111.json).
- [Existing recording](docs/stated-demo-70s.mp4); [earlier simulated-X run with a 0.4 test NEAR payout](evidence/hackathon-demo-20261111.json); [funded Docker run](evidence/funded-judge-testnet-20261111.json).
- [Default faucet run](evidence/default-faucet-judge-20261111.json) and [signed-out practice round](evidence/practice-judge-testnet-20261111.json).
- [Web acceptance and payout](evidence/web-take-testnet-20261111.json) and [simulated reply handoff](evidence/reply-link-testnet-20261111.json).

`node scripts/verify-hosted-payout.mjs` reads the hosted payout evidence file and checks finalized escrow state, the exact referee call, winner transfer and linked successful callback through two fixed public testnet RPCs. It submits no transactions and needs no account or API key; exit codes are `0` for agreement, `1` for mismatch and `2` for unavailability. It corroborates RPC responses without a light-client proof and does not check X identities or the human outcome decision.

## Limits

The hosted payout record demonstrates functionality with operator-controlled participants and test NEAR, which has no monetary value. The server holds unclaimed managed-account keys; claiming an account replaces the server's key with the owner's, after which the owner signs withdrawals. The jury has no signing authority over funds, but the application and referee remain trusted.

Testnet cross-chain quotes are NEAR Intents dry runs and move no funds. The mainnet pilot is allowlisted; mainnet payout, live cross-chain funding and actual mobile wallet handoff remain unverified. Local simulated X and a successful unit test do not establish those results.

## AI assistance

OpenAI Codex and Claude Code helped write the code under the author's direction. Saved test runs and verification commands above define the available evidence.

## Licence

[MIT](LICENSE).
