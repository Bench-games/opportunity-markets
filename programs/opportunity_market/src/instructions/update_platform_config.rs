use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::{FeeRates, PlatformConfig};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdatePlatformParameters {
    pub platform_fee_bp: Option<u16>,
    pub reward_pool_fee_bp: Option<u16>,
    pub creator_fee_bp: Option<u16>,
    pub reveal_authority: Option<Pubkey>,
    pub min_time_to_vouch_seconds: Option<u64>,
    pub reveal_period_seconds: Option<u64>,
    pub market_resolution_deadline_seconds: Option<u64>,
}

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
    params: UpdatePlatformParameters,
) -> Result<()> {
    let platform_config = &mut ctx.accounts.platform_config;
    let new_platform_config = PlatformConfig::try_new(
        platform_config.bump,
        platform_config.name.clone(),
        platform_config.update_authority,
        platform_config.fee_claim_authority,
        FeeRates::new(
            params
                .platform_fee_bp
                .unwrap_or(platform_config.fee_rates.platform_fee_bp),
            params
                .reward_pool_fee_bp
                .unwrap_or(platform_config.fee_rates.reward_pool_fee_bp),
            params
                .creator_fee_bp
                .unwrap_or(platform_config.fee_rates.creator_fee_bp),
        )?,
        params
            .market_resolution_deadline_seconds
            .unwrap_or(platform_config.market_resolution_deadline_seconds),
        params
            .min_time_to_vouch_seconds
            .unwrap_or(platform_config.min_time_to_vouch_seconds),
        params
            .reveal_authority
            .unwrap_or(platform_config.reveal_authority),
        params
            .reveal_period_seconds
            .unwrap_or(platform_config.reveal_period_seconds),
    )?;
    platform_config.set_inner(new_platform_config);
    Ok(())
}
