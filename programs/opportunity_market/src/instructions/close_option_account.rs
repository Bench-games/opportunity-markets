use anchor_lang::prelude::*;

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, OptionClosedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct CloseOptionAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Any account, this operation is permissionless.
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
        constraint = market.reveal_ended @ ErrorCode::RevealPeriodNotOver,
    )]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        close = creator,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
        constraint = option.total_staked == 0 || option.reward_bp == 0 @ ErrorCode::OptionStillNeeded,
        has_one = creator @ ErrorCode::CreatorMismatch,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

    pub system_program: Program<'info, System>,
}

pub fn close_option_account(ctx: Context<CloseOptionAccount>, option_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let stake_end = ctx
        .accounts
        .market
        .stake_end_timestamp
        .ok_or(ErrorCode::MarketNotOpen)?;
    let select_deadline = stake_end
        .checked_add(ctx.accounts.market.market_resolution_deadline_seconds)
        .ok_or(ErrorCode::Overflow)?;

    let resolved = ctx.accounts.market.resolved_at_timestamp.is_some();
    let expired = !resolved && current_time >= select_deadline;
    require!(resolved || expired, ErrorCode::MarketNotResolved);

    emit_ts!(OptionClosedEvent {
        option: ctx.accounts.option.key(),
        option_id: option_id,
        signer: ctx.accounts.signer.key(),
        creator: ctx.accounts.creator.key(),
        market: ctx.accounts.market.key(),
    });
    Ok(())
}
