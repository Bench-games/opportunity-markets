use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    ALLOWED_MINT_SEED, MAX_EARLINESS_CUTOFF_SECONDS, MAX_EARLINESS_MULTIPLIER,
    MIN_EARLINESS_CUTOFF_SECONDS, MIN_MIN_STAKE_AMOUNT, OPPORTUNITY_MARKET_SEED,
};
use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketCreatedEvent};
use crate::score::PRECISION;
use crate::state::{AllowedMint, OpportunityMarket, PlatformConfig};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateMarketParameters {
    pub market_index: u64,
    pub market_authority: Pubkey,
    pub authorized_reader_pubkey: [u8; 32],
    pub earliness_cutoff_seconds: u64,
    pub earliness_multiplier: u16,
    pub min_stake_amount: u64,
    pub creator_fee_claimer: Pubkey,
}
#[derive(Accounts)]
#[instruction(params: CreateMarketParameters)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub platform_config: Box<Account<'info, PlatformConfig>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarket::INIT_SPACE,
        seeds = [OPPORTUNITY_MARKET_SEED, platform_config.key().as_ref(), creator.key().as_ref(), &params.market_index.to_le_bytes()],
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

pub fn create_market(ctx: Context<CreateMarket>, params: CreateMarketParameters) -> Result<()> {
    require!(
        (params.earliness_multiplier as u64) >= PRECISION
            && params.earliness_multiplier <= MAX_EARLINESS_MULTIPLIER,
        ErrorCode::InvalidParameters
    );
    require!(
        (MIN_EARLINESS_CUTOFF_SECONDS..=MAX_EARLINESS_CUTOFF_SECONDS)
            .contains(&params.earliness_cutoff_seconds),
        ErrorCode::InvalidParameters
    );
    require!(
        params.min_stake_amount >= MIN_MIN_STAKE_AMOUNT,
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
    market.index = params.market_index;
    market.platform = platform_key;
    market.mint = mint;
    market.market_authority = params.market_authority;
    market.earliness_cutoff_seconds = params.earliness_cutoff_seconds;
    market.earliness_multiplier = params.earliness_multiplier;
    market.authorized_reader_pubkey = params.authorized_reader_pubkey;
    market.fee_rates = ctx.accounts.platform_config.fee_rates;
    market.creator_fee_claimer = params.creator_fee_claimer;
    market.market_resolution_deadline_seconds = market_resolution_deadline_seconds;
    market.reveal_period_seconds = reveal_period_seconds;
    market.min_stake_amount = params.min_stake_amount;

    emit_ts!(MarketCreatedEvent {
        market: market.key(),
        creator: creator_key,
        platform: platform_key,
        index: params.market_index,
        mint: mint,
        market_authority: params.market_authority,
        authorized_reader_pubkey: params.authorized_reader_pubkey,
        earliness_cutoff_seconds: params.earliness_cutoff_seconds,
        earliness_multiplier: params.earliness_multiplier,
        min_stake_amount: params.min_stake_amount,
        fee_rates: ctx.accounts.platform_config.fee_rates,
        creator_fee_claimer: params.creator_fee_claimer,
        market_resolution_deadline_seconds: market_resolution_deadline_seconds,
        reveal_period_seconds: reveal_period_seconds,
    });

    Ok(())
}
