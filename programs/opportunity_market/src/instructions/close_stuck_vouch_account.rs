use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{OPPORTUNITY_MARKET_SEED, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StuckVouchClosedEvent};
use crate::state::{OpportunityMarket, VouchAccount};

#[derive(Accounts)]
#[instruction(vouch_account_id: u32)]
pub struct CloseStuckVouchAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        address = vouch_account.rent_payer,
    )]
    /// CHECK: receives the closed vouch account rent.
    pub rent_payer: UncheckedAccount<'info>,

    #[account(
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        close = rent_payer,
        seeds = [VOUCH_ACCOUNT_SEED, signer.key().as_ref(), market.key().as_ref(), &vouch_account_id.to_le_bytes()],
        bump = vouch_account.bump,
        constraint = vouch_account.owner == signer.key() @ ErrorCode::Unauthorized,
        constraint = vouch_account.vouch_withdrawn_at_timestamp.is_none() @ ErrorCode::AlreadyVouchWithdrawn,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Signer's token account to receive refund
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
        token::token_program = token_program,
    )]
    pub signer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn close_stuck_vouch_account(
    ctx: Context<CloseStuckVouchAccount>,
    vouch_account_id: u32,
) -> Result<()> {
    let vouch_account = &ctx.accounts.vouch_account;

    // Only closeable if MPC computation is still in flight (or callback failed/never came)
    require!(
        vouch_account.pending_vouch_computation.is_some(),
        ErrorCode::VouchNotStuck
    );

    let market = &ctx.accounts.market;
    let amount = vouch_account.amount;
    let total_refund = amount
        .checked_add(vouch_account.collected_fees.total()?)
        .ok_or(ErrorCode::Overflow)?;

    if total_refund > 0 {
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
                    to: ctx.accounts.signer_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                market_seeds,
            ),
            total_refund,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    emit_ts!(StuckVouchClosedEvent {
        owner: ctx.accounts.signer.key(),
        market: market.key(),
        vouch_account: ctx.accounts.vouch_account.key(),
        vouch_account_id: vouch_account_id,
        refunded_amount: amount,
        refunded_platform_fee: vouch_account.collected_fees.platform_fee,
        refunded_reward_pool_fee: vouch_account.collected_fees.reward_pool_fee,
        refunded_creator_fee: vouch_account.collected_fees.creator_fee,
    });

    Ok(())
}
