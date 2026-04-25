use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::SPONSOR_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardAddedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketSponsor};

#[derive(Accounts)]
pub struct AddReward<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        init_if_needed,
        payer = sponsor,
        space = 8 + OpportunityMarketSponsor::INIT_SPACE,
        seeds = [SPONSOR_SEED, sponsor.key().as_ref(), market.key().as_ref()],
        bump,
    )]
    pub sponsor_account: Account<'info, OpportunityMarketSponsor>,

    #[account(address = market.mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = sponsor,
        token::token_program = token_program,
    )]
    pub sponsor_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Market's ATA holding reward tokens
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn add_reward(ctx: Context<AddReward>, amount: u64, lock: bool) -> Result<()> {
    let market = &ctx.accounts.market;

    // Allow anytime before staking ends
    if let Some(open_timestamp) = market.open_timestamp {
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp as u64;
        let stake_end = open_timestamp
            .checked_add(market.time_to_stake)
            .ok_or(ErrorCode::Overflow)?;
        require!(current_timestamp < stake_end, ErrorCode::StakingNotActive);
    }

    let sponsor_account = &mut ctx.accounts.sponsor_account;

    // Initialize if newly created (sponsor is default)
    if sponsor_account.sponsor == Pubkey::default() {
        sponsor_account.bump = ctx.bumps.sponsor_account;
        sponsor_account.sponsor = ctx.accounts.sponsor.key();
        sponsor_account.market = ctx.accounts.market.key();
    }

    // Lock logic: once locked, stays locked
    if lock {
        sponsor_account.reward_locked = true;
    }

    // Transfer tokens from sponsor to market ATA
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.sponsor_token_account.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.market_token_ata.to_account_info(),
                authority: ctx.accounts.sponsor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    sponsor_account.reward_deposited = sponsor_account
        .reward_deposited
        .checked_add(amount)
        .ok_or(ErrorCode::Overflow)?;

    let market = &mut ctx.accounts.market;
    market.reward_amount = market
        .reward_amount
        .checked_add(amount)
        .ok_or(ErrorCode::Overflow)?;

    emit_ts!(RewardAddedEvent {
        market: market.key(),
        sponsor: ctx.accounts.sponsor.key(),
        amount: amount,
        total_reward_amount: market.reward_amount,
        locked: sponsor_account.reward_locked,
    });

    Ok(())
}
