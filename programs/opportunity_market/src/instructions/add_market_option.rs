use anchor_lang::prelude::*;

use crate::constants::OPTION_SEED;
use crate::error::ErrorCode;
use crate::state::{OpportunityMarket, OpportunityMarketOption};
use crate::events::{emit_ts, MarketOptionCreatedEvent};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct AddMarketOption<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
        constraint = market.creator == creator.key() || market.market_authority == creator.key() @ ErrorCode::Unauthorized,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarketOption::INIT_SPACE,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    pub system_program: Program<'info, System>,
}

pub fn add_market_option(
    ctx: Context<AddMarketOption>,
    option_id: u64,
) -> Result<()> {
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

    // Increment total options
    market.total_options += 1;

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.id = option_id;
    option.total_staked = 0;
    option.total_score = 0;

    emit_ts!(MarketOptionCreatedEvent {
        option: option.key(),
        market: market.key(),
        creator: ctx.accounts.creator.key(),
        id: option.id,
    });

    Ok(())
}
