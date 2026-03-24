use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeReclaimedEvent};
use crate::instructions::stake::STAKE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, StakeAccount};

#[derive(Accounts)]
#[instruction(stake_account_id: u32)]
pub struct ReclaimStake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Any account — this is the stake account owner. Permissionless.
    pub owner: UncheckedAccount<'info>,

    #[account(
        constraint = market.selected_options.is_some() @ ErrorCode::MarketNotResolved,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = !stake_account.stake_reclaimed @ ErrorCode::AlreadyUnstaked,
        constraint = stake_account.staked_at_timestamp.is_some() @ ErrorCode::StakingNotActive,
        constraint = stake_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    // SPL token accounts
    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Market's ATA holding staked tokens
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

pub fn reclaim_stake(
    ctx: Context<ReclaimStake>,
    _stake_account_id: u32,
) -> Result<()> {
    let market = &ctx.accounts.market;

    let amount = ctx.accounts.stake_account.amount;

    // Transfer staked tokens from market ATA back to owner
    let creator_key = market.creator;
    let index_bytes = market.index.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"opportunity_market",
        creator_key.as_ref(),
        &index_bytes,
        &[bump],
    ]];

    if amount > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.market_token_ata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    ctx.accounts.stake_account.stake_reclaimed = true;

    emit_ts!(StakeReclaimedEvent {
        owner: ctx.accounts.stake_account.owner,
        market: market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        amount: amount,
    });

    Ok(())
}
