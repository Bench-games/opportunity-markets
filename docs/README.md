
# The Opportunity Markets protocol

## Summary of how the protocol works

An Opportunity Market goes through the following stages:

1. A decision maker creates an Opportunity Market and funds the reward pool (reward can also be deposited by a 3rd party)
    - For example, a VC firm can create an Opportunity Market titled *"Which companies should we invest in next quarter?"*
2. Participants add new options into the market
3. Participants stake on their preferred options
4. The decision maker selects the winning option(s)
5. All participants withdraw their stake; those who backed the winning options split the reward

While the market is open, the following information is kept confidential:

1. How much stake each option has
2. For which option(s) a given user staked and with how much capital

Keeping this information hidden from the public prevents herd behavior — participants vote based on their own judgment rather than following the crowd.
The decision maker **does** have access to this information the whole time and uses it to help their decision making.

Basically, you can think of the Opportunity Markets protocol as something similar to a voting protocol with a couple key distinctions:

1. **Opportunity Markets serve an advisory function in decision making**

The options with majority stake do not automatically win.
The market creator chooses the winning options subjectively; whichever they believe are the most valuable.
There can be multiple winning options, each assigned a differently sized slice of the total reward pool.

2. **Opportunity Markets provide the market creator with capital backed signals of new opportunities**

The market creator has exclusive access to these signals through selective disclosure of encrypted staking data.
Staking data is confidential while the market is open, allowing the creator to take advantage of opportunities before the public knows about them.

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

The market is not yet open to staking, but users can already start adding options to the market.
This is done with the `add_market_option` instruction.


> [!NOTE]  
> For keeping the user's option choice confidential, the user should not add an option using a wallet that can be linked to the wallet they stake with.
> Otherwise, it will be quite obvious that they probably staked on the option they themselves created earlier.

Options can also be added after the market is opened for staking, until the staking period closes.

#### Funding the market

The market has a reward pool that at the end is distributed to those that staked on the winning options.

A sponsor can choose to fund the market with the `add_reward` instruction during the staking period or before it.
They can lock the reward permanently or choose to add a withdrawable reward.
A withdrawable reward can be withdrawn during the staking period or before it.

In the case that the market creator fails to choose winning options for the market within the given time period, all rewards, including locked ones, can be withdrawn. More about this in the *Resolving the market* section.

#### Staking

The market creator can open the market and begin the *staking period* by calling `open_market`.
How long staking is possible is dictated by the market account field `time_to_stake`.

A user stakes in a market by first initializing with `init_stake_account` and then calling the `stake` instruction. It accepts the following payload:

- `amount` - stake amount in base units of the market's token
- `selected_option_ciphertext` - encrypted ID of the option the user chose to stake for
- `input_nonce` - random nonce used in the encryption of `selected_option_ciphertext`
- `authorized_reader_nonce` - random nonce used by Arcium encrypted computation invocation for selective disclosure of the option choice
- `user_pubkey` - user's x25519 pubkey used by Arcium encrypted computation invocation
- `state_nonce` - random nonce used by Arcium encrypted computation invocation

The `stake` instruction triggers an Arcium encrypted computation.
This computation takes the user's encrypted option choice and re-encrypts it so that the owner of the market's `authorized_reader_pubkey` can also decrypt and view it. This gives the market creator real-time access to the stake data.

The stake is finalized when the callback instruction (invoked by the Arcium network) runs.
It is possible that the callback fails to run. In this case, the user can recover their stuck stake with the `close_stuck_stake_account`.

A user can have multiple stake accounts for the same option, but they cannot add stake to an existing one. So if a user wishes to stake more on a certain option, they can just create a new stake account and stake in it again.

#### Staking fee structure

The `stake` instruction also collects fees, split into 3 configurable components:

1. Platform fee
    - Goes to the platform
2. Creator fee
    - Goes to the market creator
3. Reward pool fee
    - Goes to the reward pool, allows reward pool to grow with market volume

Creator fee and reward pool fee are refunded to the winners later together with their reward.
The reason being that, with a large amount of stake on the winning option, it is possible the reward would get dilluted to the point where a winning stake's reward no longer covers the fees, and a winning staker ends up with a net-loss.

The reward pool fee can be set to a very high value. For example following configuration is possible:

Platform fee 1%, creator fee 1%, reward pool fee 98%

This setup effectively turns the opportunity market into a speculative market à la prediction markets, with significant downside for the losers and great upside for the winners. If this kind of setup were to be used, early unstaking should be disabled in the market as the user of course has nothing to unstake since their stake goes to the reward pool.

#### Unstaking

If the market configuration allows, users can reclaim their stake back at any time with the `unstake` instruction. Longer stake however results in a higher score and more potential yield.
Otherwise, the user must wait until the staking period ends before unstaking.

#### Resolving the market

Once the staking period ends, the market creator has a certain amount of time (defined by the platform config) to select the winning options.
They do this via the instruction `set_winning_option`. This can be called multiple times for different options to select multiple winners.
The instruction takes the option ID and the percentage of the reward pool that should be allocated to that option as arguments and marks the option account as one of the winning ones.
The market creator finalizes their choices and resolves the market by calling `resolve_market`.

If the market is not resolved in time, the market is considered expired and users can reclaim the fees they paid via `close_stake_account`.
Sponsors also get to reclaim their deposited rewards via `withdraw_reward`.

At this point, users can also claim their stake back without negatively impacting their potential reward amount.
This is done via `reclaim_stake`.

#### Revealing stakes

Once the market has been resolved, user option choices can be revealed.
This is permissionless and requires two transactions per stake account:

**`reveal_stake`** - This invokes an Arcium encrypted computation that decrypts the user's option choice and returns it as plaintext to the callback.
The callback then records the plaintext option ID to the stake account struct stored on chain.

**`finalize_reveal_stake`** - Now that the option ID is public, this instruction can be called to calculate the user's score and add that to the total score tally for the option for later reward distribution calculation.

There is a reveal period (configured per platform, snapshotted on the market at creation).
The platform's `reveal_authority` (read live from platform config) can close it at any time after resolution via `end_reveal_period`.
After the market's snapshotted `reveal_period_seconds` have elapsed since resolution, anyone can call the same instruction.

#### Claiming rewards

After the reveal period has passsed, users that staked on one of the selected options can call `close_stake_account` to claim their slice of the reward pool and reclaim the refundable part of fees they paid. Non-winning stake accounts can also be closed via the same instruction to reclaim account rent.

#### Reward calculation

When the market is resolved, the reward pool is split among the winning options according to the percentages set by the market creator. Each option's slice is then distributed across its stakers in proportion to their **score**.

A staker's score is the product of three factors:

$$\text{score} = s \cdot t \cdot e$$

- $s$ = stake amount, in the market token's base units.
- $t$ = how long the user was staked, capped at when staking closes
- $e$ = the earliness factor, in $[1, m]$

 Earliness factor $e$ decays linearly from a maximum multiplier $m$ (`earliness_multiplier` in market account) down to $1$ over a configurable window (`earliness_cutoff_seconds` in market account). User that stakes on an option right after it's created gets $e=m$, whereas user staking at the earliness window boundary or later gets $e=1$.
