# Deploying Stated

One Node service and one PostgreSQL database behind a single HTTPS origin. The image is the `Dockerfile` at the repository root; `railway.json` tells Railway to build it, run `node server/src/main.mjs` and wait for `/healthz`. The hosted app, https://stated-production.up.railway.app, runs this way on Railway. The table gives each setting's first-deployment value; the hosted app has since turned on the X worker, replies, bets from replies, enclave rulings and Stated Court. The container checks at the end were run locally on 10 November 2026.

## What the server refuses to do

- **Start hosted with a broken origin.** On Railway (detected through `RAILWAY_ENVIRONMENT`) or with `STATED_HOSTED=1`, startup stops before listening unless `STATED_BASE_URL` is an `https` origin that is not this machine, `X_REDIRECT_URI` is that origin plus `/callback`, `STATED_TOKEN_KEY` is at least 32 bytes and `DATABASE_URL` does not point at localhost. The log lists every problem at once. A failed start leaves the previous deployment serving.
- **Spend on X by default.** Mention polling, publication fills and deletion checks run only with `STATED_WORKER=1`. Replies need `STATED_REPLIES=1` and direct messages `STATED_DM_ENABLED=1`. The NEAR testnet refresher is separate, makes no X call, and runs whenever `STATED_NEAR_CONTRACT` is set.
- **Run two workers.** Keep one replica (`numReplicas: 1`). The X worker and the NEAR refresher run inside the web process; a second replica would poll twice.

## Settings

### Mainnet launch and exclusive X bot ownership

These are required launch values, not a record of deployed configuration. The mainnet and testnet services need separate databases. Keep one replica per service. The founder shares the mainnet service's public HTTPS origin; X sign-in must return to that origin's `/callback`, registered on the X app.

| Railway variable | Mainnet service | Testnet service |
| --- | --- | --- |
| `STATED_NEAR_NETWORK` | `mainnet` | `testnet` |
| `STATED_MAINNET` | `real-funds` | unset |
| `STATED_NEAR_CONTRACT` | `escrow.statedforecast.near` | `stated-escrow-52081551be.testnet` |
| `STATED_PLAY_TREASURY` | `play.statedforecast.near` | retain its existing testnet treasury |
| `STATED_PLAY_TREASURY_KEY` | existing mainnet treasury service secret | retain its existing testnet service secret |
| `STATED_PILOT_X_IDS` | `*` | unset (not used on testnet) |
| `STATED_MAX_STAKE_NEAR` | `1` | unset (not used on testnet) |
| `STATED_PLAY_START_NEAR` | `0.25` (launch sponsorship) | retain existing value, code default `1.6` |
| `STATED_SPONSOR_LIMIT` | `25` | unset (not used on testnet) |
| `STATED_OUTLAYER_REGISTRATION_DAILY_LIMIT` | `5` | `5` by default |
| `STATED_OUTLAYER_REFEREE` | `referee.statedforecast.near` | retain existing value or unset |
| `STATED_WORKER` | `1` | `0` |
| `STATED_REPLIES` | `1` | `0` |
| `STATED_PLAY` | `1` | `0` |
| `STATED_DM_ENABLED` | `0` | `0` |
| `STATED_REPLY_LINKS` | `1` | `0` |
| `STATED_ENCLAVE_RULINGS` | `0` (OutLayer rules these bets) | retain the existing settlement setting |
| `STATED_COURT_DAO`, `STATED_COURT_RELAY` | unset | retain existing testnet Court accounts |
| `STATED_PLAY_AUTOPROVISION` | `0` | `0` while testnet reply bets are off |
| `STATED_BASE_URL` | mainnet public HTTPS origin | existing testnet public HTTPS origin |
| `X_REDIRECT_URI` | mainnet origin plus `/callback`, or unset to derive it | testnet origin plus `/callback`, or unset to derive it |

