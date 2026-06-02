use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{ALLOWED_MINT_SEED, MAX_EARLINESS_MULTIPLIER, OPPORTUNITY_MARKET_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketCreatedEvent};
use crate::score::PRECISION;
use crate::state::{AllowedMint, OpportunityMarket, PlatformConfig};

#[derive(Accounts)]
#[instruction(market_index: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub platform_config: Box<Account<'info, PlatformConfig>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarket::INIT_SPACE,
        seeds = [OPPORTUNITY_MARKET_SEED, platform_config.key().as_ref(), creator.key().as_ref(), &market_index.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    /// This ATA holds all of the market's program-held tokens (stakes, rewards, fees).
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [ALLOWED_MINT_SEED, platform_config.key().as_ref(), token_mint.key().as_ref()],
        bump = allowed_mint.bump,
        constraint = allowed_mint.platform == platform_config.key() @ ErrorCode::Unauthorized,
        constraint = allowed_mint.mint == token_mint.key() @ ErrorCode::InvalidMint,
    )]
    pub allowed_mint: Box<Account<'info, AllowedMint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_market(
    ctx: Context<CreateMarket>,
    market_index: u64,
    market_authority: Pubkey,
    allow_unstaking_early: bool,
    authorized_reader_pubkey: [u8; 32],
    earliness_cutoff_seconds: u64,
    earliness_multiplier: u16,
    min_stake_amount: u64,
    creator_fee_claimer: Pubkey,
) -> Result<()> {
    require!(
        (earliness_multiplier as u64) >= PRECISION
            && earliness_multiplier <= MAX_EARLINESS_MULTIPLIER,
        ErrorCode::InvalidParameters
    );

    let creator_key = ctx.accounts.creator.key();
    let platform_key = ctx.accounts.platform_config.key();
    let market_resolution_deadline_seconds = ctx
        .accounts
        .platform_config
        .market_resolution_deadline_seconds;
    let reveal_period_seconds = ctx.accounts.platform_config.reveal_period_seconds;
    let market = &mut ctx.accounts.market;
    let mint = ctx.accounts.token_mint.key();
    market.bump = ctx.bumps.market;
    market.creator = creator_key;
    market.index = market_index;
    market.platform = platform_key;
    market.mint = mint;
    market.market_authority = market_authority;
    market.earliness_cutoff_seconds = earliness_cutoff_seconds;
    market.earliness_multiplier = earliness_multiplier;
    market.allow_unstaking_early = allow_unstaking_early;
    market.authorized_reader_pubkey = authorized_reader_pubkey;
    market.fee_rates = ctx.accounts.platform_config.fee_rates;
    market.creator_fee_claimer = creator_fee_claimer;
    market.market_resolution_deadline_seconds = market_resolution_deadline_seconds;
    market.reveal_period_seconds = reveal_period_seconds;
    market.min_stake_amount = min_stake_amount;

    emit_ts!(MarketCreatedEvent {
        market: market.key(),
        creator: creator_key,
        platform: platform_key,
        index: market_index,
        mint: mint,
        market_authority: market_authority,
        authorized_reader_pubkey: authorized_reader_pubkey,
        allow_unstaking_early: allow_unstaking_early,
        earliness_cutoff_seconds: earliness_cutoff_seconds,
        earliness_multiplier: earliness_multiplier,
        min_stake_amount: min_stake_amount,
        fee_rates: ctx.accounts.platform_config.fee_rates,
        creator_fee_claimer: creator_fee_claimer,
        market_resolution_deadline_seconds: market_resolution_deadline_seconds,
        reveal_period_seconds: reveal_period_seconds,
    });

    Ok(())
}
