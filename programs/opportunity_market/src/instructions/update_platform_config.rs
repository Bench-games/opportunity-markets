use anchor_lang::prelude::*;

#[cfg(feature = "production-settings")]
use crate::constants::MIN_MARKET_RESOLUTION_DEADLINE_SECONDS;
use crate::constants::{MAX_REVEAL_PERIOD_SECONDS, MIN_REVEAL_PERIOD_SECONDS};
use crate::error::ErrorCode;
use crate::state::{FeeRates, PlatformConfig};

#[derive(Accounts)]
pub struct UpdatePlatformConfig<'info> {
    pub update_authority: Signer<'info>,

    #[account(
        mut,
        has_one = update_authority @ ErrorCode::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,
}

pub fn update_platform_config(
    ctx: Context<UpdatePlatformConfig>,
    platform_fee_bp: u16,
    reward_pool_fee_bp: u16,
    creator_fee_bp: u16,
    reveal_authority: Pubkey,
    min_time_to_stake_seconds: u64,
    reveal_period_seconds: u64,
    market_resolution_deadline_seconds: u64,
) -> Result<()> {
    #[cfg(feature = "production-settings")]
    require!(
        market_resolution_deadline_seconds >= MIN_MARKET_RESOLUTION_DEADLINE_SECONDS,
        ErrorCode::InvalidParameters
    );
    require!(
        (MIN_REVEAL_PERIOD_SECONDS..=MAX_REVEAL_PERIOD_SECONDS).contains(&reveal_period_seconds),
        ErrorCode::InvalidParameters
    );

    let platform_config = &mut ctx.accounts.platform_config;
    platform_config.fee_rates = FeeRates::new(platform_fee_bp, reward_pool_fee_bp, creator_fee_bp)?;
    platform_config.reveal_authority = reveal_authority;
    platform_config.min_time_to_stake_seconds = min_time_to_stake_seconds;
    platform_config.reveal_period_seconds = reveal_period_seconds;
    platform_config.market_resolution_deadline_seconds = market_resolution_deadline_seconds;
    Ok(())
}
