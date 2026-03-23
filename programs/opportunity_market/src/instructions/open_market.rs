use anchor_lang::prelude::*;
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOpenedEvent};
use crate::state::OpportunityMarket;

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    pub creator: Signer<'info>,

    #[account(
        mut,
        has_one = creator @ ErrorCode::Unauthorized,
        constraint = market.open_timestamp.is_none() @ ErrorCode::MarketAlreadyOpen,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn open_market(ctx: Context<OpenMarket>, open_timestamp: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Check that open_timestamp is in the future
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    require!(
        open_timestamp > current_timestamp,
        ErrorCode::InvalidTimestamp
    );

    // Set open_timestamp and transition state to Funded
    market.open_timestamp = Some(open_timestamp);

    emit_ts!(MarketOpenedEvent {
        market: market.key(),
        creator: market.creator,
        open_timestamp: open_timestamp,
    });

    Ok(())
}
