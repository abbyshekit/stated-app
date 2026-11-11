# Deploying Stated

One Node service and one PostgreSQL database behind a single HTTPS origin. The image is the `Dockerfile` at the repository root; `railway.json` tells Railway to build it, run `node server/src/main.mjs` and wait for `/healthz`. Nothing in this file has been run against a hosting account. The container checks at the end were run locally on 10 November 2026.

## What the server refuses to do

- **Start hosted with a broken origin.** On Railway (detected through `RAILWAY_ENVIRONMENT`) or with `STATED_HOSTED=1`, startup stops before listening unless `STATED_BASE_URL` is an `https` origin that is not this machine, `X_REDIRECT_URI` is that origin plus `/callback`, `STATED_TOKEN_KEY` is at least 32 bytes and `DATABASE_URL` does not point at localhost. The log lists every problem at once. A failed start leaves the previous deployment serving.
- **Spend on X by default.** Mention polling, publication fills and deletion checks run only with `STATED_WORKER=1`. Replies need `STATED_REPLIES=1` and direct messages `STATED_DM_ENABLED=1`. The NEAR testnet refresher is separate, makes no X call, and runs whenever `STATED_NEAR_CONTRACT` is set.
- **Run two workers.** Keep one replica (`numReplicas: 1`). The X worker and the NEAR refresher run inside the web process; a second replica would poll twice.

## Settings

| Variable | Value on the host | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway's private reference to the database service. Never the public proxy URL. |
| `STATED_BASE_URL` | `https://<generated-domain>` | No trailing slash. Links, cookies and form-origin checks are built from it. |
| `X_REDIRECT_URI` | leave unset | Defaults to `STATED_BASE_URL/callback`. Register that exact string on the X app. |
| `STATED_TOKEN_KEY` | `openssl rand -base64 32`, generated once | Encrypts the bot's tokens. Changing it means connecting the bot again. |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | from the Stated app on console.x.com | The same app the local server uses. |
| `X_BOT_USER_ID` | the bot's numeric X ID | Stops any other account from being bound as the bot. |
| `STATED_ADMIN_X_IDS` | the operator's numeric X ID | Who may record outcomes. |
| `NEARAI_API_KEY` | leave unset to disable checks | Enables the admin-only public Result check. Set as a service secret. |
| `NEARAI_BASE_URL` | `https://cloud-api.near.ai/v1` | NEAR AI Cloud gateway; credentials are never sent to the evidence site. |
| `NEARAI_MODEL` | `Qwen/Qwen3.8-27B` | TEE model from the [quickstart](https://docs.near.ai/cloud/quickstart). Use a canonical model ID; aliases are rejected. |
| `STATED_NEAR_CONTRACT` | `stated-escrow-52081551be.testnet` | The version 2 escrow on testnet; its account has no access keys. Leave empty to host with Bets off. The earlier `stated88cdfc066d7ed705a.testnet` is version 1 and cannot name a referee. |
| `STATED_PLAY` | `1` to allow Bets from replies | Needs the version 2 contract, the X worker and replies on. |
| `STATED_PLAY_TREASURY`, `STATED_PLAY_TREASURY_KEY` | a `.testnet` account and its `ed25519:` secret key | Funds new play accounts. Testnet only. Set the key through `--stdin`. `STATED_PLAY_AUTOPROVISION=1` makes one from the faucet instead, which is meant for demos. |
| `STATED_NEAR_RPC` | leave unset | Comma-separated RPC endpoints. The default is FastNEAR's two testnet endpoints; `rpc.testnet.near.org` is deprecated and rate-limits. |
| `STATED_WORKER` | `0` at first | Turn on only after the cost step below. |
| `STATED_REPLIES`, `STATED_REPLY_LINKS`, `STATED_DM_ENABLED` | `0` | Each needs its own authorisation. |
| `STATED_METRICS_EXCLUDE_X_IDS` | operator and tester X IDs | Keeps the operator's own activity out of the funnel counts. |
| `PORT` | set by Railway | Do not set it by hand. |

Secrets go in as service variables through the dashboard or `railway variable set --stdin`, never in a file in the repository.

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

- `/signin/x` has no rate limit of its own. Sign-in states older than an hour are purged, which bounds the table; a proxy rule is the place for a per-address limit.
- A deploy health check gates the rollout only. Nothing watches the app afterwards; `/healthz` is there for an external monitor.
- Phone wallet handoff, a hosted share preview on X and a delivered bot reply are unverified until they are run on the public origin.

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
