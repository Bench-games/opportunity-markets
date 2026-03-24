use anchor_lang::prelude::*;

use crate::score::calculate_user_score;
use crate::error::ErrorCode;
use crate::events::{emit_ts, TallyIncrementedEvent};
use crate::instructions::stake::STAKE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};

#[derive(Accounts)]
#[instruction(option_id: u64, stake_account_id: u32)]
pub struct IncrementOptionTally<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: this is a permissionless operation
    pub owner: UncheckedAccount<'info>,

    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,

        constraint = !stake_account.total_incremented @ ErrorCode::TallyAlreadyIncremented,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        seeds = [b"option", market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

    pub system_program: Program<'info, System>,
}

pub fn increment_option_tally(ctx: Context<IncrementOptionTally>, option_id: u64, _stake_account_id: u32) -> Result<()> {
    let market = &ctx.accounts.market;

    // Check that we are within the reveal window
    let open_timestamp = market.open_timestamp.ok_or(ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let reveal_start = open_timestamp
        .checked_add(market.time_to_stake)
        .ok_or(ErrorCode::Overflow)?;
    let reveal_end = reveal_start
        .checked_add(market.time_to_reveal)
        .ok_or(ErrorCode::Overflow)?;

    require!(
        current_time >= reveal_start && current_time <= reveal_end,
        ErrorCode::MarketNotResolved
    );

    let revealed_option = ctx.accounts.stake_account.revealed_option.ok_or(ErrorCode::NotRevealed)?;
    require!(revealed_option == option_id, ErrorCode::InvalidOptionId);

    let stake_amount = ctx.accounts.stake_account.amount;

    ctx.accounts.option.total_staked = ctx.accounts.option.total_staked
        .checked_add(stake_amount)
        .ok_or(ErrorCode::Overflow)?;

    let stake_account = &ctx.accounts.stake_account;

    let staked_at_timestamp = stake_account.staked_at_timestamp
        .ok_or(ErrorCode::StakingNotActive)?;
    let stake_end = stake_account.unstaked_at_timestamp
        .unwrap_or(reveal_start);

    let user_score = calculate_user_score(
        open_timestamp,
        stake_end,
        staked_at_timestamp,
        stake_amount,
        market.earliness_cutoff_seconds,
    )?;

    ctx.accounts.option.total_score = ctx.accounts.option.total_score
        .checked_add(user_score)
        .ok_or(ErrorCode::Overflow)?;

    // Store the user's score on their stake account for reward calculation
    ctx.accounts.stake_account.score = Some(user_score);
    ctx.accounts.stake_account.total_incremented = true;

    emit_ts!(TallyIncrementedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        option_id: option_id,
        user_stake: stake_amount,
        user_score: user_score,

        total_score: ctx.accounts.option.total_score,
        total_stake: ctx.accounts.option.total_staked,
    });

    Ok(())
}
