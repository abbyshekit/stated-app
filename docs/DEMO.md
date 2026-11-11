# Stated demo

The local demo combines prediction tracking, bilateral Bet offers, public invitations, spectator updates and NEAR testnet escrow. X is simulated, and NEAR transactions use test tokens. The recorded judge walkthrough follows one reply Bet through a finalized 0.4 test NEAR payout. [Recording evidence](../evidence/hackathon-demo-20261111.json)

When a testnet contract is configured, an independent NEAR worker reconciles escrow and pending transactions without enabling live X polling. Reload the Bet page to see its latest verified state.

## Start

Start in the repository root.

```sh
docker compose up --build
```

Open Stated at `http://127.0.0.1:4310` and simulated X at `http://127.0.0.1:4311`. The stack seeds labelled fixtures. Check `http://127.0.0.1:4310/demo-readiness` before trying the reply Bet. If escrow is waiting on testnet provisioning, browse the seeded predictions and test capture with `@sim_statedbot` in simulated X. Open `http://127.0.0.1:4310/demo-proof` to recheck the recorded Bet and withdrawal using read-only testnet RPC.

### Practice a live Bet

Open `http://127.0.0.1:4310/demo-challenge` after the Docker stack prints `Ready:`. Start signed out. Choose **Fund Bob's offer**, then **Stake 0.1 test NEAR on Yes** when the offer finalizes. **Record test result** lets the simulated referee record Yes early for this fixture. Refresh until the payout appears. The matching stake and payout links open the real NEAR testnet transactions. The practice path uses one round per local demo data set. [Verified practice run](../evidence/practice-judge-testnet-20261111.json)

Without Docker, use Node 22.9+ and PostgreSQL 15+ tools on PATH.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:wallet
env -u DATABASE_URL PORT=4310 SIM_X_PORT=4311 npm run demo
```

In a second terminal, from the same directory:

```sh
SEED_APP=http://127.0.0.1:4310 SEED_X=http://127.0.0.1:4311 node server/dev/seed-demo.mjs
```

The simulated sign-in page offers Alice, Bob, Carol and the reviewer. The non-Docker command above starts the prediction flow. To enable reply Bets, use the testnet escrow and play settings from `compose.yaml`. Reseed a temporary database after restarting.

## Use a funded testnet treasury

If the faucet is unavailable, use a dedicated named `.testnet` account with 4 test NEAR. The demo grants 1.6 test NEAR to each new bettor and 0.3 to the referee. Put the account ID in `STATED_DEMO_TESTNET_TREASURY` and its key in `STATED_DEMO_TESTNET_TREASURY_KEY` in a private environment file outside the repository.

```sh
docker compose --env-file /path/to/stated-demo.env up --build
```

Check `/demo-readiness`, then run the reply Bet walkthrough. Keep the database volume when restarting so it retains the referee key. Use a fresh treasury account with a new database.

## Walk the product

- Open a public Prediction. Its source author appears above the words. Follow, share or offer a separate Bet.
- Offer a Bet from the Prediction. Sign-in preserves the destination. Review the editable wording, evidence rule, sides, stake and dates. The source author takes no seat unless they join.
- Enter a NEAR testnet account and prepare the deposit. Connect that exact account in Meteor, then approve the reviewed action. Wait for finalized verification.
- Review publication and publish the funded invitation. Use **Copy bet link** to forward it. A visitor can take the opposite side or follow the outcome without a wallet. Opening the X composer prepares a post for the user to submit.
- After resolution opens, one participant proposes a result and the other confirms or disputes that exact proposal. Settlement creates withdrawal credit. Withdraw separately and wait for transfer verification.

For a shorter wallet check, cancel a funded offer before acceptance, then withdraw its stake credit. The storage fee is separate. An uncertain wallet approval stays unverified. If you already approved it in Meteor, return to the Bet's Latest wallet requests section and check its transaction hash before signing again. The saved deposit account remains populated.

## Evidence

- [Recorded reply Bet](../evidence/hackathon-demo-20261111.json) and [finalized testnet payout](https://testnet.nearblocks.io/txns/6EqheQnnphHRwfV69821K3CymkL7WQaPyb6Cp6hoQa6Z).
- [Separate full testnet reply run](../evidence/reply-bets-testnet-live.json).
- [Funded Docker run with an existing treasury](../evidence/funded-judge-testnet-20261111.json).
- [Fresh Docker run with automatic faucet provisioning](../evidence/default-faucet-judge-20261111.json).
- [Locked testnet deployment](../evidence/escrow-deploy-testnet-20261111.json) and [locked mainnet deployment](../evidence/escrow-deploy-mainnet-20261111.json).

Actual mobile-device wallet handoff remains unverified. A factual Prediction Result remains separate from Bet settlement.
