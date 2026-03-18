use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use crate::instructions::init_token_vault::TOKEN_VAULT_SEED;
use crate::events::{emit_ts, PendingDepositClaimedEvent};
use crate::state::{EncryptedTokenAccount, TokenVault};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ClaimPendingDeposit<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = encrypted_token_account.owner == signer.key() @ ErrorCode::Unauthorized,
        constraint = encrypted_token_account.token_mint == token_mint.key() @ ErrorCode::InvalidMint,
        constraint = !encrypted_token_account.locked @ ErrorCode::Locked,
    )]
    pub encrypted_token_account: Account<'info, EncryptedTokenAccount>,

    /// Token vault holding all wrapped tokens
    #[account(
        seeds = [TOKEN_VAULT_SEED, token_mint.key().as_ref()],
        bump = token_vault.bump,
        constraint = token_vault.mint == token_mint.key() @ ErrorCode::InvalidMint,
    )]
    pub token_vault: Account<'info, TokenVault>,

    /// ATA owned by TokenVault PDA (source of pending tokens)
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = token_vault,
        associated_token::token_program = token_program,
    )]
    pub token_vault_ata: InterfaceAccount<'info, TokenAccount>,

    /// Signer's token account (destination for claimed tokens)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
        token::token_program = token_program,
    )]
    pub signer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn claim_pending_deposit(ctx: Context<ClaimPendingDeposit>) -> Result<()> {
    let eta = &mut ctx.accounts.encrypted_token_account;

    // If no pending deposit, return success (no-op)
    if eta.pending_deposit == 0 {
        return Ok(());
    }

    let claimed_amount = eta.pending_deposit;

    // Transfer pending tokens from TokenVault ATA back to signer
    let vault_bump = ctx.accounts.token_vault.bump;
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
                to: ctx.accounts.signer_token_account.to_account_info(),
                authority: ctx.accounts.token_vault.to_account_info(),
            },
            signer_seeds,
        ),
        eta.pending_deposit,
        ctx.accounts.token_mint.decimals,
    )?;

    // Clear pending deposit
    eta.pending_deposit = 0;
    eta.locked = false;

    emit_ts!(PendingDepositClaimedEvent {
        user: eta.owner,
        encrypted_token_account: eta.key(),
        amount: claimed_amount,
    });

    Ok(())
}
