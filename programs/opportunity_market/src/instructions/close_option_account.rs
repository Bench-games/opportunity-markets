use anchor_lang::prelude::*;

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, OptionClosedEvent};
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption, PlatformConfig};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct CloseOptionAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        address = market.platform @ ErrorCode::Unauthorized,
        constraint = platform_config.option_creation_authority == signer.key() @ ErrorCode::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        close = signer,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
        constraint = option.unclaimed_gross_vouch == 0 || option.reward_bp == 0 @ ErrorCode::OptionStillNeeded,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

    pub system_program: Program<'info, System>,
}

pub fn close_option_account(ctx: Context<CloseOptionAccount>, option_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    ctx.accounts
        .market
        .require_phase_at_least(current_time, MarketPhase::Settlement)?;

    emit_ts!(OptionClosedEvent {
        option: ctx.accounts.option.key(),
        option_id: option_id,
        market: ctx.accounts.market.key(),
    });
    Ok(())
}
