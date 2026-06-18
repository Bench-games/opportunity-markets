use anchor_lang::prelude::*;

use crate::constants::MAX_TIME_TO_STAKE_SECONDS;
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOpenedEvent};
use crate::state::{MarketPhase, OpportunityMarket, PlatformConfig};

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    pub market_authority: Signer<'info>,

    #[account(
        mut,
        has_one = market_authority @ ErrorCode::Unauthorized
    )]
    pub market: Account<'info, OpportunityMarket>,

    #[account(address = market.platform @ ErrorCode::Unauthorized)]
    pub platform_config: Account<'info, PlatformConfig>,
}

pub fn open_market(ctx: Context<OpenMarket>, time_to_stake: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.require_phase(Clock::get()?.unix_timestamp as u64, MarketPhase::NotOpen)?;

    let clock = Clock::get()?;
    let open_timestamp = clock.unix_timestamp as u64;

    require!(
        time_to_stake >= ctx.accounts.platform_config.min_time_to_stake_seconds
            && time_to_stake <= MAX_TIME_TO_STAKE_SECONDS,
        ErrorCode::InvalidParameters
    );

    let staking_window_end = open_timestamp
        .checked_add(time_to_stake)
        .ok_or(ErrorCode::Overflow)?;

    market.staking_window_end = Some(staking_window_end);

    emit_ts!(MarketOpenedEvent {
        market: market.key(),
        creator: market.creator,
        staking_window_end: staking_window_end,
    });

    Ok(())
}
