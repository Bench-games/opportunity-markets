use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, EncryptedTokensUnwrappedError, EncryptedTokensUnwrappedEvent};
use crate::instructions::init_token_vault::TOKEN_VAULT_SEED;
use crate::state::{EncryptedTokenAccount, TokenVault};

use crate::COMP_DEF_OFFSET_UNWRAP_ENCRYPTED_TOKENS;
use crate::{ID, ID_CONST, ArciumSignerAccount};

#[queue_computation_accounts("unwrap_encrypted_tokens", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct UnwrapEncryptedTokens<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = encrypted_token_account.owner == signer.key() @ ErrorCode::Unauthorized,
        constraint = encrypted_token_account.token_mint == token_mint.key() @ ErrorCode::InvalidMint,
        constraint = !encrypted_token_account.locked @ ErrorCode::Locked,
        constraint = encrypted_token_account.pending_deposit == 0 @ ErrorCode::InvalidAccountState,
    )]
    pub encrypted_token_account: Box<Account<'info, EncryptedTokenAccount>>,

    /// Token vault holding all wrapped tokens
    #[account(
        seeds = [TOKEN_VAULT_SEED, token_mint.key().as_ref()],
        bump = token_vault.bump,
        constraint = token_vault.mint == token_mint.key() @ ErrorCode::InvalidMint,
    )]
    pub token_vault: Box<Account<'info, TokenVault>>,

    /// ATA owned by TokenVault PDA (source of SPL tokens for withdrawal)
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = token_vault,
        associated_token::token_program = token_program,
    )]
    pub token_vault_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Signer's token account (destination for claimed tokens)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
        token::token_program = token_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_UNWRAP_ENCRYPTED_TOKENS))]
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

pub fn unwrap_encrypted_tokens(
    ctx: Context<UnwrapEncryptedTokens>,
    computation_offset: u64,
    amount: u64,
) -> Result<()> {
    let eta = &mut ctx.accounts.encrypted_token_account;
    require!(eta.is_initialized, ErrorCode::InvalidAccountState);
    let user_pubkey = eta.user_pubkey;
    let eta_pubkey = eta.key();

    // Build args for encrypted computation
    // Circuit signature: unwrap_encrypted_tokens(balance_ctx, amount)
    let args = ArgBuilder::new()
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(eta.state_nonce)
        .account(eta_pubkey, 8, 32 * 1)
        .plaintext_u64(amount)
        .build();

    eta.locked = true;

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![UnwrapEncryptedTokensCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: eta_pubkey,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.user_token_account.key(),
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.token_vault.key(),
                    is_writable: false,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.token_vault_ata.key(),
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.token_mint.key(),
                    is_writable: false,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.token_program.key(),
                    is_writable: false,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("unwrap_encrypted_tokens")]
#[derive(Accounts)]
pub struct UnwrapEncryptedTokensCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_UNWRAP_ENCRYPTED_TOKENS))]
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

    // Callback accounts (order must match CallbackAccount vec above)
    #[account(mut)]
    pub encrypted_token_account: Account<'info, EncryptedTokenAccount>,

    /// User's token account to receive claimed SPL tokens
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token vault holding all wrapped tokens
    pub token_vault: Account<'info, TokenVault>,

    /// TokenVault's ATA holding SPL tokens (source for withdrawal)
    #[account(mut)]
    pub token_vault_ata: InterfaceAccount<'info, TokenAccount>,

    /// Token mint for transfer_checked
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Token program for CPI
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn unwrap_encrypted_tokens_callback(
    ctx: Context<UnwrapEncryptedTokensCallback>,
    output: SignedComputationOutputs<UnwrapEncryptedTokensOutput>,
) -> Result<()> {
    let eta = &mut ctx.accounts.encrypted_token_account;

    // Unlock account
    eta.locked = false;

    // Output is (bool, u64, Enc<Mxe, EncryptedTokenBalance>)
    // field_0 = error boolean (true = insufficient balance)
    // field_1 = how many encrypted tokens were sold
    // field_2 = updated encrypted balance
    let res = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(UnwrapEncryptedTokensOutput { field_0 }) => field_0,
        Err(_) => {
            emit_ts!(EncryptedTokensUnwrappedError {
                user: eta.owner,
            });
            return Ok(());
        }
    };

    if res.field_0 {
        emit_ts!(EncryptedTokensUnwrappedError {
            user: eta.owner,
        });
        return Ok(());
    }

    let amount_sold = res.field_1;
    let encrypted_balance = res.field_2;

    // If tokens were sold, transfer SPL tokens from TokenVault's ATA to user's token account
    if amount_sold > 0 {
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
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.token_vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount_sold,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    // Update encrypted state
    eta.state_nonce = encrypted_balance.nonce;
    eta.encrypted_state = encrypted_balance.ciphertexts;
    eta.is_initialized = true;

    emit_ts!(EncryptedTokensUnwrappedEvent {
        user: eta.owner,
        encrypted_token_account: eta.key(),
        amount_withdrawn: amount_sold,
        encrypted_new_balance: encrypted_balance.ciphertexts[0],
        nonce: encrypted_balance.nonce,
    });

    Ok(())
}
