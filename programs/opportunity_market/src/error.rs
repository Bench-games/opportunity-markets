use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Computation aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient reward funding")]
    InsufficientRewardFunding,
    #[msg("Timestamp must be in the future")]
    InvalidTimestamp,
    #[msg("Market is already open")]
    MarketAlreadyOpen,
    #[msg("Invalid option ID")]
    InvalidOptionId,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Staking period is not active")]
    StakingNotActive,
    #[msg("Market winner already selected")]
    WinnerAlreadySelected,
    #[msg("Stake already revealed")]
    AlreadyRevealed,
    #[msg("Market not yet resolved")]
    MarketNotResolved,
    #[msg("Stake not yet revealed")]
    NotRevealed,
    #[msg("Tally already incremented for this stake account")]
    TallyAlreadyIncremented,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Reveal period has already ended")]
    RevealPeriodEnded,
    #[msg("Token mint does not match account mint")]
    InvalidMint,
    #[msg("Already unstaked")]
    AlreadyUnstaked,
    #[msg("Already staked for this stake account")]
    AlreadyStaked,
    #[msg("Deposit amount below minimum required for option creation")]
    DepositBelowMinimum,
    #[msg("Add option stake failed: insufficient balance or below minimum deposit")]
    AddOptionStakeFailed,
    #[msg("Account is locked")]
    Locked,
    #[msg("Invalid account state")]
    InvalidAccountState,
    #[msg("Unstake delay period has not passed yet")]
    UnstakeDelayNotMet,
    #[msg("Unstake has not been initiated")]
    UnstakeNotInitiated,
    #[msg("Market cannot be closed before stake period ends")]
    ClosingEarlyNotAllowed,
    #[msg("No fees to claim")]
    NoFeesToClaim,
    #[msg("Invalid winning options input")]
    InvalidWinningOptionsInput,
    #[msg("New reward amount must be greater than current")]
    RewardAmountNotIncreased,
    #[msg("Reward has already been withdrawn")]
    RewardAlreadyWithdrawn,
    #[msg("Stake account is not in a stuck or failed state")]
    StakeNotStuck,
}
