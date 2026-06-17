use anchor_lang::prelude::*;

use crate::constants::{
    MAX_CREATOR_FEE_BP, MAX_PLATFORM_FEE_BP, MAX_REWARD_POOL_FEE_BP, MAX_TOTAL_FEE_BP,
};
use crate::constants::{
    MAX_PLATFORM_NAME_LEN, MAX_REVEAL_PERIOD_SECONDS, MAX_TIME_TO_STAKE_SECONDS,
    MIN_PLATFORM_NAME_LEN, MIN_REVEAL_PERIOD_SECONDS,
};
#[cfg(not(feature = "disable-prod-guardrails"))]
use crate::constants::{MIN_MARKET_RESOLUTION_DEADLINE_SECONDS, MIN_TIME_TO_STAKE_FLOOR_SECONDS};
use crate::error::ErrorCode;

#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub bump: u8,

    // Human-readable platform name
    #[max_len(20)]
    pub name: String,

    pub update_authority: Pubkey,

    // Can claim platform fees
    pub fee_claim_authority: Pubkey,

    // Platform fee in basis points
    pub fee_rates: FeeRates,

    pub market_resolution_deadline_seconds: u64,

    pub min_time_to_stake_seconds: u64,

    // Can end the reveal period at any time after market resolution.
    pub reveal_authority: Pubkey,

    // After this duration from resolution, end_reveal_period becomes permissionless.
    pub reveal_period_seconds: u64,
}

impl PlatformConfig {
    pub fn try_new(
        bump: u8,
        name: String,
        update_authority: Pubkey,
        fee_claim_authority: Pubkey,
        fee_rates: FeeRates,
        market_resolution_deadline_seconds: u64,
        min_time_to_stake_seconds: u64,
        reveal_authority: Pubkey,
        reveal_period_seconds: u64,
    ) -> Result<Self> {
        require!(
            name.len() >= MIN_PLATFORM_NAME_LEN && name.len() <= MAX_PLATFORM_NAME_LEN,
            ErrorCode::InvalidParameters
        );

        #[cfg(not(feature = "disable-prod-guardrails"))]
        require!(
            market_resolution_deadline_seconds >= MIN_MARKET_RESOLUTION_DEADLINE_SECONDS,
            ErrorCode::InvalidParameters
        );
        #[cfg(not(feature = "disable-prod-guardrails"))]
        require!(
            min_time_to_stake_seconds >= MIN_TIME_TO_STAKE_FLOOR_SECONDS,
            ErrorCode::InvalidParameters
        );
        require!(
            min_time_to_stake_seconds <= MAX_TIME_TO_STAKE_SECONDS,
            ErrorCode::InvalidParameters
        );
        require!(
            (MIN_REVEAL_PERIOD_SECONDS..=MAX_REVEAL_PERIOD_SECONDS)
                .contains(&reveal_period_seconds),
            ErrorCode::InvalidParameters
        );

        Ok(Self {
            bump,
            name,
            update_authority,
            fee_claim_authority,
            fee_rates,
            market_resolution_deadline_seconds,
            min_time_to_stake_seconds,
            reveal_authority,
            reveal_period_seconds,
        })
    }
}

