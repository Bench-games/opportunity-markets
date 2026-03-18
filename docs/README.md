
# What Are Opportunity Markets?

**In Summary:**

1. A decision maker creates an Opportunity Market and deposits a reward sum
    - For example, a VC firm can create an Opportunity Market titled *"Which companies should we invest in next quarter?"*
2. Anybody can add new options to the market
    - For example, *"Acme Inc"*
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
The market creator has the right to choose the winning options according to whichever they believe are the most valuable.
There can be multiple winning options, each assigned different sized slice of the total reward pool.

2. **Opportunity Markets provide the market creator with capital backed signals of new opportunities**

The market creator has exclusive access to these signals through selective disclosure of encrypted staking data.
Staking data is confidential while the market is open, allowing the creator to take advantage of opportunities before the public knows about them.

# Technical Description of The Protocol

The protocol is implemented as a Solana smart contract. 
Confidential staking is implemented with Arcium.

## PDAs

Program Derived Accounts and what purpose they serve in the protocol.

### `EncryptedTokenAccount`

Encrypted Token Accounts (ETA) store an encrypted balance of SPL tokens for a given user.
User calls the `wrap_encrypted_tokens` instruction to add balance to their ETA.
The user can always reclaim their ETA balance back to SPL tokens by calling `unwrap_encrypted_tokens`

Users use their ETA balance to stake on Opportunity Market options.

A user can have one normal ETA or multiple ephemeral ETAs.
Ephemeral ETAs exist to allow better concurrency (particularly allowing concurrent `reveal_shares` calls for the same user).
We lock the ETA while waiting for Arcium callback to complete.

### `ShareAccount`

When a user stakes on an Opportunity Market option, a Share Account is created to keep track of how much money the user staked and for which option.
The amount and option choice are both encrypted. The stake amount is deducted from the users ETA.

Once a user's stake is stored in a Share Account, it cannot be increased, only withdrawn completely.
A user can, however, have multiple Share Accounts for the same option. So if they wish to stake more, a new Share Account can be opened.

Once the market closes, to claim any potential reward from a Share Account that represents a stake in the winning option, the `reveal_shares` instruction must be called. This decrypts and records the users stake amount and option choice in plain text in the Share Account struct.
Calling this instruction is permissionless and can therefore be automated in a "cranker" process, so users don't have to do it themselves.

After reavealing, the user can claim their reward and close their Share Account by calling `close_share_account`.

### `OpportunityMarketOption`

Account representing an option in the market. This market also holds the tally of the total revealed stake amount for this option.

### `OpportunityMarket`

Account representing the Opportunity Market itself. This account stores the market configuration and keeps track of current market state.

## Opportunity Market Lifecycle

### Creating the market

The decision maker creates and configures the market account by calling the `create_market` instruction.

### Adding initial options

The market is not yet open to staking, but users can already start adding options.
The users must stake a certain minimum amount on the option they create.
This is done via the instruction `add_market_option`.

The market creator can create options without staking on them via `add_market_option_as_creator`,

### Opening the Opportunity Market for Staking

The market creator (or whoever for that matter) sends SPL tokens to the Opporunity Market account's token account to fund the reward pool. The size of the reward pool is configured on creation but can also be extended later via the `increase_reward_pool` instruction.

The market creator then opens the market to staking by calling the `open_market` instruction.

### Staking

Once the market is open, users can stake on options.
The market is open for a certain period of time, the length of which is configured upon market creation.
During this time, users and the market creator can keep adding new options.

Staking is done with the `stake` instruction. This deducts balance from the user's ETA and records the stake amount as an encrypted field in their `ShareAccount`, alonside the encrypted identifier of the option they voted for.

The user can claim back their stake amount with a delay by calling the `unstake_early` instruction.
After calling that, they must wait a certain period of time before actually claiming back their stake via `do_unstake_early`.
The latter instruction is permissionless, and can be moved to a "cranker" process to improve UX.
Users are incentiviced to keep their stake in the market as long as possible. More about that in later section *Distributing the Reward*.

### Selecting the Winning Options

The market creator can choose up to 10 winning options and choose how the reward pool is split between them.
This is done via the `select_winning_option` instruction.
If the market is configured to allow closing early, this instruction can be called while the staking is still active, ending the staking period immediately.

### Distributing the Reward

Once the winning options have been selected, those who staked on them are entitled to a slice of the reward pool.

Before the reward can be claimed however, the stake amount and option choice of the eligible users' must be revealed.
Revealing must be done for each eligible `ShareAccount` via the instruction `reveal_shares`.
After that, the total option tally must be incremented via `increment_option_tally`, This increments the user's stake amount in the `OpportunityMarketOptionAccount`, the total sum of which is used for reward calculation.  
Both of these operations are permissionless, and can be done by a background "cranker" process.

After all the shares have been revealed and the tallies incremented, eligible users can claim their rewards via the `close_share_account` instruction.

We use a score system for determining how much of the total reward goes to each eligible `ShareAccount`.
The score takes three things into account:

1. **Stake amount**: how much the user staked.
2. **Time in market**: how long the stake was active relative to the total market duration. Unstaking early lowers your score.
3. **Earliness**: staking sooner after the market opens gives a bonus by a configurable max multiplier. This bonus decays over time linearly and eventually disappears (also configurable what point in time this is).

A user's reward is then their share of the total score for that winning option, multiplied by the portion of the reward pool assigned to that option by the market creator.
