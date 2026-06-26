use anchor_lang::prelude::*;

use crate::constants::MAX_TIME_TO_VOUCH_SECONDS;
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

pub fn open_market(ctx: Context<OpenMarket>, time_to_vouch: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.require_phase(Clock::get()?.unix_timestamp as u64, MarketPhase::NotOpen)?;

    let clock = Clock::get()?;
    let open_timestamp = clock.unix_timestamp as u64;

    require!(
        time_to_vouch >= ctx.accounts.platform_config.min_time_to_vouch_seconds
            && time_to_vouch <= MAX_TIME_TO_VOUCH_SECONDS,
        ErrorCode::InvalidParameters
    );

    let vouching_window_end = open_timestamp
        .checked_add(time_to_vouch)
        .ok_or(ErrorCode::Overflow)?;

    market.vouching_window_end = Some(vouching_window_end);

    emit_ts!(MarketOpenedEvent {
        market: market.key(),
        creator: market.creator,
        vouching_window_end: vouching_window_end,
    });

    Ok(())
}