/// Whitelisted token per platform
#[account]
#[derive(InitSpace)]
pub struct AllowedMint {
    pub bump: u8,
    pub platform: Pubkey,
    pub mint: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarket {
    pub bump: u8,
    pub creator: Pubkey, // part of PDA seed
    pub index: u64,      // part of PDA seed
    pub total_options: u64,

    pub platform: Pubkey,

    // Some(...) once open_market is called; None means the market is not yet open.
    pub staking_window_end: Option<u64>,

    pub resolved_at_timestamp: Option<u64>,
    pub winning_option_allocation: u16,

    // Sum of reward_bp for winning options with at least one finalize_reveal_stake.
    // Used as the payout divisor instead of 10_000 so unclaimed winner slices redistribute.
    pub winning_option_active_bp: u16,

    // Reward to be shared with stakers (in SPL token base units)
    pub reward_amount: u64,

    pub market_authority: Pubkey,

    // SPL token mint for this market (vote tokens and rewards)
    pub mint: Pubkey,

    // Score component configuration
    pub earliness_cutoff_seconds: u64,

    // Peak earliness multiplier, PRECISION-scaled. Range [PRECISION, 2*PRECISION].
    pub earliness_multiplier: u16,

    // Public key for voluntary disclosure of encrypted stake data
    pub authorized_reader_pubkey: [u8; 32],

    pub fee_rates: FeeRates,

    // Unclaimed platform fees held in the market ATA.
    pub collected_platform_fees: u64,

    // Unclaimed creator fees held in the market ATA.
    pub collected_creator_fees: u64,

    // Authority allowed to claim creator fees (only after winners are selected).
    pub creator_fee_claimer: Pubkey,

    // Snapshot from platform at create time.
    pub market_resolution_deadline_seconds: u64,

    // Snapshot from platform at create time.
    pub reveal_period_seconds: u64,

    pub reveal_ended: bool,

    // Minimum stake amount (in SPL token base units) required for a stake.
    pub min_stake_amount: u64,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
pub enum MarketPhase {
    NotOpen,
    Staking,
    Selection,
    Revealing,
    Resolution,
    Expired,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct FeeRates {
    pub platform_fee_bp: u16,
    pub reward_pool_fee_bp: u16,
    pub creator_fee_bp: u16,
}

impl FeeRates {
    pub fn new(platform_fee_bp: u16, reward_pool_fee_bp: u16, creator_fee_bp: u16) -> Result<Self> {
        require!(
            platform_fee_bp <= MAX_PLATFORM_FEE_BP,
            ErrorCode::InvalidFeeRates
        );
        require!(
            reward_pool_fee_bp <= MAX_REWARD_POOL_FEE_BP,
            ErrorCode::InvalidFeeRates
        );
        require!(
            creator_fee_bp <= MAX_CREATOR_FEE_BP,
            ErrorCode::InvalidFeeRates
        );
        require!(
            platform_fee_bp + reward_pool_fee_bp + creator_fee_bp <= MAX_TOTAL_FEE_BP,
            ErrorCode::InvalidFeeRates
        );
        Ok(Self {
            platform_fee_bp,
            reward_pool_fee_bp,
            creator_fee_bp,
        })
    }
}

impl OpportunityMarket {
    pub fn phase(&self, now: u64) -> Result<MarketPhase> {
        if self.resolved_at_timestamp.is_some() {
            return Ok(if self.reveal_ended {
                MarketPhase::Resolution
            } else {
                MarketPhase::Revealing
            });
        }

        let Some(staking_window_end) = self.staking_window_end else {
            return Ok(MarketPhase::NotOpen);
        };

        if now <= staking_window_end {
            return Ok(MarketPhase::Staking);
        }

        let deadline = staking_window_end
            .checked_add(self.market_resolution_deadline_seconds)
            .ok_or(ErrorCode::Overflow)?;
        if now <= deadline {
            return Ok(MarketPhase::Selection);
        }

        Ok(MarketPhase::Expired)
    }

    pub fn require_phase(&self, now: u64, expected: MarketPhase) -> Result<()> {
        require!(self.phase(now)? == expected, ErrorCode::WrongMarketPhase);
        Ok(())
    }

    pub fn require_phase_at_least(&self, now: u64, min: MarketPhase) -> Result<()> {
        require!(self.phase(now)? >= min, ErrorCode::WrongMarketPhase);
        Ok(())
    }

    pub fn require_phase_at_most(&self, now: u64, max: MarketPhase) -> Result<()> {
        require!(self.phase(now)? <= max, ErrorCode::WrongMarketPhase);
        Ok(())
    }

    pub fn calculate_fees(&self, amount: u64) -> Result<CollectedFees> {
        let platform_fee = (amount as u128)
            .checked_mul(self.fee_rates.platform_fee_bp as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10_000)
            .ok_or(ErrorCode::Overflow)?
            .try_into()
            .map_err(|_| ErrorCode::Overflow)?;
        let reward_pool_fee = (amount as u128)
            .checked_mul(self.fee_rates.reward_pool_fee_bp as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10_000)
            .ok_or(ErrorCode::Overflow)?
            .try_into()
            .map_err(|_| ErrorCode::Overflow)?;
        let creator_fee = (amount as u128)
            .checked_mul(self.fee_rates.creator_fee_bp as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10_000)
            .ok_or(ErrorCode::Overflow)?
            .try_into()
            .map_err(|_| ErrorCode::Overflow)?;

        Ok(CollectedFees {
            platform_fee,
            reward_pool_fee,
            creator_fee,
        })
    }

    pub fn deduct_stake_fees(&mut self, fees: &CollectedFees) -> Result<u64> {
        self.reward_amount = self
            .reward_amount
            .checked_sub(fees.reward_pool_fee)
            .ok_or(ErrorCode::Overflow)?;
        self.collected_creator_fees = self
            .collected_creator_fees
            .checked_sub(fees.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
        fees.reward_pool_fee
            .checked_add(fees.creator_fee)
            .ok_or(ErrorCode::Overflow.into())
    }
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct CollectedFees {
    pub platform_fee: u64,
    pub reward_pool_fee: u64,
    pub creator_fee: u64,
}

impl CollectedFees {
    pub fn total(&self) -> Result<u64> {
        let total_fee = self
            .platform_fee
            .checked_add(self.reward_pool_fee)
            .ok_or(ErrorCode::Overflow)?
            .checked_add(self.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
        Ok(total_fee)
    }
}
#[account]
#[derive(InitSpace)]
pub struct StakeAccount {
    pub encrypted_option: [u8; 32], // encrypted option ciphertext
    pub state_nonce: u128,
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub user_pubkey: [u8; 32], // x25519 pubkey
    pub encrypted_option_disclosure: [u8; 32],
    pub state_nonce_disclosure: u128,
    pub staked_at_timestamp: Option<u64>,
    pub unstaked_at_timestamp: Option<u64>,
    pub amount: u64,                   // net stake (after all fees)
    pub collected_fees: CollectedFees, // fees owed to the platform, reward pool, and creator
    pub revealed_option: Option<u64>,
    pub score: Option<u64>,
    pub rewards_claimed: bool,
    pub id: u32,

    // Computation account pubkey of the in-flight stake computation.
    // `Some` means a stake computation is pending; None means no stake is in flight.
    pub pending_stake_computation: Option<Pubkey>,

    // Computation account pubkey of the in-flight reveal computation.
    // `Some` means a reveal computation is pending; None means no reveal is in flight.
    pub pending_reveal_computation: Option<Pubkey>,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketOption {
    pub bump: u8,
    pub id: u64,
    pub creator: Pubkey,

    pub created_at: u64,

    pub unclaimed_stake: u64,
    pub total_score: u128,

    /// Non-zero iff this option is a winner; share of pool in basis points (0–10_000).
    pub reward_bp: u16,

    /// Set on first finalize for a winning option; gates adding `reward_bp` to `winning_option_active_bp`.
    pub included_in_active_bp: bool,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketSponsor {
    pub bump: u8,
    pub sponsor: Pubkey,
    pub market: Pubkey,
    pub reward_deposited: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAKING_END: u64 = 1_000;
    const RESOLUTION_DEADLINE_SECS: u64 = 600;
    const SELECTION_END: u64 = STAKING_END + RESOLUTION_DEADLINE_SECS;

    fn test_market(
        staking_window_end: Option<u64>,
        resolved_at_timestamp: Option<u64>,
        reveal_ended: bool,
    ) -> OpportunityMarket {
        OpportunityMarket {
            bump: 0,
            creator: Pubkey::default(),
            index: 0,
            total_options: 0,
            platform: Pubkey::default(),
            staking_window_end,
            resolved_at_timestamp,
            winning_option_allocation: 0,
            winning_option_active_bp: 0,
            reward_amount: 0,
            market_authority: Pubkey::default(),
            mint: Pubkey::default(),
            earliness_cutoff_seconds: 0,
            earliness_multiplier: 0,
            authorized_reader_pubkey: [0; 32],
            fee_rates: FeeRates {
                platform_fee_bp: 0,
                reward_pool_fee_bp: 0,
                creator_fee_bp: 0,
            },
            collected_platform_fees: 0,
            collected_creator_fees: 0,
            creator_fee_claimer: Pubkey::default(),
            market_resolution_deadline_seconds: RESOLUTION_DEADLINE_SECS,
            reveal_period_seconds: 0,
            reveal_ended,
            min_stake_amount: 0,
        }
    }

    #[test]
    fn phase_not_open_when_staking_window_unset() {
        let market = test_market(None, None, false);
        assert_eq!(market.phase(0).unwrap(), MarketPhase::NotOpen);
    }

    #[test]
    fn phase_staking_includes_staking_window_end() {
        let market = test_market(Some(STAKING_END), None, false);
        assert_eq!(market.phase(0).unwrap(), MarketPhase::Staking);
        assert_eq!(market.phase(STAKING_END).unwrap(), MarketPhase::Staking);
    }

    #[test]
    fn phase_selection_after_staking_window() {
        let market = test_market(Some(STAKING_END), None, false);
        assert_eq!(
            market.phase(STAKING_END + 1).unwrap(),
            MarketPhase::Selection
        );
        assert_eq!(market.phase(SELECTION_END).unwrap(), MarketPhase::Selection);
    }

    #[test]
    fn phase_expired_after_selection_deadline() {
        let market = test_market(Some(STAKING_END), None, false);
        assert_eq!(
            market.phase(SELECTION_END + 1).unwrap(),
            MarketPhase::Expired
        );
    }

    #[test]
    fn phase_revealing_when_resolved_before_reveal_ends() {
        let market = test_market(Some(STAKING_END), Some(STAKING_END + 1), false);
        assert_eq!(
            market.phase(STAKING_END + 1).unwrap(),
            MarketPhase::Revealing
        );
        assert_eq!(market.phase(u64::MAX).unwrap(), MarketPhase::Revealing);
    }

    #[test]
    fn phase_resolution_when_resolved_and_reveal_ended() {
        let market = test_market(Some(STAKING_END), Some(STAKING_END + 1), true);
        assert_eq!(
            market.phase(STAKING_END + 1).unwrap(),
            MarketPhase::Resolution
        );
    }

    #[test]
    fn resolved_market_ignores_calendar_selection_window() {
        let market = test_market(Some(STAKING_END), Some(STAKING_END + 1), false);
        assert_eq!(market.phase(0).unwrap(), MarketPhase::Revealing);
    }

    #[test]
    fn require_phase_helpers_reject_mismatch() {
        let market = test_market(Some(STAKING_END), None, false);
        assert!(market
            .require_phase(STAKING_END, MarketPhase::Staking)
            .is_ok());
        assert!(market
            .require_phase(STAKING_END + 1, MarketPhase::Selection)
            .is_ok());
        assert!(market
            .require_phase(STAKING_END + 1, MarketPhase::Staking)
            .is_err());
        assert!(market
            .require_phase_at_least(STAKING_END + 1, MarketPhase::Revealing)
            .is_err());
        assert!(market
            .require_phase_at_most(STAKING_END, MarketPhase::Staking)
            .is_ok());
        assert!(market
            .require_phase_at_most(STAKING_END + 1, MarketPhase::Staking)
            .is_err());
    }

    #[test]
    fn phase_errors_on_resolution_deadline_overflow() {
        let mut market = test_market(Some(u64::MAX - 10), None, false);
        market.market_resolution_deadline_seconds = 20;
        assert!(market.phase(u64::MAX).is_err());
    }
}
