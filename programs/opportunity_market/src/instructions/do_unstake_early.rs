use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, UnstakedEvent};
use crate::constants::{OPPORTUNITY_MARKET_SEED, STAKE_ACCOUNT_SEED};
use crate::state::{OpportunityMarket, StakeAccount};

#[derive(Accounts)]
#[instruction(stake_account_id: u32, stake_account_owner: Pubkey)]
pub struct DoUnstakeEarly<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.open_timestamp.is_some() @ ErrorCode::MarketNotOpen,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, stake_account_owner.as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = stake_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
        constraint = stake_account.unstakeable_at_timestamp.is_some() @ ErrorCode::UnstakeNotInitiated,
        constraint = !stake_account.locked @ ErrorCode::Locked,
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

    /// Owner's token account to receive refund
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = stake_account_owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn do_unstake_early(
    ctx: Context<DoUnstakeEarly>,
    _stake_account_id: u32,
    _stake_account_owner: Pubkey,
) -> Result<()> {
    // Enforce staking period is still active
    let market = &ctx.accounts.market;
    let open_timestamp = market.open_timestamp.ok_or_else(|| ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    let stake_end_timestamp = open_timestamp + market.time_to_stake;

    require!(
        current_timestamp <= stake_end_timestamp,
        ErrorCode::StakingNotActive
    );

    // Enforce unstake delay has passed
    let unstakeable_at = ctx.accounts.stake_account.unstakeable_at_timestamp
        .ok_or_else(|| ErrorCode::UnstakeNotInitiated)?;
    require!(
        current_timestamp >= unstakeable_at,
        ErrorCode::UnstakeDelayNotMet
    );

    let amount = ctx.accounts.stake_account.amount;

    // Transfer staked tokens from market ATA back to owner
    let creator_key = market.creator;
    let index_bytes = market.index.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        OPPORTUNITY_MARKET_SEED,
        creator_key.as_ref(),
        &index_bytes,
        &[bump],
    ]];

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

    // Mark stake account as unstaked
    ctx.accounts.stake_account.unstaked_at_timestamp = Some(current_timestamp);

    emit_ts!(UnstakedEvent {
        user: ctx.accounts.stake_account.owner,
        market: market.key(),
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
    });

    Ok(())
}
