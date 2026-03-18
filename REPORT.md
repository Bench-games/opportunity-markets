# Security Audit Report: Opportunity Markets

**Date:** 2026-03-18
**Scope:** Solana program (`programs/opportunity_market/`), Arcium circuits (`encrypted-ixs/`)
**Focus:** Encryption safety, nonce consistency, race conditions, classic Solana vulnerabilities

---

## CRITICAL

### C-1: `claim_pending_deposit` missing `!locked` check — encrypted state corruption and potential fund theft

**File:** `programs/opportunity_market/src/instructions/claim_pending_deposit.rs:17-23`

The `ClaimPendingDeposit` account struct has no `!encrypted_token_account.locked` constraint. A user can call `claim_pending_deposit` while an MPC computation (from `wrap_encrypted_tokens`) is in-flight.

**Attack scenario (double-wrap):**

1. User calls `wrap_encrypted_tokens` with amount **A**. Tokens transfer to vault, `pending_deposit = A`, `locked = true`.
2. User calls `claim_pending_deposit`. Gets **A** tokens back, `pending_deposit = 0`, `locked = false`. (No lock check blocks this.)
3. User calls `wrap_encrypted_tokens` with amount **B**. Tokens transfer to vault, `pending_deposit = B`, `locked = true`.
4. **Callback #1** arrives (from step 1). Checks `pending_deposit > 0` (B > 0 ✓) and `locked` (true ✓) — **passes**. Writes encrypted state = `original_balance + A`. Sets `pending_deposit = 0`, `locked = false`.
5. **Callback #2** arrives (from step 3). Checks `pending_deposit > 0` (0 — **fails**). Encrypted state is NOT updated.

**Result:** User paid **B** tokens net (A was refunded in step 2), but encrypted balance reflects `original + A`. If **A > B**, the user has phantom balance backed by nothing in the vault. They can `unwrap_encrypted_tokens` to drain `A - B` tokens belonging to other users.

The wrap callback has no way to distinguish *which* pending deposit it corresponds to — it only checks "is there a pending deposit and is the account locked?" which is satisfied by the *second* wrap.

**Root cause:** `claim_pending_deposit` does not enforce `!encrypted_token_account.locked`.

> ✅ **Fixed** — Added `!locked` constraint to `claim_pending_deposit`, fixed `wrap_encrypted_tokens_callback` to unlock + return `Ok(())` on failure (consistent with other callbacks), and added `EncryptedTokensWrappedError` event.

---

### C-2: `increment_option_tally` missing `revealed_option == option_index` check — reward pool drain

**File:** `programs/opportunity_market/src/instructions/increment_option_tally.rs:39-101`

The instruction loads an `option` account derived from `option_index`, and a `share_account` for a specific user. It adds the user's `revealed_amount` to `option.total_shares` and `option.total_score`, and records `revealed_score` on the `share_account`. However, it **never checks** that `share_account.revealed_option == option_index`.

This means a user can increment the tally on **any** option, regardless of which option they actually voted for.

**Attack scenario:**

1. User stakes on winning **option B**. After reveal: `revealed_option = B`, `revealed_amount = 100`.
2. User calls `increment_option_tally` with `option_index = A` (a non-winning option, or any other option).
3. User's `revealed_amount` (100) is added to **option A's** `total_score`, not option B's.
4. `share_account.total_incremented = true` and `share_account.revealed_score` is set.
5. User calls `close_share_account` with `option_index = B` (matching their `revealed_option`).
6. Reward calculation: `user_reward = user_score / option_B.total_score * reward_B`.
   Since the user's score was **not** added to option B's `total_score`, the denominator is too small.

**Result:** The user's reward is inflated because `total_score` for their option doesn't include their contribution. With multiple attackers or large stakes, the sum of claimed rewards exceeds the reward pool, causing later claimants to fail with insufficient funds.

**Root cause:** No validation that `share_account.revealed_option == option_index` before incrementing.

