use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardPoolIncreasedEvent};
use crate::state::OpportunityMarket;

#[derive(Accounts)]
pub struct IncreaseRewardPool<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = market.creator == authority.key()
            || market.market_authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,

    #[account(address = market.mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Market's ATA holding reward tokens
    #[account(
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn increase_reward_pool(ctx: Context<IncreaseRewardPool>, new_reward_amount: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Market must be open
    let open_timestamp = market.open_timestamp.ok_or(ErrorCode::MarketNotOpen)?;

    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    // Staking must be active
    let stake_end = open_timestamp
        .checked_add(market.time_to_stake)
        .ok_or(ErrorCode::Overflow)?;
    require!(current_timestamp < stake_end, ErrorCode::StakingNotActive);

    // New reward must be greater than current
    require!(new_reward_amount > market.reward_amount, ErrorCode::RewardAmountNotIncreased);

    // Market ATA must have enough tokens
    require!(
        ctx.accounts.market_token_ata.amount >= new_reward_amount,
        ErrorCode::InsufficientRewardFunding
    );

    // Winners must not already be selected
    require!(market.selected_options.is_none(), ErrorCode::WinnerAlreadySelected);

    // Reward must not have been withdrawn
    require!(!market.reward_withdrawn, ErrorCode::RewardAlreadyWithdrawn);

    let old_reward_amount = market.reward_amount;
    market.reward_amount = new_reward_amount;

    emit_ts!(RewardPoolIncreasedEvent {
        market: market.key(),
        authority: ctx.accounts.authority.key(),
        old_reward_amount: old_reward_amount,
        new_reward_amount: new_reward_amount,
    });

    Ok(())
}
