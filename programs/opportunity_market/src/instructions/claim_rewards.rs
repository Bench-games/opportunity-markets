use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardsClaimedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
        constraint = market.resolved_at_timestamp.is_some() @ ErrorCode::MarketNotResolved,
        constraint = market.reveal_ended @ ErrorCode::MarketNotResolved,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account.id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = !stake_account.rewards_claimed @ ErrorCode::RewardAlreadyClaimed,
        constraint = stake_account.revealed_option.is_some() @ ErrorCode::InvalidOptionId,
        constraint = stake_account.score.is_some() @ ErrorCode::NotRevealed,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &stake_account.revealed_option.unwrap().to_le_bytes()],
        bump,
        constraint = option.reward_bp > 0 @ ErrorCode::NoRewardToClaim,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn claim_rewards<'info>(ctx: Context<'info, ClaimRewards<'info>>) -> Result<()> {
    let payout = compute_reward_payout(
        &ctx.accounts.stake_account,
        &ctx.accounts.market,
        &ctx.accounts.option,
    )?;

    if payout > 0 {
        transfer_from_market(
            &ctx.accounts.market,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
            payout,
        )?;
    }

    ctx.accounts.stake_account.rewards_claimed = true;

    ctx.accounts.option.unclaimed_stake = ctx
        .accounts
        .option
        .unclaimed_stake
        .checked_sub(ctx.accounts.stake_account.amount)
        .ok_or(ErrorCode::Overflow)?;

    emit_ts!(RewardsClaimedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        option_id: ctx.accounts.stake_account.revealed_option.unwrap(),
        reward_amount: payout,
        score: ctx.accounts.stake_account.score.unwrap_or(0),
    });

    Ok(())
}

fn compute_reward_payout(
    stake_account: &Account<StakeAccount>,
    market: &Account<OpportunityMarket>,
    option: &Account<OpportunityMarketOption>,
) -> Result<u64> {
    if option.reward_bp == 0 {
        return Ok(0);
    }

    if stake_account.score.is_none() {
        return Ok(0);
    }

    let active_bp = market.winning_option_active_bp;
    require!(active_bp > 0, ErrorCode::NoFinalizedWinningOption);

    let user_score = stake_account.score.ok_or(ErrorCode::NotRevealed)?;
    let total_score = option.total_score;

    // Divide by total_score before multiplying reward_bp so the intermediate product
    // stays ≤ reward_amount (u64) instead of growing toward u128::MAX.
    let reward = (user_score as u128)
        .checked_mul(market.reward_amount as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(total_score)
        .ok_or(ErrorCode::Overflow)?
        .checked_mul(option.reward_bp as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(active_bp as u128)
        .ok_or(ErrorCode::Overflow)? as u64;

    let fees = stake_account.collected_fees;
    let fees_refund = fees
        .reward_pool_fee
        .checked_add(fees.creator_fee)
        .ok_or(ErrorCode::Overflow)?;

    reward
        .checked_add(fees_refund)
        .ok_or(ErrorCode::Overflow.into())
}
