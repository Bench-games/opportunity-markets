use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, UnstakedEvent};
use crate::state::{OpportunityMarket, StakeAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
#[instruction(stake_account_id: u32)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Must sign when unstaking early.
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
        constraint = market.staking_window_end.is_some() @ ErrorCode::MarketNotOpen,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = stake_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
        constraint = stake_account.staked_at_timestamp.is_some() @ ErrorCode::NoStake,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    // SPL token accounts
    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner's token account to receive staked tokens
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

pub fn unstake(ctx: Context<Unstake>, _stake_account_id: u32) -> Result<()> {
    let market = &ctx.accounts.market;

    let staking_window_end = market.staking_window_end.ok_or(ErrorCode::MarketNotOpen)?;
    let current_timestamp = Clock::get()?.unix_timestamp as u64;

    if current_timestamp < staking_window_end {
        require!(ctx.accounts.owner.is_signer, ErrorCode::Unauthorized);
        ctx.accounts.stake_account.unstaked_at_timestamp = Some(current_timestamp);
    } else {
        ctx.accounts.stake_account.unstaked_at_timestamp = Some(staking_window_end);
    }

    let amount = ctx.accounts.stake_account.amount;
    transfer_from_market(
        market,
        &ctx.accounts.token_mint,
        &ctx.accounts.market_token_ata,
        &ctx.accounts.owner_token_account,
        &ctx.accounts.token_program,
        amount,
    )?;

    emit_ts!(UnstakedEvent {
        owner: ctx.accounts.stake_account.owner,
        market: market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        amount: amount,
    });

    Ok(())
}
