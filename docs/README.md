
# What Are Opportunity Markets?

**In Summary:**

1. A decision maker creates an Opportunity Market and deposits a reward sum
    - For example, a VC firm can create an Opportunity Market titled *"Which companies should we invest in next quarter?"*
2. The market can have an arbitrary number of options to choose from
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
There can be multiple winning options, each assigned a differently sized slice of the total reward pool.

2. **Opportunity Markets provide the market creator with capital backed signals of new opportunities**

The market creator has exclusive access to these signals through selective disclosure of encrypted staking data.
Staking data is confidential while the market is open, allowing the creator to take advantage of opportunities before the public knows about them.

# Technical Description of The Protocol

The protocol is implemented as a Solana smart contract. 
Confidential staking is implemented with Arcium.

## PDAs

Program Derived Accounts and what purpose they serve in the protocol.

### `StakeAccount`

When a user stakes on an Opportunity Market option, a Stake Account is created to keep track of how much money the user staked and for which option. The option choice is encrypted, meaning anyone observing the transactions on chain cannot tell which of the available options the user staked on.

Once a user's stake is stored in a Stake Account, it cannot be increased, only withdrawn completely.
A user can, however, have multiple Stake Accounts for the same option. So if they wish to stake more, a new Stake Account can be opened.

Once the market closes (and after our "cranking" process finishes as documented in section [Distributing the Reward](#distributing-the-reward)) the owner of the Stake Account can claim their reward if the account is for one of the winning options.

### `OpportunityMarketOption`

Account representing an option in the market. This account also holds the tally of the total revealed stake amount for this option.

### `OpportunityMarket`

Account representing the Opportunity Market itself. This account stores the market configuration and keeps track of current market state.

### `TokenVault`

Vault account that tracks collected protocol fee amount. One such account per token mint.

## Opportunity Market Lifecycle

### Creating the market

The decision maker creates and configures the market account by calling the `create_market` instruction.

### Adding initial options

Options can be added at this stage by the creator with the instruction `add_market_option`

### Opening the Opportunity Market for Staking

The market creator (or whoever for that matter) sends SPL tokens to the Opportunity Market account's token account to fund the reward pool. The size of the reward pool is configured on creation but can also be extended later via the `increase_reward_pool` instruction.

The market creator then opens the market to staking by calling the `open_market` instruction.

### Staking

Once the market is open, users can stake on options.
The market is open for a certain period of time, the length of which is configured upon market creation.
During this time, more options can still be added.

Staking is done with the `stake` instruction. This requires the user to transfer at least the minimum stake amount to the Token Vault account. The user encrypts their option choice, which is then stored in their `StakeAccount`.

The user can claim back their stake amount with a delay by calling the `unstake_early` instruction (the delay can be set to zero, we have this mechanism just to allow flexibility for future design).
After the delay has passed that, the stake can be claimed via `do_unstake_early`.
The latter instruction is permissionless, and can be moved to a "cranker" process to improve UX.
Users are incentivized to keep their stake in the market as long as possible. More about that in later section [Distributing the Reward](#distributing-the-reward).

### Selecting the Winning Options

The market creator can choose up to 10 winning options and choose how the reward pool is split between them.
This is done via the `select_winning_option` instruction.
If the market is configured to allow closing early, this instruction can be called while the staking is still active, ending the staking period immediately.

Instead of selecting any winners, if the market had a small enough number of stakers, the creator can choose to withdraw the reward pool back for themselves and reward no-one by calling `withdraw_reward`.

### Unstaking

Now that the winning options have been selected, users can withdraw their stake with no penalty via `reclaim_stake`.

### Distributing the Reward

Once the winning options have been selected, those who staked on them are entitled to a slice of the reward pool.

Before the reward can be claimed however, the option choice of the eligible users must be revealed.
Revealing must be done for each eligible `StakeAccount` via the instruction `reveal_stake`.
After that, the total option stake tally must be incremented via `increment_option_tally`. This increments the user's stake amount in the `OpportunityMarketOptionAccount`, the total sum of which is used for reward calculation.  
Both of these operations are permissionless, and can be done by a background "cranker" process.

After all the winning stakes have been revealed and the tallies incremented, eligible users can claim their rewards via the `close_stake_account` instruction.

We use a score system for determining how much of the total reward goes to each eligible `StakeAccount`.
The score takes three things into account:

1. **Stake amount**: how much the user staked.
2. **Time in market**: how long the stake was active relative to the total market duration. Unstaking early lowers your score.
3. **Earliness**: staking sooner after the market opens gives a bonus by a configurable max multiplier. This bonus decays over time linearly and eventually disappears (also configurable what point in time this is).

A user's reward is then their share of the total score for that winning option, multiplied by the portion of the reward pool assigned to that option by the market creator.
