use anchor_lang::prelude::*;

use crate::constants::PLATFORM_CONFIG_SEED;
use crate::state::{FeeRates, PlatformConfig};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitPlatformParameters {
    pub name: String,
    pub user_platform_fee_bp: u16,
    pub user_reward_pool_fee_bp: u16,
    pub user_creator_fee_bp: u16,
    pub sponsor_platform_fee_bp: u16,
    pub fee_claim_authority: Pubkey,
    pub reveal_authority: Pubkey,
    pub min_time_to_vouch_seconds: u64,
    pub reveal_period_seconds: u64,
    pub market_resolution_deadline_seconds: u64,
}

#[derive(Accounts)]
#[instruction(params: InitPlatformParameters)]
pub struct InitPlatformConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + PlatformConfig::INIT_SPACE,
        seeds = [PLATFORM_CONFIG_SEED, payer.key().as_ref(), params.name.as_bytes()],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    pub system_program: Program<'info, System>,
}

pub fn init_platform_config(
    ctx: Context<InitPlatformConfig>,
    params: InitPlatformParameters,
) -> Result<()> {
    let platform_config = PlatformConfig::try_new(
        ctx.bumps.platform_config,
        params.name,
        ctx.accounts.payer.key(),
        params.fee_claim_authority,
        FeeRates::new(
            params.user_platform_fee_bp,
            params.user_reward_pool_fee_bp,
            params.user_creator_fee_bp,
            params.sponsor_platform_fee_bp,
        )?,
        params.market_resolution_deadline_seconds,
        params.min_time_to_vouch_seconds,
        params.reveal_authority,
        params.reveal_period_seconds,
    )?;
    ctx.accounts.platform_config.set_inner(platform_config);
    Ok(())
}
