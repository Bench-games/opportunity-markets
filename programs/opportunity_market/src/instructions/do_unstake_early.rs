use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, UnstakedError, UnstakedEvent};
use crate::instructions::stake::SHARE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, ShareAccount, EncryptedTokenAccount};
use crate::COMP_DEF_OFFSET_UNSTAKE_EARLY;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[queue_computation_accounts("unstake_early", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, share_account_id: u32, share_account_owner: Pubkey)]
pub struct DoUnstakeEarly<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.open_timestamp.is_some() @ ErrorCode::MarketNotOpen,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        constraint = user_eta.owner == share_account_owner @ ErrorCode::Unauthorized,
        constraint = !user_eta.locked @ ErrorCode::Locked,
    )]
    pub user_eta: Box<Account<'info, EncryptedTokenAccount>>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, share_account_owner.as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump = share_account.bump,
        constraint = share_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
        constraint = share_account.unstakeable_at_timestamp.is_some() @ ErrorCode::UnstakeNotInitiated,
        constraint = !share_account.locked @ ErrorCode::Locked,
    )]
    pub share_account: Box<Account<'info, ShareAccount>>,

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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_UNSTAKE_EARLY))]
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

pub fn do_unstake_early(
    ctx: Context<DoUnstakeEarly>,
    computation_offset: u64,
    _share_account_id: u32,
    _share_account_owner: Pubkey,
) -> Result<()> {
    let user_pubkey = ctx.accounts.user_eta.user_pubkey;

    require!(ctx.accounts.market.mint.eq(&ctx.accounts.user_eta.token_mint), ErrorCode::InvalidMint);

    // Enforce staking period is still active
    let market = &ctx.accounts.market;
    let open_timestamp = market.open_timestamp.ok_or_else(|| ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    let stake_end_timestamp = open_timestamp + market.time_to_stake;

    require!(
        current_timestamp <= stake_end_timestamp,
        ErrorCode::StakingNotActive
    );

    // Enforce unstake delay has passed
    let unstakeable_at = ctx.accounts.share_account.unstakeable_at_timestamp
        .ok_or_else(|| ErrorCode::UnstakeNotInitiated)?;
    require!(
        current_timestamp >= unstakeable_at,
        ErrorCode::UnstakeDelayNotMet
    );

    let share_account_key = ctx.accounts.share_account.key();
    let share_account_nonce = ctx.accounts.share_account.state_nonce;

    let user_eta_key = ctx.accounts.user_eta.key();
    let user_eta_nonce = ctx.accounts.user_eta.state_nonce;

    // Lock both accounts while MPC computation is pending
    ctx.accounts.user_eta.locked = true;
    ctx.accounts.share_account.locked = true;


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
        vec![UnstakeEarlyCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: user_eta_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: share_account_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("unstake_early")]
#[derive(Accounts)]
pub struct UnstakeEarlyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_UNSTAKE_EARLY))]
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
    pub user_eta: Account<'info, EncryptedTokenAccount>,
    #[account(mut)]
    pub share_account: Account<'info, ShareAccount>,
}

pub fn unstake_early_callback(
    ctx: Context<UnstakeEarlyCallback>,
    output: SignedComputationOutputs<UnstakeEarlyOutput>,
) -> Result<()> {
    // Unlock accounts
    ctx.accounts.user_eta.locked = false;
    ctx.accounts.share_account.locked = false;

    // Verify output - on error, emit event and return Ok so unlocks persist
    let new_user_balance = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(UnstakeEarlyOutput { field_0 }) => field_0,
        Err(_) => {
            emit_ts!(UnstakedError {
                user: ctx.accounts.user_eta.owner,
            });
            return Ok(());
        }
    };

    // Mark share account as unstaked
    let clock = Clock::get()?;
    ctx.accounts.share_account.unstaked_at_timestamp = Some(clock.unix_timestamp as u64);

    // Update user ETA with refunded balance
    ctx.accounts.user_eta.state_nonce = new_user_balance.nonce;
    ctx.accounts.user_eta.encrypted_state = new_user_balance.ciphertexts;
    ctx.accounts.user_eta.is_initialized = true;

    emit_ts!(UnstakedEvent {
        user: ctx.accounts.user_eta.owner,
        market: ctx.accounts.share_account.market,
        encrypted_token_account: ctx.accounts.user_eta.key(),
        share_account: ctx.accounts.share_account.key(),
    });

    Ok(())
}
