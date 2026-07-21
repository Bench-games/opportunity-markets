# Opportunity Markets

Opportunity Markets aggregate capital backed insights into actionable signals.

In Opportunity Markets, users influence decision making by suggesting options and backing their choice with a withdrawable deposit of capital.
Decision makers get exclusive access to high quality signals, secured by Aricum encryption, giving them first access to valuable opportunities.

Program address on Solana Mainnet: `BENCHYxBqzpvkzS6ZEHjwnH3U1x6twmjvxeRHT9pg1hq`

## Documentation

***Important documents for auditors and contributors:***


[Detailed protocol description →](./docs/README.md)

[Security statement for auditors →](./docs/security/README.md)

## Admin CLI

For convenience, an admin CLI is provided that you can use to manage markets and platform configurations.

Run `bun admin help` for more details.

## Build & Test

Arcium v0.10.3 cli required.

For local tests, `./test.sh` enables feature `disable-prod-guardrails` automatically.
Keep it out of `default = []` in `programs/opportunity_market/Cargo.toml`.

### Formatting & linting

`rustfmt` and `clippy` run over the whole workspace and are enforced in CI
(`.github/workflows/ci.yml`). Before committing, run:

```bash
anchor run fmt   # cargo fmt --all + cargo clippy --fix across the workspace
```

CI runs the check-only equivalents:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

`too_many_arguments` and `diverging_sub_expression` are allowed in
`programs/opportunity_market/Cargo.toml`.

clippy needs the compiled confidential instructions (`build/*.arcis`) present,
because the Arcium attribute macros read them at macro-expansion time. CI caches
`build/` keyed on a hash of `encrypted-ixs/`, and only installs the Arcium
toolchain (`arcium-hq/setup-arcium`) and runs `arcium build` on a cache miss —
i.e. when the circuits change. The pinned versions in `.github/workflows/ci.yml`
must be bumped together with the repo whenever they change:

- `setup-arcium@vX.Y.Z` ref **and** `arcium-version` ← keep matching `arcis` in
  `encrypted-ixs/Cargo.toml` (and the `arcium-*` crates in the program manifest)
- `anchor-version` ← keep matching `anchor_version` in `Anchor.toml`

### Program keypair

Tests use a deterministic program keypair assumed to be located at `../BENCHYxBqzpvkzS6ZEHjwnH3U1x6twmjvxeRHT9pg1hq.json`. If you don't have this keypair, generate your own and update the
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

### Regenerating the JS client

After changing the program (instructions, accounts, types, errors), regenerate the IDL and the Solana Kit client in `js/`:

```bash
anchor run js-generate
```

This runs `anchor build`, copies the IDL into `js/src/idl/`, installs deps, and runs Codama to regenerate `js/src/generated/`.

## Deployment

**IMPORTANT!**

Upload your compute circuits to a stable publically accessible URL and update the program circuit definitions to point to that url!

**On mainnet change the cluster offset to 2026 or 10000**

1. Ensure `disable-prod-guardrails` is **not** enabled (mainnet/devnet deploys should keep production guardrails active)
2. Update the program `declare_id!` macro to use your program keypair's pubkey
3. Run `./build.sh`

Set the following environment variables.

```bash
DEPLOYER_KEYPAIR_PATH="/path/to/your/keypair.json"
RPC_URL="https://your-rpc-url"
PROGRAM_KEYPAIR_PATH="/path/to/program-keypair.json"
PROGRAM_ID="your_program_id"
```

Deploy the program:

```bash
./deploy.sh program # Solana program deploy
./deploy.sh mxe     # Arcium deploy and initialization
./deploy.sh idl     # Create the on-chain IDL
```

Initialize compute definitions:

```bash
bun admin comp-defs init
```

To run a smoke test on the deployed program, you can use the script in `scripts/test-vouch.ts`.
If this scripts succeeds, your deployed program is probably working.

```bash
# dry run
bun run scripts/init-compute-defs.ts devnet # <devnet|mainnet|mainnet10k>

# real run
EXECUTE=1 bun run scripts/init-compute-defs.ts devnet # <devnet|mainnet|mainnet10k>
```