`STATED_PLAY` is the bets-from-replies switch; there is no separate reply-bet flag. `STATED_WORKER=1` ingests mentions and drains the bot outbox. `STATED_PLAY=1` starts command execution, settlement and payout work. `STATED_REPLIES=1` permits public replies. All three must be on for mainnet to process `@statedforecast bet 0.1 yes` and post the response. The bot must be authenticated in the mainnet database using its existing service-side OAuth connection. A user's sign-in token cannot replace the bot's token.

Set the testnet switches to zero and stop its old worker before enabling the mainnet worker. Testnet can otherwise process a mention or queued command independently because its database has its own cursor. On both starts, inspect the `X bot ownership:` line: mainnet must say it owns mention polling with all three switches `1`; testnet must say it does not poll with all three `0`. The log reports this process's configuration; it cannot inspect or stop another Railway service. Turning off `STATED_PLAY` also stops testnet's reply-bet settlement worker; preserve existing funded testnet bets and handle that service's outstanding obligations before the handover.

Mainnet rejects new bets if the referee is unset, its `get_config` cannot be read, or it names another escrow. A mainnet funding or acceptance request above `STATED_MAX_STAKE_NEAR` is refused even when reputation tiers are disabled. The cap may be lowered to any positive amount with up to 24 decimal places; the existing escrow application supports at most `1` NEAR per side. Testnet retains its existing limits.

Sponsorship is off at `STATED_PLAY_START_NEAR=0.05`. To sponsor a starting balance, set that variable to the approved amount above `0.05`; the first `STATED_SPONSOR_LIMIT` accounts receive it, and later accounts receive `0.05`. The default limit is `25`; `0` sponsors no accounts. Reservations survive retries, restarts and account deletion, so a failed provisioning attempt may consume a slot. Raising the configured limit authorizes additional lifetime recipients. The wallet shows the amount actually granted, and sponsored NEAR belongs to the recipient to bet or withdraw. Keep the same database and token-encryption key across deploys.

On `/me/wallet`, the recipient copies their NEAR account and sends NEAR from an exchange or wallet. The page refreshes the balance in place every ten seconds while visible and offers a manual refresh. A bet's funding screen shows its stake, storage when applicable, and the additional funds needed including reserved gas. An external NEAR wallet remains available. The mainnet home lists real published offers, active bets and completed bets with counters; an empty database shows honest zeroes. `/court` shows the OutLayer account, the access-key count read from NEAR, its jury roster and public rulings with confirmed settlement links.

