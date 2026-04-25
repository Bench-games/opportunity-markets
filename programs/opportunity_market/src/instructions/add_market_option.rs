use anchor_lang::prelude::*;

use crate::constants::OPTION_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOptionCreatedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption};

#[derive(Accounts)]
pub struct AddMarketOption<'info> {
    #[account(mut)]
    pub market_authority: Signer<'info>,

    #[account(
        mut,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
        has_one = market_authority @ ErrorCode::Unauthorized,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        init,
        payer = market_authority,
        space = 8 + OpportunityMarketOption::INIT_SPACE,
        seeds = [OPTION_SEED, market.key().as_ref(), &market.total_options.to_le_bytes()],
        bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    pub system_program: Program<'info, System>,
}

pub fn add_market_option(ctx: Context<AddMarketOption>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Enforce staking period is not over (if market is open)
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    if let Some(open_timestamp) = market.open_timestamp {
        let stake_end_timestamp = open_timestamp + market.time_to_stake;
        require!(
            current_timestamp <= stake_end_timestamp,
            ErrorCode::StakingNotActive
        );
    }

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.id = market.total_options;

    // Increment total options
    market.total_options += 1;

    emit_ts!(MarketOptionCreatedEvent {
        option: option.key(),
        market: market.key(),
        market_authority: ctx.accounts.market_authority.key(),
        id: option.id,
    });

    Ok(())
}
