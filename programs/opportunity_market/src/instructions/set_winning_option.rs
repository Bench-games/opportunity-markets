use anchor_lang::prelude::*;

use crate::constants::OPTION_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, WinningOptionSetEvent};
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct SetWinningOption<'info> {
    pub market_authority: Signer<'info>,

    #[account(
        mut,
        has_one = market_authority @ ErrorCode::Unauthorized,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,
}

pub fn set_winning_option(
    ctx: Context<SetWinningOption>,
    _option_id: u64,
    reward_bp: u16,
) -> Result<()> {
    require!(
        ctx.accounts.market.resolved_at_timestamp.is_none(),
        ErrorCode::WinnerAlreadySelected,
    );
    require!(reward_bp <= 10_000, ErrorCode::InvalidParameters);

    let now = Clock::get()?.unix_timestamp as u64;
    let market = &mut ctx.accounts.market;
    market.require_phase(now, MarketPhase::Selection)?;

    let previous = ctx.accounts.option.reward_bp;
    let new_alloc = ctx
        .accounts
        .market
        .winning_option_allocation
        .checked_sub(previous)
        .ok_or(ErrorCode::Overflow)?
        .checked_add(reward_bp)
        .ok_or(ErrorCode::Overflow)?;
    require!(new_alloc <= 10_000, ErrorCode::InvalidParameters);

    ctx.accounts.option.reward_bp = reward_bp;
    ctx.accounts.market.winning_option_allocation = new_alloc;

    emit_ts!(WinningOptionSetEvent {
        market: ctx.accounts.market.key(),
        market_authority: ctx.accounts.market_authority.key(),
        option: ctx.accounts.option.key(),
        option_id: ctx.accounts.option.id,
        reward_bp: reward_bp,
        winning_option_allocation: new_alloc,
    });

    Ok(())
}
