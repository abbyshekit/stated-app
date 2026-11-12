# Jury relay

Immutable Sputnik DAO relay for bilateral escrow. `new` stores `dao`, `escrow`,
`operator` and `window_seconds` (60 through 86400). `get_config` returns the account
IDs and `window_ns` as a decimal JSON string.

The operator calls payable `file({id,outcome,description})` with the DAO's proposal
bond. IDs use lower-case UUID syntax; outcomes are `yes`, `no` or `void`;
descriptions are at most 1000 UTF-8 bytes. The relay forwards the complete deposit
to `add_proposal` and returns that promise directly, preserving its final JSON u64
proposal ID. The proposal contains one zero-deposit, 100-Tgas `referee_resolve`
action on the configured escrow.

Anyone can call `approve({id})` with 300 Tgas and zero deposit.

The relay reads the DAO proposal, validates its ID, proposer, status and exact
function-call shape, then votes `VoteApprove` once the proposal's submission
timestamp plus the window has elapsed. The private callback bounds the result at
64 KiB and checks timestamp arithmetic for overflow.

Gas flows through nested receipts: the 20-Tgas read and 250-Tgas callback reserve
30 Tgas for the initial receipt; the callback allocates 200 Tgas to `act_proposal`,
which funds the 100-Tgas escrow action from its own allowance.

Create and fund the account, deploy code, and initialize the contract in **one
transaction with zero access keys**. Contract code cannot prove that the account
has no keys. No contract method can add a key, change configuration or upgrade the
code. DAO council rejection or
removal remains governed by the DAO's policy; the relay's window does not extend
the DAO's proposal expiry. The DAO must permit the relay to add this proposal and
cast the approval vote, and its policy must allow enough time for the window.

Validation:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt -- --check
```
