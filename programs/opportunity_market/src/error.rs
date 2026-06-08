use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient reward funding")]
    InsufficientRewardFunding,
    #[msg("Invalid parameters")]
    InvalidParameters,
    #[msg("Invalid option ID")]
    InvalidOptionId,
    #[msg("Stake account has no recorded stake")]
    NoStake,
    #[msg("Market winner already selected")]
    WinnerAlreadySelected,
    #[msg("Stake already revealed")]
    AlreadyRevealed,
    #[msg("Stake not yet revealed")]
    NotRevealed,
    #[msg("Tally already incremented for this stake account")]
    TallyAlreadyIncremented,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Token mint does not match account mint")]
    InvalidMint,
    #[msg("Already unstaked")]
    AlreadyUnstaked,
    #[msg("Already staked for this stake account")]
    AlreadyStaked,
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
    #[msg("Invalid fee rates")]
    InvalidFeeRates,
    #[msg("Option still needed")]
    OptionStillNeeded,
    #[msg("Creator mismatch")]
    CreatorMismatch,
    #[msg("No winning option has a finalized stake")]
    NoFinalizedWinningOption,
    #[msg("No reward to claim")]
    NoRewardToClaim,
    #[msg("Reward already claimed")]
    RewardAlreadyClaimed,
    #[msg("Operation is not permitted in the current market phase")]
    WrongMarketPhase,
}
