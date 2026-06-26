use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, VouchAccountClosedEvent};
use crate::state::{MarketPhase, OpportunityMarket, VouchAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct CloseUnrevealedVouchAccount<'info> {
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
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account.id.to_le_bytes()],
        bump = vouch_account.bump,
        close = owner,
        constraint = vouch_account.unvouched_at_timestamp.is_some() @ ErrorCode::InvalidAccountState,
        constraint = vouch_account.revealed_option.is_none() @ ErrorCode::InvalidAccountState,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

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

pub fn close_unrevealed_vouch_account<'info>(
    ctx: Context<'info, CloseUnrevealedVouchAccount<'info>>,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let vouch_account = &ctx.accounts.vouch_account;
    let now = Clock::get()?.unix_timestamp as u64;
    let phase = market.phase(now)?;
    require!(
        phase == MarketPhase::Settlement || phase == MarketPhase::Expired,
        ErrorCode::WrongMarketPhase
    );

    let mut fee_refund = 0;
    if phase == MarketPhase::Settlement {
        if market.winning_option_active_bp == 0 {
            fee_refund = vouch_account.collected_fees.reward_pool_fee;
            market.reward_amount = market
                .reward_amount
                .checked_sub(fee_refund)
                .ok_or(ErrorCode::Overflow)?;
        }
    } else if phase == MarketPhase::Expired {
        let fees = vouch_account.collected_fees;
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

    emit_ts!(VouchAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        vouch_account: vouch_account.key(),
        vouch_account_id: vouch_account.id,
        option_id: None,
        vouch_amount: vouch_account.amount,
        fee_refund: fee_refund,
        vouched_at_timestamp: vouch_account.vouched_at_timestamp.unwrap_or(0),
        vouching_window_end: vouch_account.unvouched_at_timestamp.unwrap_or(0),
        score: vouch_account.score.unwrap_or(0),
    });

    Ok(())
}
