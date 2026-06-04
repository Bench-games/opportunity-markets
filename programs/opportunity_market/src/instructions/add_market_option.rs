use anchor_lang::prelude::*;

use crate::constants::OPTION_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOptionCreatedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct AddMarketOption<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        constraint = market.resolved_at_timestamp.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        init,
        payer = signer,
        space = 8 + OpportunityMarketOption::INIT_SPACE,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    pub system_program: Program<'info, System>,
}

pub fn add_market_option(ctx: Context<AddMarketOption>, option_id: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Enforce staking period is not over (if market is open)
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    if let Some(staking_window_end) = market.staking_window_end {
        require!(
            current_timestamp <= staking_window_end,
            ErrorCode::TimeWindowMismatch
        );
    }

    // Increment total options
    market.total_options += 1;

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.id = option_id;
    option.created_at = current_timestamp;
    option.creator = ctx.accounts.signer.key();

    emit_ts!(MarketOptionCreatedEvent {
        option: option.key(),
        market: market.key(),
        signer: ctx.accounts.signer.key(),
        id: option.id,
    });

    Ok(())
}
