# Opportunity Markets

Opportunity Markets allow users to influence decision making by staking. Decision makers benefit from opportunity markets by getting access to high-quality signals, helping them make the best choice.

**How it works:**

1. A decision maker creates a market and deposits a reward
2. Participants propose options to vote on
3. The decision maker opens voting
4. Participants stake on their preferred option
5. The decision maker selects a winning option and closes the market
6. All participants withdraw their stake; those who backed the winner split the reward

While the market is open, the following information is kept confidential:

1. How much stake each option has
2. For which option(s) a given user staked and with how much capital

Keeping this information hidden from the public prevents herd behavior — participants vote based on their own judgment rather than following the crowd.

Devnet address: `bncZ1gDqgqhSWFzcxjeMoCtqN7odS8wYn1nS5tXZ9jA`

## Documentation

See [this document](./docs/market-life-cycle.md) for detailed documentation of the protocol.

## Build & Test

Arcium v0.8.0 required.

Before testing, make sure you build without the feature `hosted-compdefs`.
In `programs/opportunity_market/Cargo.toml` make sure it's not in the defaults array.

### Program keypair

Tests use a deterministic program keypair assumed to be located at `../bncZ1gDqgqhSWFzcxjeMoCtqN7odS8wYn1nS5tXZ9jA.json`. If you don't have this keypair, generate your own and update the
following to match:

1. `declare_id!()` in `programs/opportunity_market/src/lib.rs`
2. `OPPORTUNITY_MARKET_PROGRAM_ADDRESS` in `js/src/generated/programs/opportunityMarket.ts`
3. `[programs.localnet]` in `Anchor.toml`
4. Copy your keypair to `target/deploy/opportunity_market-keypair.json`

### Running tests

```bash
bun install
./test.sh
```

## Deployment

1. Enable the `hosted-compdefs` feature by adding to the  defaults in `programs/opportunity_market/Cargo.toml`
2. Update the program `declare_id!` macro to use your program keypair's pubkey
3. Run `arcium build --skip-keys-sync` (last argument ensures step 2. isn't overwritten)
4. Make sure in your Anchor.toml file, the `opportunity_market` address matches address of step 2 (in the `[programs.localnet]` section if you have no devnet config there!)

Set the following environment variables.

```bash
DEPLOYER_KEYPAIR_PATH="/path/to/your/keypair.json"
RPC_URL="https://your-rpc-url"
PROGRAM_KEYPAIR_PATH="/path/to/program-keypair.json"
PROGRAM_ID="your_program_id"
```

Deploy the program:

```bash
./deploy.sh
```

Initialize compute definitions:

```bash
bun scripts/init-compute-defs.ts
```