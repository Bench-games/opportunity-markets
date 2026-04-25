use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketPausedEvent};
use crate::state::OpportunityMarket;

#[derive(Accounts)]
pub struct PauseMarket<'info> {
    pub market_authority: Signer<'info>,
    #[account(
        mut,
        has_one = market_authority @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(market.open_timestamp.is_some(), ErrorCode::MarketNotOpen);
    require!(
        market.selected_options.is_none(),
        ErrorCode::WinnerAlreadySelected
    );
    require!(!market.paused, ErrorCode::MarketPaused);

    market.paused = true;

    emit_ts!(MarketPausedEvent {
        market: market.key(),
    });

    Ok(())
}
