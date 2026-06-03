use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{OPPORTUNITY_MARKET_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, UnstakedEvent};
use crate::state::{OpportunityMarket, StakeAccount};

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
        constraint = market.stake_end_timestamp.is_some() @ ErrorCode::MarketNotOpen,
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

    let stake_end = market.stake_end_timestamp.ok_or(ErrorCode::MarketNotOpen)?;
    let current_timestamp = Clock::get()?.unix_timestamp as u64;

    if current_timestamp < stake_end {
        require!(ctx.accounts.owner.is_signer, ErrorCode::Unauthorized);
        ctx.accounts.stake_account.unstaked_at_timestamp = Some(current_timestamp);
    } else {
        ctx.accounts.stake_account.unstaked_at_timestamp = Some(stake_end);
    }

    let amount = ctx.accounts.stake_account.amount;

    if amount > 0 {
        let platform = market.platform;
        let creator = market.creator;
        let index_bytes = market.index.to_le_bytes();
        let market_bump = market.bump;
        let market_seeds: &[&[&[u8]]] = &[&[
            OPPORTUNITY_MARKET_SEED,
            platform.as_ref(),
            creator.as_ref(),
            &index_bytes,
            &[market_bump],
        ]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.market_token_ata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                market_seeds,
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    emit_ts!(UnstakedEvent {
        owner: ctx.accounts.stake_account.owner,
        market: market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        amount: amount,
    });

    Ok(())
}
