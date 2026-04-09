use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::constants::TOKEN_VAULT_SEED;
use crate::state::TokenVault;

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

    pub system_program: Program<'info, System>,
}

pub fn init_token_vault(
    ctx: Context<InitTokenVault>,
) -> Result<()> {
    let vault = &mut ctx.accounts.token_vault;
    vault.bump = ctx.bumps.token_vault;
    vault.mint = ctx.accounts.token_mint.key();
    vault.collected_fees = 0;

    Ok(())
}
