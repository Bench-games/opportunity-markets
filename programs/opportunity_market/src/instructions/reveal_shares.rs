use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeRevealedError, StakeRevealedEvent};
use crate::instructions::stake::SHARE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, ShareAccount, EncryptedTokenAccount};
use crate::COMP_DEF_OFFSET_REVEAL_SHARES;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[queue_computation_accounts("reveal_shares", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, share_account_id: u32)]
pub struct RevealShares<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Any account, this operation is permissionless.
    pub owner: UncheckedAccount<'info>,

    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump = share_account.bump,
        constraint = share_account.revealed_amount.is_none() @ ErrorCode::AlreadyRevealed,
        constraint = !share_account.locked @ ErrorCode::Locked,
    )]
    pub share_account: Box<Account<'info, ShareAccount>>,

    #[account(
        mut,
        constraint = !user_eta.locked @ ErrorCode::Locked,
    )]
    pub user_eta: Box<Account<'info, EncryptedTokenAccount>>,

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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_SHARES))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}


// This operation is permissionless:
// after the staking period has ended and an option has been selected, anyone can reveal anyones vote.
pub fn reveal_shares(
    ctx: Context<RevealShares>,
    computation_offset: u64,
    _share_account_id: u32,
) -> Result<()> {
    let user_pubkey = ctx.accounts.user_eta.user_pubkey;

    require!(ctx.accounts.user_eta.owner.key().eq(&ctx.accounts.owner.key()), ErrorCode::Unauthorized);
    require!(ctx.accounts.market.mint.eq(&ctx.accounts.user_eta.token_mint.key()), ErrorCode::InvalidMint);

    let market = &ctx.accounts.market;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    // Check that staking period is over.
    let reveal_start = market
        .open_timestamp
        .ok_or(ErrorCode::MarketNotOpen)?
        .saturating_add(market.time_to_stake);

    require!(current_timestamp >= reveal_start, ErrorCode::MarketNotResolved);
    require!(market.selected_options.is_some(), ErrorCode::MarketNotResolved);

    let share_account_key = ctx.accounts.share_account.key();
    let share_account_nonce = ctx.accounts.share_account.state_nonce;

    let user_eta_key = ctx.accounts.user_eta.key();
    let user_eta_nonce = ctx.accounts.user_eta.state_nonce;

    // Lock ShareAccount while MPC computation is pending
    ctx.accounts.share_account.locked = true;

    // Lock ETA if going to be modified by callback
    if ctx.accounts.share_account.unstaked_at_timestamp.is_none() {
        ctx.accounts.user_eta.locked = true;
    }

    // Build args for encrypted computation
    let is_eta_initialized = ctx.accounts.user_eta.is_initialized;
    let args = ArgBuilder::new()

        // Share account encrypted state (Enc<Shared, SharePurchase>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(share_account_nonce)
        .account(share_account_key, 8, 32 * 2)

        // User ETA encrypted state (Enc<Shared, EncryptedTokenBalance>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(user_eta_nonce)
        .account(user_eta_key, 8, 32 * 1)

        // Is ETA initialized flag
        .plaintext_bool(is_eta_initialized)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![RevealSharesCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: share_account_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: user_eta_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("reveal_shares")]
#[derive(Accounts)]
pub struct RevealSharesCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_SHARES))]
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
    pub share_account: Account<'info, ShareAccount>,
    #[account(mut)]
    pub user_eta: Account<'info, EncryptedTokenAccount>,
}

pub fn reveal_shares_callback(
    ctx: Context<RevealSharesCallback>,
    output: SignedComputationOutputs<RevealSharesOutput>,
) -> Result<()> {
    // Unlock accounts
    ctx.accounts.share_account.locked = false;
    if ctx.accounts.share_account.unstaked_at_timestamp.is_none() {
        ctx.accounts.user_eta.locked = false;
    }

    // Verify output - on error, emit event and return Ok so unlocks persist
    let res = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(RevealSharesOutput { field_0 }) => field_0,
        Err(_) => {
            emit_ts!(StakeRevealedError {
                user: ctx.accounts.user_eta.owner,
            });
            return Ok(());
        }
    };

    let revealed_amount = res.field_0;
    let revealed_option = res.field_1;
    let new_user_balance = res.field_2;

    // Update share account with revealed values
    ctx.accounts.share_account.revealed_amount = Some(revealed_amount);
    ctx.accounts.share_account.revealed_option = Some(revealed_option);

    // Only credit ETA if shares were not already unstaked
    if ctx.accounts.share_account.unstaked_at_timestamp.is_none() {
        ctx.accounts.user_eta.state_nonce = new_user_balance.nonce;
        ctx.accounts.user_eta.encrypted_state = new_user_balance.ciphertexts;
        ctx.accounts.user_eta.is_initialized = true;
    }

    emit_ts!(StakeRevealedEvent {
        user: ctx.accounts.user_eta.owner,
        market: ctx.accounts.share_account.market,
        encrypted_token_account: ctx.accounts.user_eta.key(),
        share_account: ctx.accounts.share_account.key(),
        shares_amount: revealed_amount,
        selected_option: revealed_option,
    });

    Ok(())
}
