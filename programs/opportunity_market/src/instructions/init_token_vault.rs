use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::state::{CentralState, TokenVault};

pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";

#[derive(Accounts)]
pub struct InitTokenVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + TokenVault::INIT_SPACE,
        seeds = [TOKEN_VAULT_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub token_vault: Box<Account<'info, TokenVault>>,

    #[account(
        seeds = [b"central_state"],
        bump = central_state.bump,
    )]
    pub central_state: Account<'info, CentralState>,

    pub system_program: Program<'info, System>,
}

pub fn init_token_vault(
    ctx: Context<InitTokenVault>,
    fund_manager: Pubkey,
) -> Result<()> {
    let vault = &mut ctx.accounts.token_vault;
    vault.bump = ctx.bumps.token_vault;
    vault.fund_manager = fund_manager;
    vault.mint = ctx.accounts.token_mint.key();
    vault.collected_fees = 0;
    vault.protocol_fee_bp = ctx.accounts.central_state.protocol_fee_bp;

    Ok(())
}
