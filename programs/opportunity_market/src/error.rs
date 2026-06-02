use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Computation aborted")]
    AbortedComputation,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient reward funding")]
    InsufficientRewardFunding,
    #[msg("Invalid parameters")]
    InvalidParameters,
    #[msg("Market is already open")]
    MarketAlreadyOpen,
    #[msg("Invalid option ID")]
    InvalidOptionId,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Operation called outside its permitted time window")]
    TimeWindowMismatch,
    #[msg("Stake account has no recorded stake")]
    NoStake,
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
    #[msg("No fees to claim")]
    NoFeesToClaim,
    #[msg("Stake account is not in a stuck or failed state")]
    StakeNotStuck,
    #[msg("Stake amount is below the market minimum")]
    StakeBelowMinimum,
    #[msg("Deadline for selecting winning options has passed")]
    SelectOptionsDeadlinePassed,
    #[msg("Invalid fee rates")]
    InvalidFeeRates,
    #[msg("Option still needed")]
    OptionStillNeeded,
    #[msg("Creator mismatch")]
    CreatorMismatch,
    #[msg("Reveal period not over")]
    RevealPeriodNotOver,
    #[msg("No winning option has a finalized stake")]
    NoFinalizedWinningOption,
    #[msg("No reward to claim")]
    NoRewardToClaim,
    #[msg("Reward already claimed")]
    RewardAlreadyClaimed,
}