The [mainnet Court](https://stated-mainnet-production.up.railway.app/court) uses the [verified referee](../evidence/judge-outlayer-mainnet.json). The table describes launch settings. The hosted mainnet service currently keeps the real-funds allowlist empty and the betting and X workers off. Check its zero access keys, code hash, pinned jury artifact and escrow configuration, fund registration/keeper gas and its compute pool, and complete the funded execution-to-payout proof described in [OUTLAYER.md](OUTLAYER.md). Local tests with stand-in transports do not verify deployed OutLayer execution, model access, callbacks or payment. No deployment, variable mutation or paid call is part of this code change.

Keep the server's existing `NEARAI_API_KEY`, planner model roster and attestation-verifier settings: creation still calls the server evidence planner to commit the policy before funding, even with `STATED_ENCLAVE_RULINGS=0`. The OutLayer jury uses its separately provisioned encrypted secret. `0` disables the server's local ruling loop, not this creation-time planner.

Mainnet stakes must be at least `0.1 NEAR`, including web offers, X commands and funding or accepting an older offer. The configured maximum still applies. The launch settings sponsor `0.25 NEAR` for the first `25` accounts; after that quota, new accounts receive the existing fee-only allowance. These values require operator configuration; the mainnet code default for starting funds remains `0.05 NEAR`.

### General settings

| Variable | Value on the host | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway's private reference to the database service. Never the public proxy URL. |
| `STATED_BASE_URL` | `https://<generated-domain>` | No trailing slash. Links, cookies and form-origin checks are built from it. |
| `X_REDIRECT_URI` | leave unset | Defaults to `STATED_BASE_URL/callback`. Register that exact string on the X app. |
| `STATED_TOKEN_KEY` | `openssl rand -base64 32`, generated once | Encrypts the bot's tokens. Changing it means connecting the bot again. |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | from the Stated app on console.x.com | The same app the local server uses. |
| `X_BOT_USER_ID` | the bot's numeric X ID | Stops any other account from being bound as the bot. |
| `STATED_ADMIN_X_IDS` | the operator's numeric X ID | Who may record outcomes. |
| `NEARAI_API_KEY` | leave unset to disable rulings and checks | Needed for enclave rulings and the admin-only public Result check. Set as a service secret. |
| `NEARAI_BASE_URL` | `https://cloud-api.near.ai/v1` | NEAR AI Cloud gateway; credentials are never sent to the evidence site. |
| `NEARAI_MODEL` | `Qwen/Qwen3.8-27B` | TEE model from the [quickstart](https://docs.near.ai/cloud/quickstart), and the only juror when `NEARAI_RULING_MODELS` is unset. Use a canonical model ID; aliases are rejected. |
| `STATED_ENCLAVE_RULINGS` | `1` on the host | Lets the NEAR AI jury decide Results with no human step. Needs `NEARAI_API_KEY` and `STATED_DSTACK_VERIFIER_URL`. |
| `NEARAI_RULING_MODELS` | `Qwen/Qwen3.8-27B,deepseek-ai/DeepSeek-V4.1-Flash-1017,z-ai/glm-5.3-flash` on the host | The jury, two to ten models in order. Every model must give the same answer at `NEARAI_RULING_MIN_CONFIDENCE` (default 0.8, unset on the host). The host's roster is the one in [its signed ruling](../evidence/enclave-ruling-3668aa04.json). |
| `STATED_DSTACK_VERIFIER_URL` | an `https` dstack verifier | Each juror's boot measurements are checked against the published dstack image through it. The host uses a Stated-hosted copy of the official verifier image. |
| `STATED_REQUIRE_GPU_EVIDENCE` | leave unset | A model call counts only with the signing model's NVIDIA GPU evidence. `0` is refused unless NEAR AI is a loopback or `.test` fake. |
| `STATED_EVIDENCE_WINDOW_SECONDS` | `3600` on the host | How long after a bet's deadline the bettors can post links. The code default is a day (`86400`). |
| `STATED_COURT_DAO`, `STATED_COURT_RELAY` | `stated-court.sputnik-v2.testnet`, `jury.stated-court-relay.testnet` on the host | Stated Court. New reply bets name the DAO as referee once the server has checked its network, policy, relay, window and bond. |
| `STATED_OUTLAYER_REFEREE` | unset | Named referee account on the selected NEAR network. Takes precedence over Stated Court and the server referee for new reply and web bets. Stored bets retain their referee. See the OutLayer operator steps below. |
| `STATED_NEAR_CONTRACT` | `stated-escrow-52081551be.testnet` | The escrow on testnet; its `version` view returns `"2"` and its account has no access keys. Leave empty to host with Bets off. The earlier `stated88cdfc066d7ed705a.testnet` runs an older contract with no `version` method. |
| `STATED_PLAY` | `1` to allow Bets from replies | Needs the version 2 contract, the X worker and replies on. |
| `STATED_PLAY_TREASURY`, `STATED_PLAY_TREASURY_KEY` | a `.testnet` account and its `ed25519:` secret key | Funds new play accounts. Testnet only. Set the key through `--stdin`. `STATED_PLAY_AUTOPROVISION=1` makes one from the faucet instead, which is meant for demos. |
| `STATED_NEAR_RPC` | leave unset | Comma-separated RPC endpoints. The default is FastNEAR's two testnet endpoints; `rpc.testnet.near.org` is deprecated and rate-limits. |
| `STATED_WORKER` | `0` at first | Turn on only after the cost step below. |
| `STATED_REPLIES`, `STATED_REPLY_LINKS`, `STATED_DM_ENABLED` | `0` | Each needs its own authorisation. |
| `STATED_METRICS_EXCLUDE_X_IDS` | operator and tester X IDs | Keeps the operator's own activity out of the funnel counts. |
| `PORT` | set by Railway | Do not set it by hand. |

Secrets go in as service variables through the dashboard or `railway variable set --stdin`, never in a file in the repository.

## OutLayer referee

Set `STATED_OUTLAYER_REFEREE` only after checking the keyless referee against the intended escrow and jury artifact. The server reads `get_config` before creating a bet and refuses an escrow mismatch. New bets commit to the complete material described in [OUTLAYER.md](OUTLAYER.md). The database stores that material and its salt before funding; the treasury pays registration storage after escrow funding succeeds. The claim and evidence plan become public on NEAR.

The keeper runs independently of local NEAR AI inference. With reply bets enabled it runs in the play worker; otherwise the NEAR worker runs it. Configure a funded treasury for registration and keeper gas. Compute requires a separate donation to the referee's payable `fund_compute`; inspect `get_compute_budget` before funding bets. The keeper attaches zero deposit and 300 Tgas to `request_ruling`, observes retry timestamps and running timeouts, and synchronizes escrow before the existing payout sweep. It never calls `referee_resolve` as the OutLayer account.

The keeper honors `get_ruling().next_ns` even after a busy-stage timeout. Rejected attempts back off for 5 minutes, 30 minutes, then 6 hours, capped at 6 hours. Pause records track `failures`, `admission_failures`, `undecided` and `accepted_nonce` alongside the attempt nonce; diagnostic `last_error` text does not control retries. An accepted result resets the failure run, including an unclear result that leaves an old error in the referee view. Nonzero pools receive bounded pricing probes. Empty pools block requests that need compute; terminal escrow cleanup and Open bets with an explicitly empty submitted-evidence list proceed without compute. A durable per-bet pause record produces one operator warning with the referee, bet and pool balance.

A registered bet remains on the keeper schedule until its referee reaches `settled`, including after mutual settlement or `refund_unresolved` on the escrow. The keeper requests that cleanup once evidence is ready and retry timestamps and busy-stage timeouts permit it, so the referee can release the registration reserve. Cleanup requests use the daily ruling allowance. Terminal bets that were never registered need no cleanup request.

`STATED_OUTLAYER_RULING_DAILY_LIMIT` defaults to `12` new `request_ruling` intents per bet per UTC day; `0` pauses new intents. The database locks the bet row and reserves the allowance before signing, including failed attempts. Existing signed intents remain recoverable at the cap. The cap also applies to keeper requests at the refund floor; participants retain the escrow's direct `refund_unresolved` path.

Creation plans the claim together with its resolution criteria. Coinbase price plans take precedence over a supplied web URL; that URL appears as context. An X URL supplies context whether or not a save is attached. For non-price plans, a chosen web URL commits to Submitted with that URL and the creator's side. Other claims use `{kind:"open",window_seconds:<STATED_EVIDENCE_WINDOW_SECONDS>,max_per_side:2}` when `get_config().supports_open_evidence` is exactly `true`; a referee without Open support requires a valid precommitted web URL. Creation finishes planning and commitment views outside database transactions, then rechecks the request before saving.

Web and X price offers share an acceptance policy. A Coinbase moment closes acceptance at the earlier of creation plus 24 hours and the moment minus one hour; creation is refused if fewer than 10 minutes remain to accept. A Coinbase range closes acceptance at the earlier of creation plus 24 hours and its checked window end minus one hour. The committed range starts at that acceptance deadline rounded up to the minute; creation is refused if acceptance has already closed or less than one hour of candles remains. Non-price offers retain their existing acceptance rule.

Run `node --test server/test/r7-creation.test.mjs server/test/r7-keeper.test.mjs` for the database-free regressions. With PostgreSQL `initdb` and `pg_ctl` on PATH, run `node --test --test-concurrency=1 server/test/r7-creation-pg.test.mjs server/test/r7-keeper-pg.test.mjs` for the HTTP/form and SQL checks, then `STATED_TEST_REQUIRE_PG=1 npm test`. A sandbox `initdb` failure at `shmget` leaves the PostgreSQL checks unverified; run them on the operator's host before launch.

Registration sponsorship defaults to five new registration intents per linked bettor per UTC day, controlled by `STATED_OUTLAYER_REGISTRATION_DAILY_LIMIT`. Both creator and linked taker consume an allowance. A database reservation commits before signing; failed attempts consume allowance, while reconciliation of an existing intent reuses its reservation. Setting the limit to zero pauses new sponsored registrations. An already registered bet remains readable and settleable. Registration and keeper gas still require the treasury; the compute pool remains separate.

The bettor's proposition remains limited to 1,000 characters and resolution criteria to 2,000. The committed combined text has separate limits of 3,100 characters and 12,000 UTF-8 bytes as a JSON string, including escaping. Oversized combined text receives a message to shorten the claim or criteria before planning. The startup schema migration widens the existing `bilateral_bets_claim_check` to 3,100 characters; updating only `CREATE TABLE` would leave an existing database unchanged. Complete serialized referee material must still fit `MAX_MATERIAL = 16,384` bytes in `contracts/outlayer-referee/src/lib.rs`.

Offer and participant pages show the stored evidence policy beside the acceptance action and in Rules: Coinbase product and candle window, the post-deadline link window and per-side limit, or the agreed Submitted source URL. Public offers retain this policy before their first referee snapshot. A selected web source is already committed in `material.evidence.items`; `post_url` alone supplies context and does not instruct the jury to fetch it.

Before preparing the bettor's payable `submit_evidence({bet_id,url})` transaction during the post-deadline window, the server registers missing material, verifies readback and checks that the window remains open. Storage follows the referee's `evidence_deposit_yocto` quote, or a bounded URL-storage allowance. Local rulings can stay disabled: accepted Open bets originating on X receive a deduplicated prompt during their committed window. Refused evidence links receive a short public reply. Unparseable replies produce none.

The rebuilt referee exposes its latest validated `JuryResult` as `get_ruling().result`; older status-only deployments remain readable.

The keeper uses `get_ruling().accepted_nonce` (or `result_nonce` for compatible deployments) to identify the accepted attempt independently of the live nonce; if absent or unmatched, it reconciles the latest executed local `request_ruling`. That fallback link appears as **Ruling request**. A permissionless settlement with no local request still records the terminal event and checks verified withdrawals for payout completion, leaving the transaction hash unknown until a verified local request can supply one.

Before broadcasting, the signer stores the signed transaction bytes and hash in `outlayer_near_requests`; RPC retries reconcile that hash and resend the same bytes. Signing failures remain retryable. Registration completion requires `get_ruling` readback, so a rejected callback can be retried even when its transaction succeeded. Include operation rows alongside material and salt in database backups.

Prepare the immutable account transaction with explicit paths and accounts:

```sh
node scripts/outlayer-deploy.mjs --network testnet \
  --parent sponsor.testnet --account referee.sponsor.testnet \
  --referee-wasm /absolute/path/stated_outlayer_referee.wasm \
  --referee-hash <referee-sha256> --jury-wasm /absolute/path/stated-jury.wasm \
  --escrow escrow.testnet --wasm-url https://artifacts.example.org/stated-jury.wasm \
  --jury-hash <jury-sha256> --secrets-owner sponsor.testnet \
  --secrets-profile jury --amount-yocto <account-funding-yocto>
```

The preview requires both local artifact hashes, checks the published jury against its hash without following redirects, and reads the escrow and secrets-owner accounts. It includes the complete referee WASM bytes and initialization arguments. Its atomic action batch contains CreateAccount, Transfer, DeployContract and `new`, with no access key. Sending requires `--yes --key-file /absolute/path/parent-key.json`; that file must contain the matching parent `account_id` and `private_key`. Dry runs read no key. The script uses neither default credential directories nor environment signing keys. Choose `--network mainnet` with mainnet accounts for a mainnet deployment.

Read back the deployed account without a key:

```sh
node scripts/outlayer-check.mjs --network testnet \
  --account referee.sponsor.testnet --wasm /absolute/path/stated_outlayer_referee.wasm \
  --escrow escrow.testnet --wasm-url https://artifacts.example.org/stated-jury.wasm \
  --wasm-hash <jury-sha256> --secrets-owner sponsor.testnet --secrets-profile jury
```

The check requires `--wasm` or `--code-hash` and the expected immutable configuration. It reports the code hash, access-key count, configuration and compute budget, and fails on any access key or mismatched field. The OutLayer account defaults to the network's canonical account; `--outlayer` can pin another expected account.

Both operator scripts compare filesystem real paths at their entry points. File and directory symlink invocations run the same argument validation as direct invocations; invalid arguments exit nonzero before network or credential access.

Enclave rulings, which decide Results, are a separate path from the check below: each juror's call needs its Intel TDX quote, GPU evidence, dstack boot measurements and an up-to-date TCB, as the README describes.

The evidence page offers **Run enclave check** only after an admin publishes evidence for a public referee Result. Each attempt has a 30-second deadline. The first successful signed check becomes an append-only Bet event; failures store nothing. A check never changes the Result or payout. The request contains public Bet terms and published evidence only.

Checks require an Ed25519 `provider_tee` signature matching one preflight model report. Gateway signatures are rejected. The stored report and verification recipe support a separate hardware review. The built-in verifier checks signed bytes and signer consistency; it reports hardware attestation as unverified. Current [NEAR AI verification guidance](https://docs.near.ai/cloud/verification/cloud-api/response-signatures) also requires DCAP quote verification and measurement policy before treating hardware as verified.

## First deployment

Every command names its project and service. The CLI in this checkout is linked to a different application, so nothing here relies on the ambient link.

```sh
# 1. A project of its own, in the workspace that should be billed.
railway init --name stated --workspace "<workspace name or id>" --json      # note the project id it prints
railway add --database postgres
railway add --service stated

# 2. A generated HTTPS domain, before the first deploy, so the origin is known.
railway domain --service stated                                              # prints https://stated-….up.railway.app

# 3. Settings (see the table). Secrets are read from stdin so they never reach shell history.
railway variable set --service stated STATED_BASE_URL=https://<generated-domain>
railway variable set --service stated 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway variable set --service stated STATED_WORKER=0 STATED_REPLIES=0 STATED_DM_ENABLED=0
railway variable set --service stated STATED_NEAR_CONTRACT=stated-escrow-52081551be.testnet
openssl rand -base64 32 | railway variable set --service stated --stdin STATED_TOKEN_KEY
# X_CLIENT_ID, X_CLIENT_SECRET, X_BOT_USER_ID, STATED_ADMIN_X_IDS: same pattern, values from 1Password.

# 4. On console.x.com, add https://<generated-domain>/callback to the app's callback URLs.
#    Keep http://localhost:8080/callback for the local server.

# 5. Deploy and read the result.
railway up --service stated --detach
railway logs --service stated            # expect "Stated on https://…", "X worker off", "NEAR refresher on"
curl -s https://<generated-domain>/healthz    # {"ok":true}
```

The schema is applied at startup. One replica means one migration owner.

## Checks on the public origin

1. In a clean browser, `/` loads over HTTPS with the strict `content-security-policy` header and a `Secure` visitor cookie.
2. `/me` redirects to sign-in; `/me/export.json` returns 401; a private Prediction's page and share image return 404.
3. Sign-in with X returns to the page it started from. A callback with a wrong or reused `state` is refused.
4. A public Prediction's share image (`/share/predictions/<id>.png`) renders, and the page's `og:image` points at the HTTPS origin.
5. Connect the bot from inside the service, where the private database is reachable: `railway ssh --service stated node server/src/cli.mjs bot-auth`, open the printed link signed in to X as the bot, then `railway ssh --service stated node server/src/cli.mjs whoami` must print the bot's handle. The local database's bot token is not copied; the host authorises on its own.
6. Open a Bet page and confirm "Checked on NEAR" shows a recent time.

## Cost

- **Railway.** The Hobby plan is a US$5 monthly minimum that includes US$5 of usage; usage above that is billed (railway.com/pricing, read 10 November 2026). Set a usage limit on the workspace before the first deploy. This app's consumption has not been measured.
- **X.** The demo uses simulated X. For a connected deployment, configure the developer console spending cap before enabling the live X worker.
- **Without the worker** a tag on X is not picked up, and a newly published X post shows its link and terms but not its words. Public examples that should show words need the worker on at least once after publication.

## Backup, restore and rollback

```sh
# Backup: a custom-format dump, taken from this machine through the database's public TCP proxy.
# `railway run` injects the Postgres service's variables into a local command; the app image has no pg_dump.
railway run --service Postgres sh -c 'pg_dump "$DATABASE_PUBLIC_URL" -Fc' > stated-$(date -u +%Y%m%dT%H%M%SZ).dump

# Restore drill: into a scratch database on this machine, then compare counts with the live one.
createdb stated_restore && pg_restore -d stated_restore stated-<stamp>.dump
psql stated_restore -Atc 'select count(*) from saves; select count(*) from users; select count(*) from bilateral_bets'
railway run --service Postgres sh -c 'psql "$DATABASE_PUBLIC_URL" -Atc "select count(*) from saves; select count(*) from users; select count(*) from bilateral_bets"'
dropdb stated_restore

# Rollback: redeploy the previous successful deployment from the dashboard, or
railway redeploy --service stated --yes
```

Take a dump before every deploy that changes `server/src/schema.sql`. Schema changes so far are additive (`create table if not exists`, `add column if not exists`), so the previous image runs against the newer schema. A dump holds private captures and session rows: keep it out of the repository and delete it after the drill. Rows tied to a funded Bet are the app's only record of who may withdraw from the escrow, so the hosted database is never reset while a Bet is live.

## Known limits on a public host

- Web sign-in and correction submissions have separate per-address limits in each app process. PostgreSQL caps pending OAuth starts across app instances at 1,024 sign-ins and 16 bot authorizations. Both expire after 15 minutes. Each account can submit five corrections per hour and have ten awaiting review, with one open correction per prediction and kind.
- A deploy health check gates the rollout only. Nothing watches the app afterwards; `/healthz` is there for an external monitor.
- Phone wallet handoff and a hosted share preview on X are unverified until they are run on the public origin. Bot replies from the public origin are recorded in the [12 November payout evidence](../evidence/hosted-court-payout-testnet-20261112.json).

## Container checks already run locally

Run on 10 November 2026 against the image built from this `Dockerfile` (Node 26.13.0, linux/arm64 unless noted, non-root user) and PostgreSQL 17:

| Check | Result |
| --- | --- |
| `docker compose up --build` from empty volumes | Simulated-X stack seeded: 9 tagged saves, 4 recorded outcomes |
| `/healthz` from the host; image `HEALTHCHECK` | 200 `{"ok":true}`; `healthy` |
| Share image rendered on Linux | 200 `image/png`, 1200 by 630, self-hosted typeface |
| Headers on `/` | strict `content-security-policy`, `nosniff`, `no-cache` |
| Signed out: `/me`, `/me/export.json` | 303 to sign-in, 401 |
| Restart the app container | Same record counts; fixtures not seeded twice |
| `pg_dump` then `pg_restore` into a second database | Identical counts and save fingerprint |
| Connected app with a bad hosted configuration | Refused, both problems named, no listen |
| Connected app with a good hosted configuration | `Secure` cookies, worker off, exit code 0 on stop |
| Image built for linux/amd64 (Railway's architecture, emulated) | Builds; the image renderer runs; the startup guard refuses a bad configuration with a plain message |
