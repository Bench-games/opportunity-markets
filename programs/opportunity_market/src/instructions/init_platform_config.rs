use anchor_lang::prelude::*;

use crate::constants::{
    MAX_PLATFORM_NAME_LEN, MAX_REVEAL_PERIOD_SECONDS, MIN_PLATFORM_NAME_LEN,
    MIN_REVEAL_PERIOD_SECONDS, PLATFORM_CONFIG_SEED,
};
#[cfg(feature = "production-settings")]
use crate::constants::{MIN_MARKET_RESOLUTION_DEADLINE_SECONDS, MIN_TIME_TO_STAKE_FLOOR_SECONDS};
use crate::error::ErrorCode;
use crate::state::{FeeRates, PlatformConfig};

#[derive(Accounts)]
#[instruction(name: String)]
pub struct InitPlatformConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + PlatformConfig::INIT_SPACE,
        seeds = [PLATFORM_CONFIG_SEED, payer.key().as_ref(), name.as_bytes()],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    pub system_program: Program<'info, System>,
}

pub fn init_platform_config(
    ctx: Context<InitPlatformConfig>,
    name: String,
    platform_fee_bp: u16,
    reward_pool_fee_bp: u16,
    creator_fee_bp: u16,
    fee_claim_authority: Pubkey,
    reveal_authority: Pubkey,
    min_time_to_stake_seconds: u64,
    reveal_period_seconds: u64,
    market_resolution_deadline_seconds: u64,
) -> Result<()> {
    require!(
        name.len() >= MIN_PLATFORM_NAME_LEN && name.len() <= MAX_PLATFORM_NAME_LEN,
        ErrorCode::InvalidParameters
    );

    #[cfg(feature = "production-settings")]
    require!(
        market_resolution_deadline_seconds >= MIN_MARKET_RESOLUTION_DEADLINE_SECONDS,
        ErrorCode::InvalidParameters
    );
    #[cfg(feature = "production-settings")]
    require!(
        min_time_to_stake_seconds >= MIN_TIME_TO_STAKE_FLOOR_SECONDS,
        ErrorCode::InvalidParameters
    );
    require!(
        (MIN_REVEAL_PERIOD_SECONDS..=MAX_REVEAL_PERIOD_SECONDS).contains(&reveal_period_seconds),
        ErrorCode::InvalidParameters
    );

    let platform_config = &mut ctx.accounts.platform_config;
    platform_config.bump = ctx.bumps.platform_config;
    platform_config.name = name;
    platform_config.update_authority = ctx.accounts.payer.key();
    platform_config.fee_rates = FeeRates::new(platform_fee_bp, reward_pool_fee_bp, creator_fee_bp)?;
    platform_config.fee_claim_authority = fee_claim_authority;
    platform_config.reveal_authority = reveal_authority;
    platform_config.min_time_to_stake_seconds = min_time_to_stake_seconds;
    platform_config.reveal_period_seconds = reveal_period_seconds;
    platform_config.market_resolution_deadline_seconds = market_resolution_deadline_seconds;

    Ok(())
}
