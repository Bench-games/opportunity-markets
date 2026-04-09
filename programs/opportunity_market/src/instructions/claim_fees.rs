use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, FeesClaimedEvent};
use crate::constants::{CENTRAL_STATE_SEED, TOKEN_VAULT_SEED};
use crate::state::{CentralState, TokenVault};

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [CENTRAL_STATE_SEED],
        bump = central_state.bump,
        constraint = signer.key() == central_state.fee_claimer @ ErrorCode::Unauthorized,
    )]
    pub central_state: Account<'info, CentralState>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, token_mint.key().as_ref()],
        bump = token_vault.bump,
        constraint = token_vault.mint == token_mint.key() @ ErrorCode::InvalidMint,
        constraint = token_vault.collected_fees > 0 @ ErrorCode::NoFeesToClaim,
    )]
    pub token_vault: Account<'info, TokenVault>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = token_vault,
        associated_token::token_program = token_program,
    )]
    pub token_vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_mint,
        token::token_program = token_program,
    )]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let token_vault = &ctx.accounts.token_vault;
    let fees = token_vault.collected_fees;

    let vault_bump = token_vault.bump;
    let mint_key = ctx.accounts.token_mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[
        TOKEN_VAULT_SEED,
        mint_key.as_ref(),
        &[vault_bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.token_vault_ata.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.token_vault.to_account_info(),
            },
            signer_seeds,
        ),
        fees,
        ctx.accounts.token_mint.decimals,
    )?;

    ctx.accounts.token_vault.collected_fees = 0;

    emit_ts!(FeesClaimedEvent {
        token_vault: ctx.accounts.token_vault.key(),
        mint: ctx.accounts.token_mint.key(),
        destination: ctx.accounts.destination_token_account.key(),
        amount: fees,
    });

    Ok(())
}
