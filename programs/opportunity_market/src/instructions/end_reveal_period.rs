use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, RevealPeriodEndedEvent};
use crate::state::{MarketPhase, OpportunityMarket, PlatformConfig};

#[derive(Accounts)]
pub struct EndRevealPeriod<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(address = market.platform @ ErrorCode::Unauthorized)]
    pub platform_config: Account<'info, PlatformConfig>,
}

pub fn end_reveal_period(ctx: Context<EndRevealPeriod>) -> Result<()> {
    let platform_config = &ctx.accounts.platform_config;

    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    market.require_phase(current_timestamp, MarketPhase::Revealing)?;

    // Permissionless after snapshotted reveal_period_seconds; platform reveal_authority can end anytime.
    let resolved_at = market
        .resolved_at_timestamp
        .ok_or(ErrorCode::WrongMarketPhase)?;
    let permissionless_at = resolved_at
        .checked_add(market.reveal_period_seconds)
        .ok_or(ErrorCode::Overflow)?;
    if current_timestamp < permissionless_at {
        require_keys_eq!(
            ctx.accounts.signer.key(),
            platform_config.reveal_authority,
            ErrorCode::Unauthorized,
        );
    }

    market.reveal_ended = true;

    emit_ts!(RevealPeriodEndedEvent {
        market: market.key(),
        signer: ctx.accounts.signer.key(),
    });

    Ok(())
}
