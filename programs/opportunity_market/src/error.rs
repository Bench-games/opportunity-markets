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
    #[msg("Vouch account has no recorded vouch")]
    NoVouch,
    #[msg("Market winner already selected")]
    WinnerAlreadySelected,
    #[msg("Vouch already revealed")]
    AlreadyRevealed,
    #[msg("Vouch not yet revealed")]
    NotRevealed,
    #[msg("Tally already incremented for this vouch account")]
    TallyAlreadyIncremented,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Token mint does not match account mint")]
    InvalidMint,
    #[msg("Vouch already withdrawn")]
    AlreadyVouchWithdrawn,
    #[msg("Already vouched for this vouch account")]
    AlreadyVouched,
    #[msg("Account is locked")]
    Locked,
    #[msg("Invalid account state")]
    InvalidAccountState,
    #[msg("No fees to claim")]
    NoFeesToClaim,
    #[msg("Vouch account is not in a stuck or failed state")]
    VouchNotStuck,
    #[msg("Vouch amount is below the market minimum")]
    VouchBelowMinimum,
    #[msg("Invalid fee rates")]
    InvalidFeeRates,
    #[msg("Option still needed")]
    OptionStillNeeded,
    #[msg("Creator mismatch")]
    CreatorMismatch,
    #[msg("No winning option has a finalized vouch")]
    NoFinalizedWinningOption,
    #[msg("No reward to claim")]
    NoRewardToClaim,
    #[msg("Reward already claimed")]
    RewardAlreadyClaimed,
    #[msg("Operation is not permitted in the current market phase")]
    WrongMarketPhase,
}
