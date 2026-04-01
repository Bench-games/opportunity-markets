use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::error::ErrorCode;
use crate::state::{CentralState, OpportunityMarket};
use crate::events::{emit_ts, MarketCreatedEvent};

#[derive(Accounts)]
#[instruction(market_index: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [b"central_state"],
        bump = central_state.bump,
    )]
    pub central_state: Box<Account<'info, CentralState>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarket::INIT_SPACE,
        seeds = [b"opportunity_market", creator.key().as_ref(), &market_index.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    /// ATA owned by market PDA, holds reward tokens
    #[account(
        init,
        payer = creator,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn create_market(
    ctx: Context<CreateMarket>,
    market_index: u64,
    time_to_stake: u64,
    time_to_reveal: u64,
    market_authority: Option<Pubkey>,
    unstake_delay_seconds: u64,
    authorized_reader_pubkey: [u8; 32],
    allow_closing_early: bool,
    reveal_period_authority: Pubkey,
) -> Result<()> {
    let central_state = &ctx.accounts.central_state;
    let creator_key = ctx.accounts.creator.key();
    let market = &mut ctx.accounts.market;
    let mint = ctx.accounts.token_mint.key();
    let earliness_cutoff_seconds = central_state.earliness_cutoff_seconds;
    market.bump = ctx.bumps.market;
    market.creator = creator_key;
    market.index = market_index;
    market.total_options = 0;
    market.time_to_stake = time_to_stake;
    market.time_to_reveal = time_to_reveal;
    market.selected_options = None;
    market.reward_amount = 0;
    market.mint = mint;
    market.market_authority = market_authority.unwrap_or(creator_key);
    market.reveal_period_authority = reveal_period_authority;
    market.earliness_cutoff_seconds = earliness_cutoff_seconds;
    market.unstake_delay_seconds = unstake_delay_seconds;
    market.authorized_reader_pubkey = authorized_reader_pubkey;
    market.allow_closing_early = allow_closing_early;

    emit_ts!(MarketCreatedEvent {
        market: market.key(),
        creator: creator_key,
        index: market_index,
        mint: mint,
        time_to_reveal: time_to_reveal,
        time_to_stake : time_to_stake,
        market_authority: market_authority,
        authorized_reader_pubkey: authorized_reader_pubkey,
        unstake_delay_seconds: unstake_delay_seconds,
        allow_closing_early: allow_closing_early,
        earliness_cutoff_seconds: earliness_cutoff_seconds
    });

    Ok(())
}
