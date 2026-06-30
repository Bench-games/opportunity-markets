use anchor_lang::prelude::*;

use crate::constants::OPTION_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOptionCreatedEvent};
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption, PlatformConfig};

#[derive(Accounts)]
#[instruction(option_id: u64)]
pub struct AddMarketOption<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        address = market.platform @ ErrorCode::Unauthorized,
        constraint = platform_config.option_creation_authority == signer.key() @ ErrorCode::Unauthorized,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

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

    let now = Clock::get()?.unix_timestamp as u64;
    market.require_phase(now, MarketPhase::Vouching)?;

    // Increment total options
    market.total_options += 1;

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.id = option_id;
    option.created_at = now;

    emit_ts!(MarketOptionCreatedEvent {
        option: option.key(),
        market: market.key(),
        id: option.id,
    });

    Ok(())
}
