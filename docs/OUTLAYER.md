# Stated OutLayer referee and jury

Stated can settle a bet without a Stated-controlled key. A keyless NEAR contract (the **referee**) is named as the referee in the escrow. To rule, it asks [OutLayer](https://app.outlayer.ai) to run a pinned WebAssembly program (the **jury**). The jury fetches the committed evidence, asks three NEAR AI Cloud models, and returns a result. The referee checks the result's internal consistency and tells the escrow to pay Yes, No or Void. If no ruling happens, anyone can refund both stakes seven days after the deadline.

**Status, 14 November 2026.** The mainnet referee is deployed with zero access keys. Two operator-controlled bets completed the OutLayer jury, one Yes and one No, and each winner withdrew 0.2 NEAR. The [public demo](https://stated-mainnet-production.up.railway.app/demo) shows the outcomes and withdrawal links. `node scripts/verify-mainnet-demo.mjs` passed 15 public-data checks; [saved evidence](../evidence/mainnet-demo-20261114.json) records the run. It does not independently verify model attestation. [Remaining limits](#not-yet-proven) distinguish these completed trials from untested cases.

Source: referee [contracts/outlayer-referee/src/lib.rs](../contracts/outlayer-referee/src/lib.rs), jury [outlayer/stated-jury/src](../outlayer/stated-jury/src), server [server/src/outlayer.mjs](../server/src/outlayer.mjs).

## Contents

1. [Components and flow](#components-and-flow)
2. [Trust model](#trust-model)
3. [Commitment and registration](#commitment-and-registration)
4. [Evidence kinds](#evidence-kinds)
5. [Lifecycle, nonces and counters](#lifecycle-nonces-and-counters)
6. [Jury runtime](#jury-runtime)
7. [Storage and costs](#storage-and-costs)
8. [Reproducible builds](#reproducible-builds)
9. [Deployment](#deployment)
10. [Checking a deployment and a bet](#checking-a-deployment-and-a-bet)
11. [Live evidence so far](#live-evidence-so-far)
12. [Not yet proven](#not-yet-proven)

## Components and flow

| Component | What it is |
| --- | --- |
| Escrow | The existing bilateral escrow. It holds both stakes and pays only the two participants. It accepts a Yes/No/Void decision from the referee named in the bet, at any time while the bet is active. Anyone can call `refund_unresolved` once seven days have passed since the deadline. |
| Referee (`contracts/outlayer-referee`) | Immutable NEAR contract. Configuration is fixed at `new`: escrow, OutLayer account (`outlayer.testnet` or `outlayer.near`), jury URL, jury SHA-256, secrets owner and secrets profile. It has no owner, no upgrade method, no setter and no outcome input. |
| Jury (`outlayer/stated-jury`) | A WASI Preview 2 command component. It reads one `ExecutionInput` from stdin (at most 32,768 bytes), fetches evidence, calls the model roster and prints one JSON result. It has no custody, storage or signing capability. |
| OutLayer | Off-chain compute with an on-chain request/resume interface. It runs the jury whose SHA-256 the referee passes and releases the encrypted `NEARAI_API_KEY` secret to it. |
| NEAR AI Cloud | The inference provider the jury calls (`https://cloud-api.near.ai/v1/chat/completions`). |
| Stated server | Creates the commitment, pays registration storage and keeper gas from a treasury, and shows rulings. It never chooses an outcome. |

```text
register_material -> (evidence window, Open bets) -> request_ruling
  -> escrow.get_bet -> OutLayer.estimate_execution_cost -> OutLayer.request_execution
  -> jury runs -> on_ruling (validates the result)
  -> escrow.referee_resolve(yes | no | void) -> on_settled
```

Callers of `request_ruling` pay gas. A shared compute pool inside the referee pays OutLayer. NEAR contracts do not wake themselves, so a keeper (the Stated server, or anyone) must send each request and retry.

## Trust model

### Who can do what

| Actor | Can | Cannot |
| --- | --- | --- |
| Anyone | Hash material with the `terms_hash` view. Register material, but only material that matches the hash already stored in the escrow bet. Donate to the compute pool with `fund_compute`. Call `request_ruling` when the bet is due. Call the escrow's `refund_unresolved` after seven days. | Supply an outcome, change configuration, withdraw donations. |
| The two bettors | Submit evidence links to an Open bet. The referee derives each caller's side from the escrow record; a caller cannot choose a side or submit for another account. Settle by agreement through the escrow, as before. | Submit after the window, exceed the per-side limit, or submit when not a participant. |
| Referee contract | Call the escrow with `referee_resolve` (yes, no or void) after a result passes its checks or a documented Void rule fires, or with `refund_unresolved` after seven days with no outcome. | Move funds any other way. It holds no stakes, only donations, deposits and the registration reserve. |
| Stated operator | Sign sponsored registrations and keeper `request_ruling` calls. These are the same permissionless calls anyone can make. | Choose an outcome. Stopping only delays rulings; participants keep the escrow's seven-day refund. |
| Secrets owner | Remove or replace the stored API key, which stops rulings. | Change the pinned program or write an outcome. |

### What the referee checks, and what it cannot

On every result the referee requires: the bet ID, terms hash, attempt number and material hash match this bet and this attempt; the three verdicts name the roster models in order; each outcome is yes, no or unclear and each confidence lies in 0 to 1; the stated outcome equals the decision recomputed from the verdicts; and the serialized result is at most 16,384 bytes. A result that fails any check counts as a failure.

It cannot check that the verdicts came from the models or that the evidence was fetched honestly. It only sees the JSON that OutLayer returns. The pinned program hash and the OutLayer runtime are what make that JSON the jury's output.

### What OutLayer and NEAR AI are trusted for

- **OutLayer** is trusted to run the program whose SHA-256 the referee passes, to release the secret only as configured, and to return that program's real output. In the public views read on 13 November 2026 ([evidence/outlayer-public-views.json](../evidence/outlayer-public-views.json)), the execution account has one full-access key on testnet and on mainnet, and the worker account has three full-access keys on each network. The OutLayer operators can therefore replace code or workers. Removing Stated's own key does not remove those upstream powers. At the OutLayer source commit reviewed for this work (`2d50bfab14389857e6e50e84e76d5652b944e1cc`), result submission was gated to an operator account. That reading of third-party source was not tested here.
- **NEAR AI Cloud** is trusted to run the named models honestly and to keep prompts confidential. This path sends one HTTPS request per model with a bearer key. It does **not** port the Stated server's per-model attestation verifier (TDX, GPU evidence, signatures). The server path verifies attestation; this path does not.
- **Evidence sources** (Coinbase, linked pages) are trusted for content only as far as the jury's rules allow. Coinbase responses are not provider-signed. Page text is untrusted: the prompts tell the models to ignore instructions in it, and TLS does not make a page accurate.
- **Network and DNS.** The guest cannot pin resolved IP addresses, so blocking names that resolve to private addresses depends on the worker host.
- **Agreement can be wrong.** Three models can share a failure mode. The roster must be unanimous at 0.8 confidence or the result is `unclear`.

## Commitment and registration

The escrow stores only a hash. The OutLayer path therefore uses a new commitment, and existing bets cannot move to this referee.

`terms_hash(material, salt)` is the lowercase SHA-256 of compact, recursively key-sorted JSON:

```json
{"domain":"stated-outlayer-v1","material":{"bet_id":"…","claim":"…","made_at":"…","deadline":"…","post_url":"…","evidence":{"kind":"…"}},"salt":"<64 lowercase hex characters>"}
```

The example shows structure; read the hash from the referee's `terms_hash` view or reproduce it with `outlayerTermsHash` in `server/src/outlayer.mjs`. Dates are canonical UTC milliseconds (`2026-11-12T19:15:00.000Z`). `made_at` must not be after `deadline`. The claim is at most 16,000 bytes, the whole material at most 16,384 bytes.

On a new bet the server composes the committed claim as `<claim>`, a blank line, `Counts as yes:`, a newline and the agreed criteria. It checks that the referee's `terms_hash` view returns the same hash before the bet is funded.

**Registration.** `register_material({material, salt})` is permissionless and payable. It stores nothing until a callback reads the bet from the configured escrow and checks: same ID, same terms hash, same deadline, this contract named as referee, and status offered, accepted, proposed or disputed. A first caller therefore cannot pick the claim for someone else's stakes. Duplicate or failed registrations return the deposit. The claim, URLs and salt become public on chain; do not use this path for a private bet.

## Evidence kinds

Every bet commits one evidence policy. New server-created bets use the first three rows below. `auto` exists in the schema but the server never commits it.

| Kind | Committed fields | A ruling can start at |
| --- | --- | --- |
| Coinbase moment | `product` (`<ASSET>-USD`), `window: {kind: "moment", at}` | the start of the minute of `at`, plus 2 minutes (never before the deadline) |
| Coinbase range | `product`, `window: {kind: "range", start, end}` | `min(end, deadline)` rounded up to a whole minute, plus 1 minute (never before the deadline) |
| Submitted | `items`: 1 to 8 `{side: yes\|no, url}` | the deadline |
| Open | `window_seconds` (1 to 604,800), `max_per_side` (1 to 4) | the deadline plus `window_seconds` |
| Auto | none; a model planner picks Coinbase or non-price evidence | the deadline plus 180 seconds |

### Coinbase

- Data come from `api.exchange.coinbase.com` candles only, for an `<ASSET>-USD` product (asset: 2 to 10 uppercase letters or digits). Prices are handled as decimals.
- Committed window dates must be on or after 1970 and no later than the deadline plus one day. A moment must fall between `made_at` minus one minute and the deadline plus one minute. A moment uses the **opening price** of its minute.
- A range is clipped to `made_at` through the deadline and rounded outward to whole minutes. It may span at most 366 days and needs at most eight candle requests (1-minute, 1-hour and 1-day candles, at most 300 per request).
- Each request must return at least 90% of the expected candles, with the first and last within one step of the window edges and no duplicates. Candles are used only once the window end plus 60 seconds has passed. Any failure is a failed run; Coinbase failures never become evidence.
- **Acceptance before the window.** The server enforces this at creation; the contract and jury do not recheck it. For a price bet the acceptance deadline is the earlier of 24 hours after creation and one hour before the window ends. A moment's minute must start after that deadline and after creation. A range's start moves up to the next whole minute at or after the later of `made_at` and the acceptance deadline, so candles from before the offer closed are never used. Creation is refused when no complete candle remains. The server also requires a moment to be at least 70 minutes after creation (10 minutes to accept, plus the one-hour margin).

### Submitted

The server commits a Submitted policy when the bet's terms name a web evidence link: one item, on the creator's side. A link to X is context for the claim and never counts as evidence. If the referee reports no Open support (older deployments), the server commits the creator's link as Submitted. The current contract reports `supports_open_evidence: true`.

### Open

Without a chosen web source, the server commits `{"kind":"open","window_seconds":<n>,"max_per_side":2}`. `<n>` comes from `STATED_EVIDENCE_WINDOW_SECONDS`, default 86,400, accepted from 1 to 259,200 (three days).

- **When.** Either bettor calls `submit_evidence({bet_id, url})`, with a storage deposit, from the deadline until the window closes. A callback re-reads the escrow and checks the window again, so a call whose callback lands at or after closing is refused and its deposit returned.
- **Side and limit.** The side comes from the escrow's creator, acceptor and `creator_side`. Each side may hold at most `max_per_side` links; further links are refused and refunded. Duplicate URLs take separate slots. Sequence numbers allocated at the call preserve submission order.
- **What is committed.** The terms hash covers the window and the limit but not the URLs. Submitted URLs are public on chain and are read from the stored list on every attempt.
- **No links.** If the window closes with zero links, the next `request_ruling` selects **Void** and settles it before any pricing. No compute is spent; the caller pays gas only.
- **Window and refund floor.** The contract allows a window up to seven days, but a window that fills the seven days leaves only the refund path. The server caps new windows at three days.

### URL policy

Evidence URLs must be HTTPS, at most 600 UTF-16 units before and after normalization, with no credentials, ports, fragments, encoded authority, IP literals, localhost or reserved private suffixes (`local`, `internal`, `intranet`, `lan`, `home`, `onion`, `test`, `invalid`, `arpa`), and not on `x.com`, `twitter.com` or their subdomains. The contract applies a stricter ASCII-only subset at submission; the jury applies the full parser and IDNA check.

### Unreadable links, and no ruling without a readable source

The jury reads Submitted and Open links itself; callers never supply page text. A link is **unreadable** if it times out, returns a non-2xx status, has other than exactly one `Content-Type` of `text/html`, `text/plain`, `application/json` or `application/xhtml+xml`, is empty, has no visible text, exceeds the parser budget, or redirects unsafely. An unreadable link yields empty text and a short ASCII reason.

- **All links unreadable:** the run fails with `No readable evidence` and no model is called, on every attempt.
- **Some unreadable, some readable:** on **attempts 1 and 2** the run fails, naming the first reason. From **attempt 3** the jury proceeds with the readable links; each unreadable one reaches the models flagged, with the note "An unreadable link is not evidence for either side." The attempt number counts admitted executions of this bet.
- **A failed run** counts toward the failure limit (below). A bet whose sources never become readable ends as Void after eight failures, or as a refund at the seven-day floor. It is never decided against a side on an unreadable source.

## Lifecycle, nonces and counters

Stages: `idle`, `reading`, `pricing`, `running`, `paying`, `settled`.

| Stage | Entered by | Meaning |
| --- | --- | --- |
| `idle` | registration; any failure; a pricing refusal; a failed payout | waiting for `request_ruling` |
| `reading` | `request_ruling` | reading the bet from the escrow |
| `pricing` | `on_bet` | asking OutLayer for a cost estimate |
| `running` | `on_priced` | OutLayer execution requested |
| `paying` | an outcome is selected | `referee_resolve` or `refund_unresolved` sent |
| `settled` | `on_settled` success, or escrow already terminal | done |

### `request_ruling`

Callable by anyone with zero deposit, after the deadline, after the readiness time in the table above, and (from `idle`) after the retry delay. It increments the **nonce**, moves to `reading` and reads the escrow. Attach up to 300 Tgas. Internal allocations: escrow read 10, estimate 10, `request_execution` 150, `on_bet` 260, `on_priced` 230, `on_ruling` 60, payout 15, `on_settled` 15 (Tgas).

`on_bet` first checks the escrow:

1. Status `settled`, `refunded`, `cancelled` or `expired`: mark settled; no payment, no compute.
2. Wrong referee, terms hash or deadline, or status not accepted, proposed or disputed, or the read failed: an **admission failure**.
3. An outcome is already selected, or at least seven days have passed since the deadline: go straight to payout (no compute).
4. Open bet with zero links: select Void and pay out (no compute).
5. Otherwise ask OutLayer for an estimate.

`on_priced` proceeds only if the estimate is positive, at most **0.1 NEAR** (an immutable cap), and at most the pool balance. Otherwise the ruling returns to `idle` with a note, and **no counter and no delay changes**; the keeper may retry at once. It then records the attempt and calls `request_execution` with the exact estimate attached, `payer_account_id` set to the referee, `secrets_ref` set to the configured owner and profile, and limits of 10,000,000,000 instructions, 128 MB and 180 seconds.

### Nonces, attempts and late results

- The **nonce** increments with each `request_ruling` and keys the callbacks. `on_bet` and `on_priced` act only if the nonce and stage still match; otherwise they return `stale`.
- The **attempt** number is the count of executions admitted so far, plus one. A result must carry the attempt it was started with.
- `on_ruling` matches the callback to an outstanding attempt, not only the newest one. A result from an **older** nonce is still accepted while no outcome is selected and the ruling is not paying or settled. Each receipt is removed from the outstanding list before it is handled, so a duplicate callback cannot be counted twice.
- A fully valid result **ends the round**: all other outstanding attempts are cleared, so newer in-flight attempts become stale. The accepted nonce and attempt are stored (`accepted_nonce`, `accepted_attempt`). The nonce itself is not advanced.
- A failed or invalid older result counts once as a failure but does not interrupt a newer attempt or its backoff, unless it is the last outstanding attempt and a limit has been reached.
- `get_ruling().result` holds the latest valid result, including an unclear one that precedes a retry or Void.

### Timeouts

Reading, pricing, running and paying all time out after **900 seconds**. After that anyone may call `request_ruling` again. It records "Attempt timed out" and increments the nonce but **does not count against any limit** and does not discard the outstanding attempt: if that execution later returns a valid result, the result is still accepted. (This is stricter than OutLayer's own 600-second stale window, which is why the contract waits longer.)

### Counters, delays and Void

| Counter | Counts | Limit | At the limit |
| --- | --- | --- | --- |
| `undecided` | valid `unclear` results | 3 | Void, paid at once |
| `failures` | completed executions that returned null, malformed, oversized or invalid results | 8 | Void selected |
| `admission_failures` | reverted OutLayer admissions, failed escrow reads, binding or deadline mismatches | 24 | Void selected |

- **Unclear result.** Waits **300 seconds**, then retries. The third `unclear` selects Void and pays it immediately.
- **Failure or admission failure.** The next `request_ruling` may come after `min(300 s << min(failures + admission_failures, 6), 6 h)`. In practice the shift cap binds first, so delays run 600, 1,200, 2,400, 4,800, 9,600 s and then 19,200 s for each further failure (derived from the code). When a limit is reached and no attempt is outstanding, Void is selected; the payout waits for the next `request_ruling` after that delay, which re-reads the escrow first.
- **Why separate counters.** A reverted admission refunds its deposit and bought no compute, so it has its own larger allowance. Pricing refusals and an empty pool touch neither counter, so an empty pool cannot force a Void.
- **Void** returns each stake to its owner as an escrow credit. Credits are withdrawn through the escrow's `withdraw`.

### Settlement, late payouts and the seven-day floor

- A selected outcome is stored and **never rerolled**. If the payout receipt fails, the ruling returns to `idle` with a 300-second delay and the outcome intact; the retry reads the escrow, then pays. It does not rerun the jury. If the escrow is already terminal, the ruling ends as settled.
- **Selected outcomes pay after the window.** The escrow's `referee_resolve` is not limited to the seven-day window. A decisive result that arrives after day seven, or an outcome selected earlier, still pays Yes, No or Void as long as no refund has happened first. Whichever of `referee_resolve` and `refund_unresolved` reaches the escrow first wins; the other then sees a terminal bet.
- **The floor.** Seven days after the deadline, with no outcome selected, `request_ruling` calls `refund_unresolved` instead of computing. Participants can call it on the escrow directly. An empty pool, an absent keeper, a paused OutLayer or repeated callback failure cannot remove this floor.
- **Reserve refund.** When the ruling settles, the unused part of the registration growth reserve (below) goes back to whoever paid registration. A failed payout keeps it for the retry. Callback success alone is not proof of transfer: `on_settled` must see a successful escrow call, and recipients still withdraw.

### Server keeper limits

The server's keeper skips compute while the pool is empty, backs off 5 minutes, 30 minutes, then 6 hours after repeated pricing refusals, and signs at most `STATED_OUTLAYER_RULING_DAILY_LIMIT` (default 12) new `request_ruling` intents per bet per UTC day. It also limits sponsored registrations to `STATED_OUTLAYER_REGISTRATION_DAILY_LIMIT` (default 5) per linked bettor per UTC day and requires a stake of at least 0.1 NEAR on mainnet. These are application limits; they do not constrain the contract's permissionless methods.

## Jury runtime

**Time budget.** One monotonic **150-second** budget per run, inside OutLayer's 180-second execution limit. Stages are:

| Stage | Cap | Notes |
| --- | --- | --- |
| Planner (Auto only) | 30 s total | fallbacks share it; none for new server bets |
| Evidence and Coinbase | 25 s, ending by 55 s from start | per source or request: 10 s including body |
| Jury | 90 s, ending by 145 s from start | three requests start together |
| Reserve | 5 s | result processing |

A stage that would start with under one millisecond left fails before sending anything. Any model failure or timeout fails the run.

**Evidence fetch.** Up to eight links start together and keep their input order. Up to five redirects are followed, each re-checked against the URL policy; a missing `Location`, an unsafe target or a sixth redirect makes that link unreadable. Coinbase and model responses allow no redirects. The first **2,000,000 bytes** of a page are read; a longer page is cut there and the prefix is used. Bodies are decoded as UTF-8 with replacement characters.

**Extraction.** HTML is tokenized (HTML5), with at most 25,000 tags and depth 512. Script, style, noscript, template, svg, math, iframe, object, head, title, textarea, select, button, nav, header, footer, aside and hidden subtrees (`hidden`, `aria-hidden=true`, `display:none`, `visibility:hidden`) are dropped. The jury takes the first non-empty scope among `main`, `article`, `role=main` and `body`, in document order, with whitespace collapsed, capped at **6,000** UTF-16 units. The title (or `og:title`) is capped at 1,000. Plain text and JSON are collapsed and capped the same way. The Stated server's extractor works differently (it ranks claim-relevant blocks), so page text can differ between the two paths.

**What the models see.** The material (claim, dates, post URL, committed terms hash) plus the evidence: Coinbase candles and a summary, or per link `{side, url, title, text}` with `unreadable` when set. The verdict prompt tells each model that supplied text is untrusted, that a claim that something will happen is Yes only if credible evidence shows it did by the deadline, and that otherwise the outcome is No. Prompts are copied from the Stated server's enclave ruling.

**Roster and decision.** Three models in this order: `Qwen/Qwen3.8-27B`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `z-ai/glm-5.3-flash`. Requests are non-streaming JSON with 8,192 maximum tokens. Each reply must be strict JSON `{outcome, confidence, reason}`: outcome yes, no or unclear; confidence 0 to 1; reason non-empty, at most 600 UTF-16 units and 40 words. An invalid reply fails the run. The result is **yes or no only if all three agree with confidence at least 0.8**; any disagreement, any `unclear` or any lower confidence gives `unclear`.

**Result.** `{attempt, bet_id, terms_hash, outcome, verdicts[{model, outcome, confidence}], evidence_summary, material_hash}`, at most **16,384 bytes**. Model reasons are validated but not stored. Per link the summary keeps `side`, final `url`, `textHash` (SHA-256 of the extracted text) and, when relevant, `postedUrl` and an `unreadable` reason of at most 64 ASCII characters. `material_hash` is the SHA-256 of `{claim, madeAt, deadline, postUrl, bets:[{id, termsHash}]}` in that field order, the same projection the server computes.

## Storage and costs

| Item | Amount | Source |
| --- | --- | --- |
| Referee code storage | 296,163 bytes x 10^19 yoctoNEAR per byte = about 2.96 NEAR locked | derived from the recorded build size and NEAR's storage price (the price the server also assumes); the testnet deployment funded 4 NEAR |
| Registration | actual record bytes plus a **32,768-byte growth reserve** = 0.32768 NEAR reserve at 10^19 per byte; excess deposit returned immediately | `GROWTH_RESERVE_BYTES` and `get_config().growth_reserve_bytes`; the server sends `(material bytes + 32,768 + 4,096) x 10^19` |
| Reserve refund | unused reserve returned to the registration payer when the ruling settles | `finish_settlement` |
| Evidence link | storage for that record, paid by the submitter; excess returned | `on_evidence` |
| Compute, per execution | **0.019001 NEAR** quoted by `estimate_execution_cost` for the configured limits, on testnet and mainnet on 13 November 2026 (an estimate that can change); referee cap 0.1 NEAR | [evidence/outlayer-public-views.json](../evidence/outlayer-public-views.json) and the testnet run |
| Compute, failed run | **about 0.001 to 0.0012 NEAR** charged; the rest of the deposit refunded to the referee. Measured: 0.001 NEAR on the referee run, 0.0011649 NEAR on the direct probe | testnet run receipts |
| Compute, successful run | not measured | none yet |
| Inference | billed separately to the NEAR AI key; not measured | none yet |
| Gas, failed path | 22.893 of 300 Tgas burnt | testnet run |
| Gas, success path | not measured | none yet |

The reserve exists so a bounded jury result and counter growth never run the contract out of storage funds. The compute pool is the contract balance minus storage collateral, outstanding deposits and the reserve. Never budget on a refund: failed runs may retain fees, and a future estimate may differ.

## Reproducible builds

Release builds are offline, locked and path-independent so anyone can reproduce the exact bytes.

**Requirements.** `rustc 1.93.1 (01f6ddf75 2026-02-11)` with targets `wasm32-wasip2` and `wasm32-unknown-unknown`; Binaryen **`wasm-opt version 123 (version_123)`** (on `PATH`, via `--wasm-opt`, or at `outlayer/stated-jury/target/build-tools/binaryen/bin/wasm-opt`); `wasm-tools`; a populated Cargo registry cache for the locked dependencies (for example `cargo fetch --locked --manifest-path <crate>/Cargo.toml` for each crate).

**Build.** From the repository root:

```sh
node scripts/build-outlayer-wasm.mjs --cargo-home "$HOME/.cargo" --target-dir build-out
```

It builds both crates with `--offline --locked --release`, remaps the repository, Cargo home, Rustup home and target directory to fixed paths, and normalizes the first-party crate identities. The referee is built with `--cfg=near` and optimized with `wasm-opt --enable-bulk-memory --enable-bulk-memory-opt -Oz --gufa -Oz --converge --merge-similar-functions`. The jury is not optimized. The script validates both files with `wasm-tools`, rejects embedded local paths, requires the NEAR `sha256` and `panic_utf8` imports and a referee of at most 300,000 bytes, and prints sizes and SHA-256 values.

**Compare.**

```sh
shasum -a 256 build-out/wasm32-wasip2/release/stated-jury.wasm \
  build-out/wasm32-unknown-unknown/release/stated_outlayer_referee.wasm
```

A deployed referee's on-chain code hash is the base58 encoding of its SHA-256.

**Recorded fingerprints** ([evidence/outlayer-local-validation.json](../evidence/outlayer-local-validation.json), run 13 November 2026 06:43 UTC):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Jury `stated-jury.wasm` | 845,087 | `85198c7afbfca6ad6cb42c76fe064abdf480d18f4db4955b90ce205d768d9791` |
| Referee `stated_outlayer_referee.wasm` | 296,163 | `1f6b35b9fce99165af5090ff04d4ff6493933ec90ab3c0a37a532255bf46ed83` |

The unoptimized referee is 366,450 bytes (`060afd90241448ac48fa6f55cc0c0e1f28a9aa7bb82305e28c4df388aeec1670`). The jury has no optimization step, so its raw and final hashes are equal.

**What ran on testnet.** OutLayer testnet downloaded, checked, compiled and ran this jury build (`85198c7a…`) on 13 November (transaction `DXqcAog1Fu3VghLzPokvQmP5FwH2o8yJLDXVf4EPDGXZ`). The earlier build `3db75833…` differed only in the HTML extractor and is the one the full testnet referee chain used (deploy transaction `gLr8ByF2M2g55hC5rgePNfS9ePc2g5rvA56T5R2R5kF`); the referee fingerprint is the same in both. Records: [evidence/outlayer-testnet-probe-20261113.json](../evidence/outlayer-testnet-probe-20261113.json), [evidence/outlayer-testnet-referee-20261113.json](../evidence/outlayer-testnet-referee-20261113.json).

**The full local gate.** `node scripts/verify-outlayer-local.mjs` runs locked offline tests, strict clippy and formatting for both crates, the lean-core checks, WASI clippy, the JavaScript parity harness and the escrow-window check; builds both artifacts from two copied checkouts with different path lengths, Cargo homes and target directories; and requires byte-identical raw and final files, valid WASM, no builder paths, and the NEAR host imports. The recorded run passed 69 jury tests, 78 referee tests and 6 lean-core tests; its parity harness covered 162 decision cases, 15 complete verdict inputs and 30 extraction cases (24 shared with the server extractor, 6 deliberate differences), all against mock transports. The escrow check shows the real escrow source paying selected Yes and No outcomes after seven days in accepted, proposed and disputed states.

## Deployment

All steps are human actions. The scripts never build WASM and never read a key without `--yes`.

1. **Build and record.** Rebuild as above and confirm the two hashes you will pin.
2. **Publish the jury.** Host the exact jury WASM at an HTTPS URL, for example a hash-named file (the testnet run served `.../static/outlayer/stated-jury-<sha256>.wasm`). The hash, not the filename, is what the referee pins.
3. **Create the referee.** Preview first:

   ```sh
   node scripts/outlayer-deploy.mjs --network testnet \
     --parent <funded-parent> --account <referee>.<funded-parent> \
     --referee-wasm <path>/stated_outlayer_referee.wasm --referee-hash <referee-sha256> \
     --jury-wasm <path>/stated-jury.wasm --jury-hash <jury-sha256> \
     --wasm-url <published-https-url> --escrow <escrow-account> \
     --secrets-owner <secrets-account> --secrets-profile jury --amount-yocto <funding>
   ```

   Both local files must match their hashes, and the hosted bytes (fetched without redirects) must match the jury hash, before a preview prints. The preview shows one atomic transaction: `CreateAccount`, `Transfer`, `DeployContract`, `new`, with **no access key**. Add `--yes --key-file <parent-key.json>` to send. The OutLayer account is `outlayer.testnet` or `outlayer.near` by network.
4. **Store the inference secret** at [app.outlayer.ai/secrets](https://app.outlayer.ai/secrets): profile `jury`, secret name `NEARAI_API_KEY`, bound to the jury hash, access limited to the referee account, direct calls only. Enter the key only through that interface; never put it on the command line or in a file. The secrets owner named in the referee's configuration must be the account that stores it.
5. **Fund the compute pool.** Call `fund_compute` on the referee with an attached donation. Check `get_compute_budget`. Donations carry no withdrawal rights.
6. **Verify** (next section): zero keys, code hash, configuration and compute budget.
7. **Per bet.** Read `terms_hash`; create the bet on the escrow with that hash and the referee; register the material and salt (any caller, with a storage deposit); the opponent accepts; for Open bets either bettor submits links in the window; the keeper (or anyone) calls `request_ruling`; recipients withdraw from the escrow.

## Checking a deployment and a bet

**Deployment, read-only.** Reports code hash, access-key count, configuration and compute budget, and fails on any key or mismatch:

```sh
node scripts/outlayer-check.mjs --network testnet --account <referee> \
  --wasm <path>/stated_outlayer_referee.wasm --escrow <escrow> \
  --wasm-url <published-https-url> --wasm-hash <jury-sha256> \
  --secrets-owner <secrets-account> --secrets-profile jury
```

**Deployment and bet, public chain data only** (see [JUDGE.md](../JUDGE.md)):

```sh
npm run judge -- --outlayer --network mainnet --referee <referee> \
  --referee-sha256 <referee-sha256> --jury-sha256 <jury-sha256> \
  --wasm-url <published-https-url> --secrets-owner <secrets-account> \
  --bet-id <bet-id> --save evidence/judge-outlayer-mainnet.json
```

OutLayer mode checks: the referee has no access keys; its code hash equals the referee SHA-256; `get_config` matches the expected escrow, OutLayer account, jury URL, jury hash, secrets owner and profile; the jury downloaded from the URL (no redirects) hashes to the pinned value. With `--bet-id` it also checks that the escrow bet names this referee, that `get_ruling` agrees on the terms hash and shows a valid stage and outcome, and, through an archival node, that one successful `referee_resolve` receipt from the referee selected the ruling's outcome, that both contracts held the approved code with no keys on either side of the settlement block, and that the winner (or each side, for Void) was credited the right stake. It does not check model attestations or the later wallet withdrawal. Environment variables mirror the flags (`JUDGE_REFEREE`, `JUDGE_BET_ID` and so on). The [saved mainnet check](../evidence/judge-outlayer-mainnet.json) covers the deployment and pinned jury.

To audit one ruling by hand: read `get_ruling(bet_id)` for the registered material, stage, counters, evidence list and `result`; recompute `terms_hash` from the material and salt; confirm `material_hash` with the projection above; and compare the stored `textHash` values with a fresh hash of each linked page.

## Live evidence so far

The [mainnet verifier](../scripts/verify-mainnet-demo.mjs) rechecks both controlled trials through two public RPC providers, including committed terms, jury material, settlement receipt chains and exact native-token withdrawals. It needs no key.

| Mainnet trial | Result | Withdrawal |
| --- | --- | --- |
| `52fe13e9-0bc5-4dd1-9ff9-6dfecfe2bb25` | Unanimous Yes; winner received 0.2 NEAR | [Cd1bvxP9…](https://nearblocks.io/txns/Cd1bvxP93A8DEmF4mU27tjMvDXiQkYSyt44NrzbhRiQm) |
| `8e3b3349-bb3e-4d83-80c3-6c133c0652d8` | Unanimous No; winner received 0.2 NEAR | [CPgughxz…](https://nearblocks.io/txns/CPgughxzKn2segrVaDSR8d56wKFC1PSDn48GyS1Pchwy) |

The following table records the earlier testnet probes from 13 November 2026, before the secret was configured.

| What | Result | Record |
| --- | --- | --- |
| Direct OutLayer testnet execution of the published jury (hash `3db758…4456`), with no secret attached | OutLayer fetched the artifact by URL and hash, compiled it, and ran it. The jury read its input and exited with `Encrypted NEARAI_API_KEY secret is missing`, before any fetch or model call. Charged 0.0011649 NEAR of a 0.03 NEAR deposit; the rest was refunded. | testnet transaction `AxvQYtmEF7yMFsqZDCCNU3hiQC6xHqZPU7czW92FGoL4` |
| Referee deployment on testnet | Referee `outlayer-ref1.stated-court-relay.testnet`: zero access keys, code SHA-256 `1f6b35…ed83`, `supports_open_evidence: true`, `growth_reserve_bytes: 32768` | deploy transaction `gLr8ByF2M2g55hC5rgePNfS9ePc2g5rvA56T5R2R5kF` |
| Full chain on a real bet (escrow `stated-escrow-52081551be.testnet`, NEAR-USD moment bet) | Funded with the contract-computed hash, registered (`true`), accepted, then `request_ruling` ran escrow read, pricing (estimate 0.019001 NEAR), `request_execution` and `on_ruling`. OutLayer returned a failed execution (charged 0.001 NEAR, 0.018001 NEAR refunded). The referee recorded one failure, scheduled the next attempt 724 seconds after the request started (a 600-second delay counted from the callback), left the stakes untouched, and burnt 22.893 Tgas with no failed receipt. The attached NEAR AI secret did not exist. | `request_ruling` transaction `4XmvxTtxPVq2KR7oWAGSoJcUuZmVQPAxCzFHjcjdifvZ` |

All three can be looked up by hash on a NEAR testnet explorer; the figures above come from the receipts of those transactions. The referee run's receipts record only that the execution failed; the missing secret is the expected cause, shown directly by the probe, not read from that run's own error text.

## Not yet proven

- **Void and refund cases.** The two completed mainnet trials exercise successful Yes and No settlement and withdrawal. They do not establish a live OutLayer Void or refund path.
- **Secret enforcement.** The two juries completed with model verdicts, exercising the configured inference path. These trials do not independently audit OutLayer's secret-release confidentiality or access enforcement.
- **Network edge cases.** The controlled trials used the IANA evidence page and returned three model verdicts. They do not benchmark latency or establish live Coinbase behavior, redirects, content-type failures, timeouts or the 150-second budget.
- **Private-address resolution.** Blocking DNS names that resolve to private addresses is the worker host's job and has not been tested.
- **OutLayer behavior at the edges.** That OutLayer rejects bytes that do not match the pinned hash, how it times out and resumes, and the real gas cost of the success path (the settlement receipts) are unverified.
- **Costs.** The cost of a successful run and of NEAR AI inference has not been measured. The 0.019001 NEAR figure is a quoted estimate.
- **Independent rebuild.** Both fingerprints were rebuilt byte-identically from two copied checkouts on one machine; no independent party has rebuilt either artifact yet.
- **Upstream trust remains.** OutLayer administrators and worker software, NEAR AI Cloud, and the evidence sources stay trusted as described above. This path does not verify NEAR AI's per-model attestation. Strict absence of administrative influence over outcomes is not claimed.
- **Compatibility.** Existing bets and the old server referee path are unchanged and cannot move to this referee.
