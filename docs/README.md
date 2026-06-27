
# The Opportunity Markets protocol

## Summary of how the protocol works

An Opportunity Market goes through the following stages:

1. A decision maker creates an Opportunity Market and funds the reward pool (reward can also be deposited by a 3rd party)
    - For example, a VC firm can create an Opportunity Market titled *"Which companies should we invest in next quarter?"*
2. Users add new options into the market
3. Users vouch on their preferred options
4. The decision maker selects the winning option(s)
5. All users withdraw their vouch; those who backed the winning options split the reward

While the market is open, the following information is kept confidential:

1. How much vouch each option has
2. For which option(s) a given user vouched and with how much capital

Keeping this information hidden from the public prevents herd behavior — users vouch based on their own judgment rather than following the crowd.
The decision maker **does** have access to this information the whole time and uses it to help their decision making.

Basically, you can think of the Opportunity Markets protocol as something similar to a voting protocol with a couple key distinctions:

1. **Opportunity Markets serve an advisory function in decision making**

The options with majority vouch do not automatically win.
The market creator chooses the winning options subjectively; whichever they believe are the most valuable.
There can be multiple winning options, each assigned a differently sized slice of the total reward pool.

2. **Opportunity Markets provide the market creator with capital backed signals of new opportunities**

The market creator has exclusive access to these signals through selective disclosure of encrypted vouching data.
Vouching data is confidential while the market is open, allowing the creator to take advantage of opportunities before the public knows about them.

## Opportunity Market lifecycle in detail

Following describes the complete lifecycle of an Opportunity Market (later referred to as just "market") and what purpose different instructions serve at which points of the lifecycle.

#### Creating a market

A decision maker creates a market by calling the `create_market` instruction.
The creator can adjust some of the market's configuration with parameters passed into this instruction.
Some configuration is inherited from a `PlatformConfig` account.
Each opportunity market belongs to a *platform* which defines some rules for it like fee percentages for example.
The market is associated with one SPL token mint, which must be whitelisted by the platform update authority account.
This token mint dictates the token that is used for rewards and fees within the market.

#### Adding initial options

The market is not yet open to vouching, but users can already start adding options to the market.
This is done with the `add_market_option` instruction, which is **permissionless**: any signer can create an option PDA while the market is open for vouching (including after `open_market`, until the vouching window closes).

`vouch` does not require the target option PDA to exist; it only queues MPC on an encrypted `option_id`. A third party can therefore materialize the `[OPTION_SEED, market, option_id]` PDA first ("option ID squatting"). Settlement paths such as `finalize_reveal_vouch` bind to that PDA and use `option.created_at` as the earliness anchor in `calculate_user_score`, so whoever creates the PDA sets that timestamp. This does not steal vouched funds — reveal, finalize, and claim still run against the squatted PDA — but it can break delayed-creation privacy and let a squatter manipulate earliness (for example by creating the PDA immediately after observing a vouch, or before a vouch if the `option_id` is guessable).

> [!NOTE]  
> For keeping the user's option choice confidential, the user should not add an option using a wallet that can be linked to the wallet they vouch with.
> Otherwise, it will be quite obvious that they probably vouched on the option they themselves created earlier.
> Use unlinkable wallets when creating options, and avoid predictable `option_id` values if delayed creation matters for privacy or earliness.

#### Funding the market

The market has a reward pool that at the end is distributed to those that vouched on the winning options.

A sponsor can fund the market with the `add_reward` instruction during the vouching period or before it.
Deposited rewards remain in the market pool until resolution. If the market creator fails to resolve within the given time period, sponsors reclaim their deposits via `withdraw_reward`. After resolution, sponsors can also reclaim deposits during the settlement phase if no winning vouch earned a positive score (`winning_option_active_bp == 0`). More about this in the *Resolving the market* and *Claiming rewards* sections.

#### Vouching

The market creator can open the market and begin the *vouching period* by calling `open_market`.
How long vouching is possible is dictated by the market account field `time_to_vouch`.

A user vouches in a market by first initializing with `init_vouch_account` and then calling the `vouch` instruction. It accepts the following payload:

- `amount` - deposit amount in base units of the market's token
- `selected_option_ciphertext` - encrypted ID of the option the user chose to vouch for
- `input_nonce` - random nonce used in the encryption of `selected_option_ciphertext`
- `authorized_reader_nonce` - random nonce used by Arcium encrypted computation invocation for selective disclosure of the option choice
- `user_pubkey` - user's x25519 pubkey used by Arcium encrypted computation invocation
- `state_nonce` - random nonce used by Arcium encrypted computation invocation

The `vouch` instruction triggers an Arcium encrypted computation.
This computation takes the user's encrypted option choice and re-encrypts it so that the owner of the market's `authorized_reader_pubkey` can also decrypt and view it. This gives the market creator real-time access to the vouch data.

The vouch is finalized when the callback instruction (invoked by the Arcium network) runs.
It is possible that the callback fails to run. In this case, the user can recover their stuck vouch with the `close_stuck_vouch_account`.

A user can have multiple vouch accounts for the same option, but they cannot add vouch to an existing one. So if a user wishes to vouch more on a certain option, they can just create a new vouch account and deposit in it again.

#### Vouching fee structure

The `vouch` instruction also collects fees, split into 3 configurable components:

1. Platform fee
    - Goes to the platform
2. Creator fee
    - Goes to the market creator
3. Reward pool fee
    - Goes to the reward pool, allows reward pool to grow with market volume

