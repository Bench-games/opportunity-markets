use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeAccountClosedEvent};
use crate::state::{MarketPhase, OpportunityMarket, StakeAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct CloseUnrevealedStakeAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account.id.to_le_bytes()],
        bump = stake_account.bump,
        close = owner,
        constraint = stake_account.unstaked_at_timestamp.is_some() @ ErrorCode::InvalidAccountState,
        constraint = stake_account.revealed_option.is_none() @ ErrorCode::InvalidAccountState,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

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
    pub system_program: Program<'info, System>,
}

pub fn close_unrevealed_stake_account<'info>(
    ctx: Context<'info, CloseUnrevealedStakeAccount<'info>>,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let stake_account = &ctx.accounts.stake_account;
    let now = Clock::get()?.unix_timestamp as u64;
    let phase = market.phase(now)?;
    require!(
        phase == MarketPhase::Resolution || phase == MarketPhase::Expired,
        ErrorCode::WrongMarketPhase
    );

    let mut fee_refund = 0;
    if phase == MarketPhase::Resolution {
        if market.winning_option_active_bp == 0 {
            fee_refund = stake_account.collected_fees.reward_pool_fee;
            market.reward_amount = market
                .reward_amount
                .checked_sub(fee_refund)
                .ok_or(ErrorCode::Overflow)?;
        }
    } else if phase == MarketPhase::Expired {
        let fees = stake_account.collected_fees;
        market.reward_amount = market
            .reward_amount
            .checked_sub(fees.reward_pool_fee)
            .ok_or(ErrorCode::Overflow)?;
        market.collected_creator_fees = market
            .collected_creator_fees
            .checked_sub(fees.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
        fee_refund = fees
            .reward_pool_fee
            .checked_add(fees.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
    }

    if fee_refund > 0 {
        transfer_from_market(
            market,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
            fee_refund,
        )?;
    }

    emit_ts!(StakeAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        stake_account: stake_account.key(),
        stake_account_id: stake_account.id,
        option_id: None,
        stake_amount: stake_account.amount,
        fee_refund: fee_refund,
        staked_at_timestamp: stake_account.staked_at_timestamp.unwrap_or(0),
        staking_window_end: stake_account.unstaked_at_timestamp.unwrap_or(0),
        score: stake_account.score.unwrap_or(0),
    });

    Ok(())
}
