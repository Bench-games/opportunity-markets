use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketResolvedEvent};
use crate::state::{MarketPhase, OpportunityMarket};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub market_authority: Signer<'info>,

    #[account(
        mut,
        has_one = market_authority @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn resolve_market(ctx: Context<ResolveMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(
        market.resolved_at_timestamp.is_none(),
        ErrorCode::WinnerAlreadySelected,
    );
    require!(
        market.winning_option_allocation == 10_000,
        ErrorCode::InvalidParameters,
    );

    let current_timestamp = Clock::get()?.unix_timestamp as u64;
    market.require_phase(current_timestamp, MarketPhase::Selection)?;

    market.resolved_at_timestamp = Some(current_timestamp);

    emit_ts!(MarketResolvedEvent {
        market: market.key(),
        market_authority: ctx.accounts.market_authority.key(),
    });

    Ok(())
}