> ✅ **Fixed** — Added `revealed_option == option_index` check in `increment_option_tally`.

---

## HIGH

### H-1: Score calculation ignores configurable `earliness_cutoff_seconds`

**Files:** `programs/opportunity_market/src/score.rs:5`, `programs/opportunity_market/src/state.rs:72`

The `OpportunityMarket` struct stores `earliness_cutoff_seconds` (copied from `CentralState` at market creation). However, `calculate_user_score` in `score.rs` uses the **hardcoded** constant:

```rust
pub const EARLINESS_INTERSECTION_POINT_SECONDS: u64 = 86_400;
```

The `increment_option_tally` instruction calls `calculate_user_score(open_timestamp, stake_end, staked_at_timestamp, revealed_amount)` without passing `market.earliness_cutoff_seconds`. The configurable field is dead code — all markets use a fixed 1-day earliness window regardless of configuration.

**Impact:** Admin configuration has no effect. Markets that need different earliness parameters cannot get them.

> ✅ **Fixed** — Added `earliness_cutoff_seconds` parameter to `calculate_user_score` and `calculate_user_score_components`; `increment_option_tally` now passes `market.earliness_cutoff_seconds`.

---

### H-2: Ghost options after failed `add_market_option` callback

**Files:** `programs/opportunity_market/src/instructions/add_market_option.rs:121-132` (original) and `:245-261` (callback error path)

When `add_market_option` executes:
1. `market.total_options` is incremented (line 122)
2. The `option` account is created via `init` with `initialized = false` (line 132)
3. The share account and ETA are locked

If the MPC callback fails (error path at line 245):
- `share_account.staked_at_timestamp` is rolled back to `None`
- Accounts are unlocked
- But `market.total_options` is **NOT** decremented
- The `option` account still exists with `initialized = false`

**Impact:**
- `select_winning_options` validates `option_index <= market.total_options`. The uninitialized ghost option can be selected as a winner.
- The ghost option's index is "consumed" — no new option can reuse it (PDA collision). The next option must use `total_options + 1`, leaving a gap.
- While stakers can't directly exploit ghost options (their stake callback also failed), it creates inconsistent state.

> ⏳ **Deferred** — marked with TODO comment for future work.

---

## MEDIUM

### M-1: `select_winning_options` early close can cause score calculation failure

**File:** `programs/opportunity_market/src/instructions/select_winning_options.rs:68-69`

When closing a market early:
```rust
market.time_to_stake = (current_timestamp - open_timestamp).saturating_sub(1);
```

This sets `stake_end = open_timestamp + time_to_stake = current_timestamp - 1`. If a user staked at `current_timestamp` (same second as the early close), then in `increment_option_tally` → `calculate_user_score`:

```rust
let actual_stake_duration = market_closed.checked_sub(user_staked_at) // (current - 1) - current → underflow!
```

This returns `ErrorCode::Overflow`, permanently blocking the user from incrementing their tally and claiming rewards. Their stake is refunded via `reveal_shares`, but they can never receive their portion of the reward pool despite having staked on a winning option.

> ✅ **Fixed** — Removed `saturating_sub(1)` from early-close `time_to_stake` calculation; `select_winning_options` already prevents new stakes by setting `selected_options`.

---

### M-2: `unwrap_encrypted_tokens` does not check `is_initialized`

**File:** `programs/opportunity_market/src/instructions/unwrap_encrypted_tokens.rs:93-109`

The `unwrap_encrypted_tokens` instruction does not check `encrypted_token_account.is_initialized` before reading encrypted state and sending it to the MPC circuit. The circuit always calls `balance_ctx.to_arcis()` (no `is_initialized` branch, unlike `wrap_encrypted_tokens`).

If called on an uninitialized ETA (encrypted_state is all zeros), the MPC would attempt to decrypt zero ciphertexts, producing undefined results. While the insufficient-balance error flag in the circuit likely prevents fund extraction, the behavior is undefined and depends on how the Arcium runtime handles decryption of invalid ciphertexts.

