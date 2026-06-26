use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, UnvouchedEvent};
use crate::state::{MarketPhase, OpportunityMarket, VouchAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
#[instruction(vouch_account_id: u32)]
pub struct Unvouch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Must sign when unvouching early.
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account_id.to_le_bytes()],
        bump = vouch_account.bump,
        constraint = vouch_account.unvouched_at_timestamp.is_none() @ ErrorCode::AlreadyUnvouched,
        constraint = vouch_account.vouched_at_timestamp.is_some() @ ErrorCode::NoVouch,
        constraint = vouch_account.pending_vouch_computation.is_none() @ ErrorCode::Locked,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

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

    /// Owner's token account to receive vouched tokens
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

pub fn unvouch(ctx: Context<Unvouch>, _vouch_account_id: u32) -> Result<()> {
    let market = &ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp as u64;

    match market.phase(now)? {
        MarketPhase::NotOpen => return Err(ErrorCode::WrongMarketPhase.into()),
        MarketPhase::Vouching => {
            require!(ctx.accounts.owner.is_signer, ErrorCode::Unauthorized);
            ctx.accounts.vouch_account.unvouched_at_timestamp = Some(now);
        }
        _ => {
            let vouching_window_end = market
                .vouching_window_end
                .ok_or(ErrorCode::WrongMarketPhase)?;
            ctx.accounts.vouch_account.unvouched_at_timestamp = Some(vouching_window_end);
        }
    }

    let amount = ctx.accounts.vouch_account.amount;
    transfer_from_market(
        market,
        &ctx.accounts.token_mint,
        &ctx.accounts.market_token_ata,
        &ctx.accounts.owner_token_account,
        &ctx.accounts.token_program,
        amount,
    )?;

    emit_ts!(UnvouchedEvent {
        owner: ctx.accounts.vouch_account.owner,
        market: market.key(),
        vouch_account: ctx.accounts.vouch_account.key(),
        vouch_account_id: ctx.accounts.vouch_account.id,
        amount: amount,
    });

    Ok(())
}