Creator fee and reward pool fee are refunded to winners later when they close their vouch account (after claiming any reward slice).
The reason being that, with a large amount of vouch on the winning option, it is possible the reward would get diluted to the point where a winning vouch's reward no longer covers the fees, and a winning vouching user ends up with a net-loss.

The reward pool fee can be set to a very high value. For example following configuration is possible:

Platform fee 1%, creator fee 1%, reward pool fee 98%

This setup effectively turns the opportunity market into a speculative market à la prediction markets, with significant downside for the losers and great upside for the winners. If this kind of setup were to be used, early vouch withdrawal should be disabled in the market as the user of course has no vouch to withdraw since their vouch goes to the reward pool.

#### Withdrawing Vouch

If the market configuration allows, users can reclaim their vouch back at any time with the `withdraw_vouch` instruction. Longer vouch duration however results in a higher score and more potential yield.
Otherwise, the user must wait until the vouching period ends before withdrawing a vouch.

#### Resolving the market

Once the vouching period ends, the market creator has a certain amount of time (defined by the platform config) to select the winning options.
They do this via the instruction `set_winning_option`. This can be called multiple times for different options to select multiple winners.
The instruction takes the option ID and the percentage of the reward pool that should be allocated to that option as arguments and marks the option account as one of the winning ones.
The market creator finalizes their choices and resolves the market by calling `resolve_market`.

If the market is not resolved in time, the market is considered expired. Users can reclaim the reward-pool and creator fees they paid via `close_vouch_account` (revealed vouches) or `close_unrevealed_vouch_account` (never revealed). Sponsors also get to reclaim their deposited rewards via `withdraw_reward`.

After resolution, users can withdraw a vouch without negatively impacting their potential reward amount via `withdraw_vouch`.

#### Revealing vouches

Once the market has been resolved, user option choices can be revealed.
This is permissionless and requires two transactions per vouch account:

**`reveal_vouch`** - This invokes an Arcium encrypted computation that decrypts the user's option choice and returns it as plaintext to the callback.
The callback then records the plaintext option ID to the vouch account struct stored on chain.
Each vouch account enforces a 5-minute cooldown between queue attempts (`REVEAL_VOUCH_COOLDOWN_SECONDS`), tracked via `last_reveal_vouch_at`.
This limits how often an in-flight reveal computation can be replaced while still allowing retries after a failed or stuck callback.

**`finalize_reveal_vouch`** - Now that the option ID is public, this instruction can be called to calculate the user's score and add that to the total score tally for the option for later reward distribution calculation. For vouches on winning options (`reward_bp > 0`), this also deducts the refundable creator and reward-pool fees from the market's accounting counters; the token transfer for those fees happens later in `close_vouch_account`.

There is a reveal period (configured per platform, snapshotted on the market at creation).
Before that period elapses, only the platform's `reveal_authority` (read live from platform config) can close it via `end_reveal_period`.
After the market's snapshotted `reveal_period_seconds` have elapsed since resolution, anyone can call the same instruction.

**Early end (V1 design choice):** The reveal authority may end the reveal window at any time after resolution, without waiting for the full snapshotted period. This is intentional platform-operator control in V1 and may change in a future version. Once `end_reveal_period` runs, `reveal_vouch` and `finalize_reveal_vouch` are no longer callable; users who have not revealed and finalized in time can reclaim their vouch via `close_unrevealed_vouch_account` but forfeit reward eligibility.

#### Claiming rewards

After the reveal period has passed (`end_reveal_period` has run), settlement proceeds as follows:

1. **`withdraw_vouch`** — return vouched principal (required before closing the vouch account).
2. **`claim_rewards`** — for users on winning options with a recorded score: pays the pro-rata reward slice only and sets `rewards_claimed = true`. No fee refund in this step.
3. **`close_vouch_account`** — for winning users who claimed: refunds creator and reward-pool fees, closes the account, and returns rent. Non-winning users can close directly after withdrawing their vouch to reclaim rent.

Winning users with a recorded score must call `claim_rewards` before `close_vouch_account`. Users on non-winning options can close directly after withdrawing their vouch to reclaim account rent; their fees remain in the market for creator/platform collection.

When no winning vouch earned a positive score (`winning_option_active_bp == 0`), no reward slices are distributed. `claim_rewards` succeeds with a zero payout for eligible winning-option vouches; users recover reward-pool fees on close. Sponsors can reclaim their deposits via `withdraw_reward` in this case.

Users who never revealed can close via `close_unrevealed_vouch_account` after the reveal period ends. When `winning_option_active_bp == 0`, this refunds the reward-pool fee; otherwise unrevealed vouches forfeit reward eligibility and fee refunds on resolved markets.

`end_reveal_period` can run even when `winning_option_active_bp == 0`, so markets are not stranded when every finalized winning vouch has score zero.

#### Reward calculation

When the market is resolved, the reward pool is split among the winning options according to the percentages set by the market creator. Each option's slice is then distributed across its users in proportion to their **score**.

A vouching user's score is the product of three factors:

$$\text{score} = s \cdot t \cdot e$$

- $s$ = vouch amount, in the market token's base units.
- $t$ = how long the user was vouched, capped at when vouching closes
- $e$ = the earliness factor, in $[1, m]$

 Earliness factor $e$ decays linearly from a maximum multiplier $m$ (`earliness_multiplier` in market account) down to $1$ over a configurable window (`earliness_cutoff_seconds` in market account). User that vouches on an option right after it's created gets $e=m$, whereas user vouching at the earliness window boundary or later gets $e=1$.