> ✅ **Fixed** — Added `require!(eta.is_initialized, ErrorCode::InvalidAccountState)` check.

---

### M-3: `claim_fees` does not constrain `fee_recipient_token_account` ownership

**File:** `programs/opportunity_market/src/instructions/claim_fees.rs:42-48`

The `fee_recipient_token_account` only constrains `token::mint` and `token::token_program`, but does **not** constrain `token::authority` to `central_state.fee_recipient`. Since both the `authority` and `fee_recipient` can invoke `claim_fees`, the authority could redirect fees to any token account, not necessarily the configured fee recipient's.

> ✅ **Fixed** — Added `token::authority = central_state.fee_recipient` constraint to `fee_recipient_token_account`.

---

### M-4: `reveal_shares` can be called before winning options are selected

**File:** `programs/opportunity_market/src/instructions/reveal_shares.rs:89-95`

The `reveal_shares` instruction only checks that the staking period is over (`current_timestamp >= reveal_start`), but does NOT require `market.selected_options.is_some()`. This means shares can be revealed (and stake refunded to ETA) before the market creator selects winners.

While likely intentional for the cranker workflow, it means the encrypted option selections become public knowledge (via `revealed_option`) before the market creator makes their decision. This leaks information that the protocol design intends to keep confidential during the decision-making phase, potentially undermining the privacy guarantees that Arcium provides.

> ✅ **Fixed** — Added `require!(market.selected_options.is_some(), ErrorCode::MarketNotResolved)` check.

---

## LOW

### L-1: `init_token_vault` has no access control; `fund_manager` field unused

**File:** `programs/opportunity_market/src/instructions/init_token_vault.rs:8-31`

Anyone can initialize a `TokenVault` for any mint with any `fund_manager`. The `fund_manager` field is stored on the vault but never referenced in any other instruction. This is dead code that adds unnecessary storage cost.

---

### L-2: `init_share_account` contains a TODO comment

**File:** `programs/opportunity_market/src/instructions/init_share_account.rs:38`

```rust
share_account.state_nonce_disclosure = 0; // initialized later TODO: why?
```

A leftover TODO suggests uncertainty about the design. The `state_nonce_disclosure` is later set correctly by the `buy_opportunity_market_shares_callback` and `add_market_option_callback`, so this is not a functional bug, but the comment indicates incomplete understanding of the flow during development.

---

### L-3: Ephemeral ETA index 0 not enforced at init

**File:** `programs/opportunity_market/src/instructions/init_ephemeral_encrypted_token_account.rs:42-44`

There is no `require!(index != 0, ...)` check. If `index = 0` is passed, the `init` constraint would fail because the regular ETA already occupies that PDA. This is caught by Anchor's PDA uniqueness but produces a confusing error rather than a clear domain-specific error.

---

## INFORMATIONAL

### I-1: Callback account integrity depends entirely on Arcium

All callback functions (`wrap_encrypted_tokens_callback`, `unwrap_encrypted_tokens_callback`, `buy_opportunity_market_shares_callback`, etc.) accept accounts via the `CallbackAccount` vec specified at queue time. The callbacks themselves do **not** re-validate account relationships (e.g., that `user_token_account` belongs to the ETA owner in `unwrap_encrypted_tokens_callback`).

This is safe **if and only if** the Arcium runtime guarantees that callback accounts cannot be substituted after queuing. If Arcium has a bug in callback account enforcement, every callback in this program would be vulnerable to account substitution attacks.

### I-2: `select_winning_options` does not verify option is initialized

The winning option selection validates `option_index >= 1 && option_index <= market.total_options` but does not load the option account to check `option.initialized == true`. Combined with H-2 (ghost options), an uninitialized option could theoretically be selected as a winner.

### I-3: Reward dust accumulation

Due to integer division rounding down in `close_share_account`, the sum of all claimed rewards will be slightly less than the total reward pool. Small dust amounts will remain locked in the market's ATA permanently with no sweep mechanism.
