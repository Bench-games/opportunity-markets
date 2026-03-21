# Opportunity Markets

Opportunity Markets allow users to influence decision making by staking. Decision makers benefit from opportunity markets by getting access to high-quality signals, helping them make the best choice.

### **[Detailed protocol documentation →](./docs/README.md)**

The Opportunity Markets program is deployed on Solana devnet at `BencHEXKYZ8HJ9LCrihgCWAmnqBT1abpsa9FYRs8fK1D`

## Build & Test

Arcium v0.9.0 cli required.

Before testing, make sure you build without the feature `hosted-compdefs`.
In `programs/opportunity_market/Cargo.toml` make sure it's not in the defaults array.

### Program keypair

Tests use a deterministic program keypair assumed to be located at `../BencHEXKYZ8HJ9LCrihgCWAmnqBT1abpsa9FYRs8fK1D.json`. If you don't have this keypair, generate your own and update the
following to match:

1. `declare_id!()` in `programs/opportunity_market/src/lib.rs`
2. `OPPORTUNITY_MARKET_PROGRAM_ADDRESS` in `js/src/generated/programs/opportunityMarket.ts`
3. `[programs.localnet]` in `Anchor.toml`
4. `program_keypair` in `Arcium.toml`
5. Copy your keypair to `target/deploy/opportunity_market-keypair.json`

### Running tests

```bash
bun install
./test.sh
```

### Troubleshooting: `DeclaredProgramIdMismatch`

If tests fail with `Error Code: DeclaredProgramIdMismatch`, the compiled `.so` binary has a different program ID baked in than the deploy keypair. This happens when:

- `target/deploy/opportunity_market-keypair.json` doesn't match the `declare_id!()` in the source. The `test.sh` script copies the deterministic keypair here before building.
- The build was skipped due to caching (arcium reports "Skipping build") and the cached `.so` was compiled with a different keypair. Fix by deleting stale artifacts and rebuilding:

```bash
rm -f target/deploy/opportunity_market.so target/sbpf-solana-solana/release/opportunity_market.so
arcium build
```

- `Arcium.toml` has a bad `program_keypair` path (e.g. trailing whitespace), causing arcium to fall back to a generated keypair.

### Troubleshooting: Tests hang at "Airdropping" or connect to stale validator

If tests hang during `TestRunner.initialize` (at the airdrop step) or comp defs unexpectedly show as "already initialized" on what should be a fresh network, a zombie `solana-test-validator` process from a previous run is likely still holding port 8899. This commonly happens after Ctrl+C'ing a test run.

```bash
# Check for stale validator
lsof -i :8899

# Kill it
kill <PID>
```

Then re-run the tests.

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
