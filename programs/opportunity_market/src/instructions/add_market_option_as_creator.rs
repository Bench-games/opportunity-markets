use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::{OpportunityMarket, OpportunityMarketOption};
use crate::events::{emit_ts, MarketOptionCreatedEvent};

#[derive(Accounts)]
#[instruction(option_index: u16)]
pub struct AddMarketOptionAsCreator<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
        constraint = market.creator == creator.key() || market.market_authority == Some(creator.key()) @ ErrorCode::Unauthorized,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarketOption::INIT_SPACE,
        seeds = [b"option", market.key().as_ref(), &option_index.to_le_bytes()],
        bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    pub system_program: Program<'info, System>,
}

pub fn add_market_option_as_creator(
    ctx: Context<AddMarketOptionAsCreator>,
    option_index: u16,
    name: String,
) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Option index must match total_options + 1
    require!(
        option_index == market.total_options + 1,
        ErrorCode::InvalidOptionIndex
    );

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
    market.total_options = option_index;

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.index = option_index;
    option.name = name;
    option.total_shares = None;
    option.total_score = None;
    option.creator = ctx.accounts.creator.key();
    option.initialized = true;

    emit_ts!(MarketOptionCreatedEvent {
        option: option.key(),
        market: market.key(),
        creator: ctx.accounts.creator.key(),
        index: option.index,
        name: option.name.clone(),
        by_market_creator: true
    });

    Ok(())
}
