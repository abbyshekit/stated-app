# Stated

Stated turns a reply under a prediction into a two-person bet. One bettor offers a stake, the other matches it, and a NEAR escrow contract pays the winner after Stated’s referee records the result. You can also tag the bot to track a prediction without offering a bet. The hosted app uses real X and NEAR testnet; the local Docker walkthrough uses simulated X.

## Try the hosted app

Open [Stated](https://stated-production.up.railway.app/) or inspect the [completed test bet](https://stated-production.up.railway.app/bets/c171de89-f223-4309-886e-180ad69af092) without signing in. Two operator-controlled X identities completed this test on 11 November 2026. Each staked 0.1 test NEAR; the winner received 0.2 test NEAR. These tokens have no monetary value.

When a deliberately published offer has an open seat and recent verified funding, the home page offers its opposite side. The original prediction save can remain private. Sign-in returns to that Bet, where acceptance requires consent and a matching stake. Withdrawn, invited, expired and stale offers are excluded.

The [original prediction](https://x.com/ChainAbstracted/status/2120590042074665286) led to a [bet command](https://x.com/ChainAbstracted/status/2120590352880951797), a [bot offer](https://x.com/statedforecast/status/2120590654430650560), web acceptance and a [match reply](https://x.com/statedforecast/status/2120597844256305438). A reviewer recorded No from the specified Coinbase candle. After the ten-minute correction delay, the worker settled, withdrew the winnings and published the [result](https://x.com/statedforecast/status/2120598097608987019).

Verify the [referee transaction](https://testnet.nearblocks.io/txns/4Gix2npAw4PGEfCDTnifCByGagz4FZdG5mArTtA6kazt) separately from the [completed payout](https://testnet.nearblocks.io/txns/8gqtVGRBxghhqnTveMrjW2X6AW89GUGvV6azmebWMr6B). Public RPC verification confirmed the exact transfer and successful withdrawal callback; settlement alone does not prove delivery. [Public proof record](evidence/hosted-real-x-testnet-20261111.json)

## Verify the hosted payout

From a checkout with Node.js 22.9 or later and outbound HTTPS:

```sh
npm ci
node scripts/verify-hosted-payout.mjs
```

The command reads the [completed hosted Bet](https://stated-production.up.railway.app/bets/c171de89-f223-4309-886e-180ad69af092) and its recorded transactions from both fixed public testnet RPC endpoints. It checks finalized settlement, the referee's exact ruling, the winner's 0.2 test NEAR transfer and the linked successful callback. No database, X account, wallet, API key or faucet is needed, and no transaction is submitted. [Public evidence](evidence/hosted-real-x-testnet-20261111.json)

It prints a JSON report. Exit `0` requires both endpoints to pass and agree; exit `1` means evidence did not match, and exit `2` means an endpoint was unavailable. The command corroborates RPC responses; X identities and the human outcome decision remain outside its checks. Both recorded participants were operator-controlled.

## Run the judge demo

No X account, API key or NEAR wallet is needed to browse predictions and try capture. The stack runs the real server, worker and pages against **simulated X** with labelled test accounts and posts. Prediction capture works locally. The reply Bet uses real NEAR testnet and requires outbound RPC access and a funded testnet treasury.

```sh
docker compose up --build
```

Wait for the `Ready:` line. Prediction capture and the recorded payout check work during a faucet outage. Use `/demo-readiness` before trying a fresh Bet. [Verified default faucet run](evidence/default-faucet-judge-20261111.json)

For the quickest live round, open `http://127.0.0.1:4310/demo-challenge` while signed out. Fund Bob's offer, take Yes, and record the test result. Use **Refresh status** while transactions finalize. The page links to the matching stake and payout on NEAR testnet. Each local demo data set has one practice round. [Verified signed-out round](evidence/practice-judge-testnet-20261111.json)

| Do | See |
| --- | --- |
| Open `http://127.0.0.1:4310` | Public predictions as posts. One that came true has its words highlighted; one that did not has a line through them. |
| Open `http://127.0.0.1:4310/demo-readiness` | Whether the testnet treasury and referee balance checks passed. During a faucet outage, you can still capture predictions or [use a funded testnet treasury](docs/DEMO.md#use-a-funded-testnet-treasury) for reply Bets. |
| Open `http://127.0.0.1:4310/demo-proof` and choose **Verify payout** | Stated checks the recorded Bet and its finalized 0.4 test NEAR withdrawal against NEAR testnet. This needs RPC access and works without a wallet or faucet. |
| Click a highlighted prediction | The Result, "Yes", with its date and evidence link, and a share image at `/share/predictions/<id>.png`. |
| Open `http://127.0.0.1:4311`, the simulated X. Set "Posting as" to `@sim_dana` and post `TEST FIXTURE: Nvidia will close above $300 by June 30, 2027. 65% chance.` Then press "Reply" under that post and send `@sim_statedbot`. | The bot replies that it saved the prediction privately. |
| Open `http://127.0.0.1:4310/signin`, choose "Sign in with X", then "Authorize as @sim_dana" | "You’re in, @sim_dana" and one button. |
| Press "Finish setup and show my post" | The post you just tagged, with its words, private to you, and the terms Stated read from it: "Known by 30 Jun 2027, 65% likely. Is that what you meant?" |
| Back in the simulated X, set "Posting as" to `@sim_bob`, press "Reply" under Dana's Nvidia post and send `@sim_statedbot bet 0.2 no` | Wait for the bot to confirm that NEAR testnet holds Bob's stake and invite a reply with `@sim_statedbot take`. |
| Open the Bet before accepting, expand **Cross-chain quote**, and press **Get a quote** | NEAR Intents returns a live dry-run quote for the stake in the selected token. Some routes report a minimum. Requesting a quote moves no funds. |
| Set "Posting as" to `@sim_carol`, press "Reply" under that bot reply and send `@sim_statedbot take` | "It’s on. 0.4 test NEAR is held on NEAR testnet until 30 Jun 2027. @sim_bob says no; @sim_carol says yes." |
| Sign in as `@sim_reviewer`, open `/admin`, and record the Nvidia post as "Came true" with an HTTPS evidence link | The bot replies that Carol wins 0.4 test NEAR. The Bet page, linked from the home page, shows the winner and "Settled". |
| Sign in as `@sim_carol` and open `/me/wallet` | Her testnet account, its balance, and the step that makes the account hers: her key goes on, the server's comes off. |
| Press "Bet on it" on any open prediction | The other way to bet: an offer signed in your own wallet (Meteor) instead of from a reply. |
| Sign in as `@sim_reviewer` and open `/admin` | Where an outcome is recorded with its evidence, and the product metrics. |

Use **Copy bet link** to invite someone to an open public Bet.

1. The recipient signs in and returns to the opposite side.
2. They confirm that their X name and wallet can appear on the Bet.
3. Stated opens a testnet account if needed and verifies the matching stake.

During acceptance, **Matching stake** confirms the request is in progress and repeat submissions are blocked. A rejected request returns to an enabled form; browser Back also permits a fresh attempt.

Concurrent managed retries serialize account creation and acceptance through PostgreSQL. After waiting, the server checks finalized escrow and the recipient's persisted private binding before signing. A recorded unresolved transaction is checked again without another broadcast.

[Browser acceptance and payout](evidence/web-take-testnet-20261111.json)

An open reply Bet can also show **Reply in simulated X**. It opens the bot's offer with the take command filled in. Select a second test account and send the reply to stake from that account without a Stated sign-in. Connected mode prepares an X reply to the bot's published offer. [Verified simulated reply handoff](evidence/reply-link-testnet-20261111.json)

`docker compose down` stops the stack and keeps its data. Use `docker compose down -v` only to delete the demo database and simulated X history. `npm run demo` runs the site and simulated X without Docker when Node 22.9+ and PostgreSQL 15+ tools are installed. [Local walkthrough](docs/DEMO.md)

## What NEAR does

A Bet is two people on opposite sides of one prediction with equal stakes held by a contract on NEAR testnet (`contracts/bilateral-escrow`). The proposer funds an offer; anyone, or a named opponent, takes the other side with a matching deposit. The contract stores a salted hash of the terms, never the prediction's words, and the server marks nothing as done until it has read the finalized transaction and checked the signer, contract, method, arguments and deposit.

**Bets from a reply.** Replying `@bot bet 0.2 no` offers a Bet on the post; `@bot take` takes the other side. First-time bettors receive a funded testnet account named after their X handle (`handle.<treasury>.testnet`). The server signs until the owner claims it on `/me/wallet`, where one transaction adds their key and removes the server's. The account keeps its name and balance when its signing key changes.

**Cross-chain quotes.** On an open Bet, choose a token and request a dry-run quote. Stated calls the NEAR Intents 1Click API (`POST /v0/quote` with `dry: true`) for the equivalent mainnet amount. The Bet uses test NEAR. The quote requests no deposit address and moves no funds (`server/src/intents.mjs`).

**Mainnet mode.** `STATED_NEAR_NETWORK=mainnet` supports a closed pilot with real NEAR. Only allowlisted accounts can prepare new stakes. The treasury pays network fees for managed accounts, and participants supply their own stake. The verified version 2 WASM is deployed to `escrow.statedforecast.near` with zero access keys. The private mainnet payout and live cross-chain funding remain unverified. The judge walkthrough uses testnet. [Deployment evidence](evidence/escrow-deploy-mainnet-20261111.json)

**Settlement.** Version 2 of the contract (`stated-escrow-52081551be.testnet`) names a referee when a Bet is funded. For Bets from replies the referee is Stated: when the reviewer records the post's Result with its evidence link, the referee account carries that Result to the contract and the stakes move. The referee can only choose yes, no or void between the two sides; it cannot take the stakes. Without a referee, a result one side proposes and the other leaves unanswered for two days stands; a disputed result with no referee returns both stakes seven days after the result date. The contract account has no access keys, so nobody can replace its code.

## Verify the recorded payout

The judge stack uses a locked version 2 contract. The film was captured on a separate locked deployment of version 2.

| Run | NEAR escrow | Version | Access keys |
| --- | --- | --- | --- |
| Film, 0.4 test NEAR paid | `escrow.stated-play-52ee8531f8.testnet` | 2 | 0 |
| Fresh Docker judge stack | `stated-escrow-52081551be.testnet` | 2 | 0 |
| Earlier two-wallet test | `stated88cdfc066d7ed705a.testnet` | 1 | 1 |
| Mainnet deployment | `escrow.statedforecast.near` | 2 | 0 |

The film's payout finalized and left zero escrow credit. Verify its exact transfer without an explorer or wallet. The command prints the recipient and amount in yoctoNEAR. [Film evidence](evidence/hackathon-demo-20261111.json) · [Funded Docker run](evidence/funded-judge-testnet-20261111.json)

```sh
curl -fsS https://test.rpc.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"stated-proof","method":"tx_status","params":{"tx_hash":"6EqheQnnphHRwfV69821K3CymkL7WQaPyb6Cp6hoQa6Z","sender_account_id":"sim_carol.stated-film-261111.testnet","wait_until":"FINAL"}}' \
  | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{const {result:r}=JSON.parse(b);const t=r?.receipts.find(x=>x.receipt_id==="3evx1rkAsFNoRVawEpHiCsdNcDVQVmbR7YPuT13PrLCv");const a=t?.receipt.Action.actions[0].Transfer.deposit;if(r?.final_execution_status!=="FINAL"||a!=="400000000000000000000000")process.exit(1);console.log(t.receiver_id,a)})'
# sim_carol.stated-film-261111.testnet 400000000000000000000000
```

## NEAR HACKATHON notes

The recording evidence records the test run at filming. The release verification ran 490 app tests; the existing contract verification passed 71 tests separately. `npm audit --omit=dev` flags four high-severity entries in the Meteor SDK dependency tree. The reply-to-payout demo uses app-managed testnet accounts.

- **Development dates.** The first recorded Stated development snapshot is dated 9 November 2026, after the hackathon announcement. It includes the standalone forecasting prototype. The judge walkthrough uses the Node app and its NEAR integration.
- **NEAR integration.** The escrow contract (Rust, `near-sdk` 5.29.0; version 2 adds the referee and the unanswered-result rule), live dry-run quotes from NEAR Intents for paying a stake from another chain (the mainnet payment path is implemented and unverified), named accounts per X handle with a claim step that swaps keys, wallet signing through the self-hosted Meteor SDK, exact finalized-transaction verification, and a bounded testnet reconciler that keeps Bet pages current without a browser. A full reply-to-settlement run on testnet is recorded in `evidence/reply-bets-testnet-live.json` (`node scripts/reply-bets-live.mjs` repeats it).
- **Libraries.** The app uses `@meteorwallet/sdk`, `near-api-js`, `@near-js/transactions`, `@near-js/keystores`, `pg`, `@resvg/resvg-js`, `decimal.js`, `qrcode-generator`, `buffer`, and `util`. `esbuild` bundles the wallet script. The typeface in share images is Archivo (SIL Open Font License). Pages use server-rendered HTML and ordinary forms.
- **Limits.** The local walkthrough uses simulated X. The hosted test uses actual X, test NEAR and operator-controlled participants. Intents quotes are dry runs. The mainnet pilot is private, and live cross-chain payment and mainnet payout are unverified. The server holds an unclaimed managed account's key. Stated referees reply Bets from a human-recorded Result. A direct Bet without a referee can settle by agreement. [Demo walkthrough](docs/DEMO.md)

Predictions can seed a separate bilateral Bet. Participants review their own proposition and terms, then deposit equal native test NEAR stakes into the testnet escrow. The source author participates only if they join. A funded Bet can be deliberately published; visitors can take the opposite side or follow its outcome without a wallet. Public invitations remain readable after acceptance and settlement and have downloadable share cards. Sharing opens X's composer for the user to submit.

## Requirements

- Node 22.9 or later.
- Postgres 15 or later (developed on 17). The tests also need `initdb` and `pg_ctl` on `PATH`; Homebrew's `postgresql@17` provides them.

## Run it

Postgres must be running before `createdb`. With Homebrew, `brew services start postgresql@17`; `pg_isready` should then print "accepting connections".

```sh
npm ci
cp .env.example .env        # then fill in DATABASE_URL, STATED_TOKEN_KEY, X_CLIENT_ID, STATED_ADMIN_X_IDS
pg_isready                   # Postgres has to be up first
createdb stated              # or point DATABASE_URL at any empty database
npm run migrate
npm start                    # website on PORT (default 8080); the X worker stays off unless STATED_WORKER=1
curl -s http://localhost:8080/healthz    # {"ok":true}
```

`npm start` reads `.env` if it exists. Each setting is described in `.env.example`. Three settings have to match outside this repo:

- `X_REDIRECT_URI` (default `STATED_BASE_URL/callback`) must exactly match a callback URL registered on the X app, including host and port. X treats `localhost` and `127.0.0.1` as different strings.
- `STATED_TOKEN_KEY` encrypts the bot's tokens in the database. Changing it means connecting the bot again.
- `STATED_ADMIN_X_IDS` lists the numeric X user IDs that may record outcomes, review corrections and run the desk.
- `X_BOT_USER_ID` names the bot account. Without it, authorisation is refused for any account but the bot already connected; only the very first connection, with neither, binds whichever account approves.

## Connect the bot account

With the server running at the redirect URI, in a browser already signed in to X **as the bot account**:

```sh
npm run cli -- bot-auth      # prints a link; open it and approve
npm run cli -- whoami        # must print the bot's handle, not yours
```

With `STATED_WORKER=1` the worker then polls the bot's mentions every `STATED_POLL_MS`. Public replies stay off until `STATED_REPLIES=1`; until then each acknowledgement is recorded as held and the tagger gets it in their private inbox.

## Commands

| Command | What it does |
| --- | --- |
| `npm run migrate` | Creates or updates the schema. Safe to repeat. |
| `npm run cli -- bot-auth` | Prints the link that connects the bot account. |
| `npm run cli -- whoami` | Prints the connected bot. |
| `npm run cli -- tick [--sources]` | Runs one worker pass: mentions, retries, DMs, link intake, replies, deadline updates; `--sources` also re-checks saved X posts for deletions and edits. |
| `npm run cli -- replay <mention-id>` | Re-processes a stored mention. Expected result: `replay`, no new save, no new reply. |
| `npm run cli -- verify-tag <mention-id> --owner <x-id> --source <post-id> --relation mine` | Evidence for one real tag: event, owner, source, collection and reply, then a replay that must change nothing. Exits 1 if any check fails. |
| `npm run cli -- metrics` | Tags, saves per tag, repeat savers, sign-ups from replies and profiles, public shares. |
| `npm run cli -- near-sync` | One bounded NEAR reconciliation pass, without any X API calls. |
| `npm test` | All tests. Each server test file starts its own throwaway Postgres cluster. |
| `npm run demo` | The real server against a simulated X on 127.0.0.1:4310 and :4311, for walking the website. Nothing it produces counts as X verification. |
| `docker compose up --build` | The same simulated-X stack in containers with its own PostgreSQL, seeded with test fixtures. |
| `DATABASE_URL=... node server/dev/seed-desk.mjs desk/launch.json` | Publishes the reviewed desk records in `desk/launch.json`, fetching each article live. Before touching the database it refuses any page that is not public https, and any database that holds person accounts or desk records from local or test pages; none of these checks can be switched off. Prints a report of what was published and what the extractor did not offer. |

## Where things are

| Path | Contents |
| --- | --- |
| `server/src/main.mjs` | Starts the website and the worker. |
| `server/src/intake.mjs` | Mention to save: identity, own versus followed, idempotency, reply text, held replies. |
| `server/src/worker.mjs` | Mention polling, retries, DM intake, link intake, replies, updates. |
| `server/src/web.mjs` | Every page and JSON route. |
| `server/src/privacy.mjs`, `store.mjs`, `terms.mjs` | Visibility rules, storage, the record and its scoring, exports. |
| `server/src/notify.mjs` | Deadline and outcome updates, DMs, outcome recording, deleted and edited sources. |
| `server/src/articles.mjs` | Guarded fetching and link intake; `extractArticle` and `candidatesFrom` find claims in a page. |
| `server/src/interpret.mjs` | Reads deadlines, probabilities, conditions and hedges from text, without inventing any. |
| `server/src/xapi.mjs` | X API client, OAuth 2.0 with PKCE, token refresh under a row lock. |
| `server/src/xtext.mjs` | Which X post words are stored, the on-request oEmbed read for a private save, keeping stored words in step with visibility, and applying the policy to existing data. |
| `desk/launch.json`, `server/dev/seed-desk.mjs` | The reviewed desk records and the script that publishes them. |
| `server/src/schema.sql` | The database. |
| `server/src/bets.mjs`, `bet-pages.mjs`, `bet-public.mjs` | Immutable Bet terms, authenticated actions, explicit publication and spectator follows. |
| `server/src/near-bets.mjs`, `near-request.mjs`, `near-worker.mjs` | Finalized escrow verification, stable wallet intents and bounded independent reconciliation. |
| `server/src/share-pages.mjs`, `share-image.mjs` | Public PNG cards that recheck publication authorization on every request. |
| `contracts/bilateral-escrow/` | The escrow contract (the same code on testnet and mainnet) and its tests. |
| `server/test/` | End-to-end tests against real Postgres and a fake X API (`support/fake-x.mjs`). |
| `server/dev/simulated-x.mjs` | The local demo. |
| `evidence/` | Testnet runs and escrow deployment records. |

The files at the top of this directory (`index.html`, `app.mjs`, `domain.mjs`, `seed.mjs`, `sim.mjs`) are the earlier single-page league prototype. `score.mjs` from it is reused for scoring.

## How privacy works

Profile visibility controls Prediction pages. Each Bet has separate, explicit publication consent and withdrawal controls. Its accepting participant's X identity appears publicly only after separate consent and a matching finalized wallet binding. Public chain data remains public after a site publication is withdrawn.

Every save starts private, and so does every new profile. A public profile shows only the saves its owner published; going public asks which ones, with nothing pre-ticked, and going private withdraws every public page, search result, export, preview and statistic. A public record counts toward a public profile's statistics only if it was public before its deadline and outcome, so publishing the hits after the fact does not raise anyone's record. A public prediction withdrawn after its deadline or its outcome stays in those counts. The profile says how many were withdrawn after the outcome, and how many after the deadline, and does not show which ones or their wording. Private notes and reminder dates are visible only to their owner. Two people can save the same post: one person's private save, confirmation or capture time never appears on another person's public copy.

Reviewers see each claim and can open its post on X, which shows who wrote it. They are never shown who saved a claim. For a claim no one has made public they also see no speaker, no number of saves and no terms a saver confirmed, and its link carries no handle, so nothing tells them that the post's author saved it. An author's confirmed terms appear in review only once the author's own save is public, as they do on its public card.

## Testnet Bets

Set `STATED_NEAR_CONTRACT` to a deployed Stated escrow account ending in `.testnet`. This starts a separate reconciliation worker that checks a bounded queue once a minute; it does not enable the X worker. Keep `STATED_WORKER=0`, replies and DMs off during cost-limited development. A missing contract disables deposit preparation.

Wallet review uses the self-hosted Meteor SDK. Connect the exact reviewed testnet account, then approve its transaction in Meteor. The wallet owns signing keys and nonce selection; Stated stores the request and verifies the finalized signer, contract, action, arguments and deposit. The authenticated `/near/block` endpoint exposes only a bounded latest-block read so the browser retains its strict same-origin CSP. Rebuild the checked-in wallet bundle with `npm run build:wallet` after changing its client or pinned SDK.

Uncertain approvals stay unverified. A submitted stake puts Check transaction first. If no transaction hash returned, Continue in wallet resumes the saved request; an approval whose return was lost can still be checked by hash. Failed stakes retain the original account. Requests and recovery controls stay private to their owner, including after a public acceptance check. Stated marks a withdrawal complete after verifying the finalized transfer for that request. Actual mobile-device wallet handoff remains unverified.

Each stake is greater than zero and at most one test NEAR. The creator also deposits 0.01 test NEAR for storage. Accepted terms remain fixed. For a Bet with no referee, one participant proposes Yes, No or Void and the other can confirm or dispute that revision. Version 2 lets an unanswered proposal stand after two days. Unresolved Bets permit stake refunds seven days after resolution opens. Settlement and refunds create credits; withdrawal is a separate transaction. Storage is not part of refunded stake, and all tokens are testnet tokens with no monetary value.

Build and check the contract with `cargo test --manifest-path contracts/bilateral-escrow/Cargo.toml --locked`, `cargo clippy --manifest-path contracts/bilateral-escrow/Cargo.toml --locked --all-targets -- -D warnings` and `cargo fmt --manifest-path contracts/bilateral-escrow/Cargo.toml -- --check`. The interactive browser-wallet journey requires its own verification; local RPC fixtures and a separate SDK run do not establish that result.

## How deadlines are held

A prediction is held to the earliest deadline it ever had, including after it is removed and saved again: the one stated in the post (as read, or as corrected in review) or the earliest the author confirmed, whichever is sooner. The author may move the deadline later before it passes. The move is recorded and shown on the card ("Deadline moved from X to Y on Z by the author") and to reviewers once the save is public, but scoring, resolution and the public-record check still use the committed deadline. Terms lock once that deadline passes. Reviewers resolve each claim against the deadline it states and record the date the outcome became known; an author who privately committed to an earlier deadline is held to it from that date, so a "came true" known only after it counts as did not come true. The probability scored is always the one stated when the claim was made.

A tag on X is itself a public post. To save something without a public tag, paste the link at `/me/track` or send it to the bot by DM. Post links are read through the X API, never fetched from x.com, and picks from an article stay private whatever the profile's default.

## What Stated keeps from X

**Stored.** For every X save, Stated keeps the post ID, link, author ID and handle, date, and its reading of the terms. By default it stores the words only while a public record shows them. `STATED_X_TEXT_POLICY=all` stores every saved post's words. Stored mention events keep IDs only. Startup and `npm run migrate` apply the current policy to existing records and inbox items.

**What X learns when an owner reads a private post.** Owner pages never contact X on their own. A private save's page has a "Show the post's words here" button; pressing it makes Stated's server request that one post from X's oEmbed endpoint (`publish.x.com/oembed`, documented by X as public, unauthenticated and not rate limited, with `dnt=true`). X sees a request from Stated's server address for that post at that time; it is not told who asked. The server never requests several of one owner's posts together, but an owner who opens several posts one after another produces requests close together in time. The words are kept in server memory for at most one hour, shared by every user who asks for the same post (so a second request within the hour reaches nobody), never written to the database, and rendered as escaped text. A check that finds the post protected or deleted drops that copy then. Until the check, a cached copy can remain for the rest of the hour, which is a timing signal X could in principle see if the same post is requested again. X's `widgets.js` is never loaded in the browser, so the page keeps its strict content security policy. If X does not return the post, the page says so and links to it.

**Deletion checks.** An enrolled app can supply `X_COMPLIANCE_BEARER` for daily batch checks; a confirmed deletion clears the source identifiers and preserves the owner's note. Without batch access, the worker uses post lookups, marks unavailable posts and removes stored words, while the card shows the last check's date.

## Visit counting

A public page gives a new browser a random first-party cookie, signed by this server. Only a cookie this server issued is counted. The visit is counted when the browser loads the page's stylesheet with that cookie, once per visitor, page and referral a day; the cookie is hashed before it is stored. A referral on that visit is what later sign-in is credited to. A `?r=` on the sign-in link is ignored. A client that keeps no cookies, as most scripts and crawlers do, is never counted, whatever user agent it sends, and known crawlers are ignored. Two people behind one address are two visitors. Residual limits: a script that stores the signed cookie and loads the stylesheet is counted; one that mints its own cookie value is not. A script that keeps cookies and loads the stylesheet is counted as a new visitor each time it starts with an empty cookie jar. A real visitor whose browser blocks cookies, or who leaves before the stylesheet loads, is not counted. Each count identifies a browser. Signing the cookie does not stop someone who completes a real visit and then signs up from being counted, which is what the count is for.
