use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeAccountClosedEvent};
use crate::state::{OpportunityMarket, StakeAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct CloseStakeAccount<'info> {
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
        constraint = stake_account.rewards_claimed || stake_account.revealed_option.is_none() @ ErrorCode::InvalidAccountState,
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

pub fn close_stake_account<'info>(ctx: Context<'info, CloseStakeAccount<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let stake_end = ctx
        .accounts
        .market
        .stake_end_timestamp
        .ok_or(ErrorCode::MarketNotOpen)?;
    let select_deadline = stake_end
        .checked_add(ctx.accounts.market.market_resolution_deadline_seconds)
        .ok_or(ErrorCode::Overflow)?;

    let resolved = ctx.accounts.market.resolved_at_timestamp.is_some();
    let expired = !resolved && current_time >= select_deadline;
    require!(resolved || expired, ErrorCode::MarketNotResolved);

    if resolved {
        require!(
            ctx.accounts.market.reveal_ended,
            ErrorCode::MarketNotResolved,
        );
    }

    let fee_refund = if expired {
        let collected_fees = ctx.accounts.stake_account.collected_fees;
        ctx.accounts.market.deduct_stake_fees(&collected_fees)?
    } else {
        0
    };

    if fee_refund > 0 {
        transfer_from_market(
            &ctx.accounts.market,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
            fee_refund,
        )?;
    }

    let stake_account = &ctx.accounts.stake_account;
    emit_ts!(StakeAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        stake_account: stake_account.key(),
        stake_account_id: stake_account.id,
        option_id: stake_account.revealed_option,
        stake_amount: stake_account.amount,
        fee_refund: fee_refund,
        staked_at_timestamp: stake_account.staked_at_timestamp.unwrap_or(0),
        stake_end_timestamp: stake_account.unstaked_at_timestamp.unwrap_or(stake_end),
        score: stake_account.score.unwrap_or(0),
    });

    Ok(())
}
