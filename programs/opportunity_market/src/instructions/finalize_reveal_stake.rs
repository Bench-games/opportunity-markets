use anchor_lang::prelude::*;

use crate::constants::{OPTION_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, RevealStakeFinalizedEvent};
use crate::score::calculate_user_score;
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};

#[derive(Accounts)]
#[instruction(option_id: u64, stake_account_id: u32)]
pub struct FinalizeRevealStake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: this is a permissionless operation
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,

        constraint = stake_account.score.is_none() @ ErrorCode::TallyAlreadyIncremented,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

    pub system_program: Program<'info, System>,
}

pub fn finalize_reveal_stake(
    ctx: Context<FinalizeRevealStake>,
    option_id: u64,
    _stake_account_id: u32,
) -> Result<()> {
    let market = &ctx.accounts.market;

    // Check that we are within the reveal window
    let reveal_start = market.stake_end_timestamp.ok_or(ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    require!(current_time >= reveal_start, ErrorCode::TimeWindowMismatch);
    require!(!market.reveal_ended, ErrorCode::RevealPeriodEnded);

    let revealed_option = ctx
        .accounts
        .stake_account
        .revealed_option
        .ok_or(ErrorCode::NotRevealed)?;
    require!(revealed_option == option_id, ErrorCode::InvalidOptionId);

    let stake_amount = ctx.accounts.stake_account.amount;

    ctx.accounts.option.total_staked = ctx
        .accounts
        .option
        .total_staked
        .checked_add(stake_amount)
        .ok_or(ErrorCode::Overflow)?;

    let stake_account = &ctx.accounts.stake_account;

    let staked_at_timestamp = stake_account
        .staked_at_timestamp
        .ok_or(ErrorCode::NoStake)?;
    let user_stake_end = stake_account.unstaked_at_timestamp.unwrap_or(reveal_start);

    let stake_base_amount = stake_amount
        .checked_add(ctx.accounts.stake_account.collected_fees.total()?)
        .ok_or(ErrorCode::Overflow)?;
    let user_score = calculate_user_score(
        ctx.accounts.option.created_at,
        reveal_start,
        staked_at_timestamp,
        user_stake_end,
        stake_base_amount,
        market.earliness_cutoff_seconds,
        market.earliness_multiplier,
    )?;

    ctx.accounts.option.total_score = ctx
        .accounts
        .option
        .total_score
        .checked_add(user_score as u128)
        .ok_or(ErrorCode::Overflow)?;

    // Store the user's score in their stake account for reward calculation
    ctx.accounts.stake_account.score = Some(user_score);

    let option = &mut ctx.accounts.option;
    let market = &mut ctx.accounts.market;

    if option.reward_bp > 0 && !option.included_in_active_bp {
        market.winning_option_active_bp = market
            .winning_option_active_bp
            .checked_add(option.reward_bp)
            .ok_or(ErrorCode::Overflow)?;
        option.included_in_active_bp = true;
    }

    // Winning option means stake fees get refunded, so deduct from market account.
    // Actual refund transfer happens in `close_stake_account` together with reward.
    if option.reward_bp > 0 {
        let fees = ctx.accounts.stake_account.collected_fees;
        market.deduct_stake_fees(&fees)?;
    }

    emit_ts!(RevealStakeFinalizedEvent {
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
