use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, EncryptedTokensWrappedEvent};
use crate::state::{EncryptedTokenAccount, TokenVault};
use crate::instructions::init_token_vault::TOKEN_VAULT_SEED;
use crate::COMP_DEF_OFFSET_WRAP_ENCRYPTED_TOKENS;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[queue_computation_accounts("wrap_encrypted_tokens", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct WrapEncryptedTokens<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = encrypted_token_account.owner == signer.key() @ ErrorCode::Unauthorized,
        constraint = encrypted_token_account.token_mint == token_mint.key() @ ErrorCode::InvalidMint,
        constraint = !encrypted_token_account.locked @ ErrorCode::Locked
    )]
    pub encrypted_token_account: Box<Account<'info, EncryptedTokenAccount>>,

    /// The signer's token account (source of SPL tokens)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
        token::token_program = token_program,
    )]
    pub signer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token vault holding all wrapped tokens
    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, token_mint.key().as_ref()],
        bump = token_vault.bump,
        constraint = token_vault.mint == token_mint.key() @ ErrorCode::InvalidMint,
    )]
    pub token_vault: Box<Account<'info, TokenVault>>,

    /// ATA owned by the TokenVault PDA (destination of SPL tokens)
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = token_vault,
        associated_token::token_program = token_program,
    )]
    pub token_vault_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    // Arcium accounts
    #[account(
        init_if_needed,
        space = 9,
        payer = signer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WRAP_ENCRYPTED_TOKENS))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub arcium_program: Program<'info, Arcium>,
}

pub fn wrap_encrypted_tokens(
    ctx: Context<WrapEncryptedTokens>,
    computation_offset: u64,
    amount: u64,
) -> Result<()> {
    let eta = &mut ctx.accounts.encrypted_token_account;
    let user_pubkey = eta.user_pubkey;
    let eta_pubkey = eta.key();

    // Calculate protocol fee
    let fee = amount
        .checked_mul(ctx.accounts.token_vault.protocol_fee_bp as u64)
        .ok_or(ErrorCode::Overflow)?
        / 10_000;
    let net_amount = amount
        .checked_sub(fee)
        .ok_or(ErrorCode::Overflow)?;

    // Transfer full amount to vault ATA (fee is kept in vault, tracked separately)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.signer_token_account.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.token_vault_ata.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // Track collected fees
    let token_vault = &mut ctx.accounts.token_vault;
    token_vault.collected_fees = token_vault
        .collected_fees
        .checked_add(fee)
        .ok_or(ErrorCode::Overflow)?;

    // Track the pending deposit (net of fee, fee is non-refundable)
    // Lock
    eta.pending_deposit = eta
        .pending_deposit
        .checked_add(net_amount)
        .ok_or(ErrorCode::Overflow)?;
    eta.locked = true;

    // Build args for encrypted computation
    // Circuit signature: wrap_encrypted_tokens(balance_ctx, is_initialized, amount)
    let is_initialized = eta.is_initialized;
    let args = ArgBuilder::new()
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(eta.state_nonce)
        .account(eta_pubkey, 8, 32 * 1)
        .plaintext_bool(is_initialized)
        .plaintext_u64(net_amount)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![WrapEncryptedTokensCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: eta_pubkey,
                is_writable: true,
            }],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("wrap_encrypted_tokens")]
#[derive(Accounts)]
pub struct WrapEncryptedTokensCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WRAP_ENCRYPTED_TOKENS))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,

    // Callback accounts
    #[account(mut)]
    pub encrypted_token_account: Account<'info, EncryptedTokenAccount>,
}

pub fn wrap_encrypted_tokens_callback(
    ctx: Context<WrapEncryptedTokensCallback>,
    output: SignedComputationOutputs<WrapEncryptedTokensOutput>,
) -> Result<()> {
    let encrypted_balance = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(WrapEncryptedTokensOutput { field_0 }) => field_0,

        // We do not reset account state here because can be done manually via
        // `claim_pending_deposit`
        Err(_) => return Err(ErrorCode::AbortedComputation.into()),
    };

    let eta = &mut ctx.accounts.encrypted_token_account;

    // Check that pending deposit exists. User could have withdrawn funds.
    require!(eta.pending_deposit > 0 && eta.locked, ErrorCode::InsufficientBalance);

    // Save deposit amount before clearing
    let deposit_amount = eta.pending_deposit;

    // Set pending deposit to 0 and unlock account.
    eta.pending_deposit = 0;
    eta.locked = false;

    // Update encrypted state
    eta.state_nonce = encrypted_balance.nonce;
    eta.encrypted_state = encrypted_balance.ciphertexts;
    eta.is_initialized = true;

    emit_ts!(EncryptedTokensWrappedEvent {
        encrypted_token_account: eta.key(),
        user: eta.owner,
        deposit_amount: deposit_amount,
        encrypted_new_balance: encrypted_balance.ciphertexts[0],
        nonce: encrypted_balance.nonce,
    });

    Ok(())
}
