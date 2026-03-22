use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, RevealPeriodExtendedEvent};
use crate::state::OpportunityMarket;

#[derive(Accounts)]
pub struct EndRevealPeriod<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = market.reveal_period_authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn end_reveal_period(ctx: Context<EndRevealPeriod>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    let open_timestamp = market.open_timestamp.ok_or(ErrorCode::MarketNotOpen)?;

    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    let stake_end = open_timestamp
        .checked_add(market.time_to_stake)
        .ok_or(ErrorCode::Overflow)?;

    // Must be in the reveal period
    require!(current_timestamp >= stake_end, ErrorCode::StakingNotActive);

    let reveal_end = stake_end
        .checked_add(market.time_to_reveal)
        .ok_or(ErrorCode::Overflow)?;

    require!(current_timestamp < reveal_end, ErrorCode::RevealPeriodEnded);

    // Set reveal period to end now
    market.time_to_reveal = current_timestamp - stake_end;

    emit_ts!(RevealPeriodExtendedEvent {
        market: market.key(),
        authority: ctx.accounts.authority.key(),
        new_time_to_reveal: market.time_to_reveal,
    });

    Ok(())
}
