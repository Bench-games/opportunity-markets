use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketResumedEvent};
use crate::state::OpportunityMarket;

#[derive(Accounts)]
pub struct ResumeMarket<'info> {
    pub market_authority: Signer<'info>,
    #[account(
        mut,
        has_one = market_authority @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn resume_market(ctx: Context<ResumeMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(market.open_timestamp.is_some(), ErrorCode::MarketNotOpen);
    require!(market.selected_options.is_none(), ErrorCode::WinnerAlreadySelected);
    require!(market.paused, ErrorCode::MarketNotPaused);

    market.paused = false;

    emit_ts!(MarketResumedEvent {
        market: market.key(),
    });

    Ok(())
}
