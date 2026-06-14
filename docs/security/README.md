# Security Statement

### What we want to secure

Our contract is meant to secure a large amount of user capital in the form of staked SPL tokens.
Users can deposit any amount of tokens in the program and should always be able to withdraw their stake later.
Users should never face the risk of loss-of-funds.
Users should only ever get their initial stake deposit back OR additionally be rewarded fairly according to the rules of the protocol (see [protocol documentation](/docs/README.md)).

Market sponsors should be able to deposit a market reward and trust that after the market is resolved, the reward is split according to the rules of the protocol and cannot be stolen by exploit. If the market expires without resolution, sponsors can reclaim their deposit via `withdraw_reward`.

We want to make sure that while an opportunity market is running, what option a given user staked on cannot be revealed by exploit. Likewise, total stake amounts per option while market is running should stay confidential.

We are looking to go live on Solana mainnet as soon as possible, so a security audit is critical to ensure the safety of our users' funds and correctness of the protocol.

### What we have done for security

Our protocol is build with the Anchor framework and follows best security practices against most common threats.
We have carefully designed the instructions to enforce account ownership rules (using PDA seeds constraints and `constraint` macros etc.).
We have considered common threats like re-initialization attacks by correct use of `init` vs `init_if_needed`.
We have comprehensive test coverage of our protocol including number of unhappy paths and edge-cases.

### Specific areas of concern

We use Arcium for shared encrypted on-chain state.
Arcium uses a transaction callback pattern, meaning that some operations that would be atomic within a single transaction, now take one transaction to begin and another transaction to finalize. This leaves an in-between state of waiting for the callback to come, leading to a number of edge-cases.

We operate under the assumption that invoking an Arcium computation does not guarantee the callback transaction to ever run.
If the callback never comes, and the operation in question is never finalized, there must be some escape hatch from this in-between state.
We assume that the callback will not continue to fail forever after some number of retries by calling the instruction that invokes it.

Example of this escape hatch implementation is the `close_stuck_stake_account` instruction for the case that the callback of the `stake` instruction fails to run.

There is no separate escape hatch instruction for the `reveal_stake` instruction, but instead this instruction can be called again to retry the callback as many times as needed.
