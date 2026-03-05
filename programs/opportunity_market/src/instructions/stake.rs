use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, StakedError, StakedEvent};
use crate::state::{OpportunityMarket, ShareAccount, EncryptedTokenAccount};
use crate::COMP_DEF_OFFSET_BUY_OPPORTUNITY_MARKET_SHARES;
use crate::{ID, ID_CONST, ArciumSignerAccount};

pub const SHARE_ACCOUNT_SEED: &[u8] = b"share_account";

#[queue_computation_accounts("buy_opportunity_market_shares", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, share_account_id: u32)]
pub struct Stake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.open_timestamp.is_some() @ ErrorCode::MarketNotOpen,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        constraint = user_eta.owner == signer.key() @ ErrorCode::Unauthorized,
        constraint = !user_eta.locked @ ErrorCode::Locked,
    )]
    pub user_eta: Box<Account<'info, EncryptedTokenAccount>>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, signer.key().as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump,
        constraint = share_account.staked_at_timestamp.is_none() @ ErrorCode::AlreadyPurchased,
        constraint = share_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
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
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BUY_OPPORTUNITY_MARKET_SHARES))]
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

pub fn stake(
    ctx: Context<Stake>,
    computation_offset: u64,
    _share_account_id: u32,
    amount_ciphertext: [u8; 32],
    selected_option_ciphertext: [u8; 32],
    input_nonce: u128,
    authorized_reader_nonce: u128,
) -> Result<()> {
    let user_pubkey = ctx.accounts.user_eta.user_pubkey;

    require!(ctx.accounts.market.mint.eq(&ctx.accounts.user_eta.token_mint), ErrorCode::InvalidMint);

    // Enforce staking period is active
    let market = &ctx.accounts.market;
    let authorized_reader_pubkey = market.authorized_reader_pubkey;
    let open_timestamp = market.open_timestamp.ok_or_else(|| ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    let stake_end_timestamp = open_timestamp + market.time_to_stake;

    require!(
        current_timestamp >= open_timestamp && current_timestamp <= stake_end_timestamp,
        ErrorCode::StakingNotActive
    );

    // Capture timestamp when the buy is queued
    ctx.accounts.share_account.staked_at_timestamp = Some(current_timestamp);

    // Lock both accounts while MPC computation is pending
    ctx.accounts.user_eta.locked = true;
    ctx.accounts.share_account.locked = true;

    let user_eta_key = ctx.accounts.user_eta.key();
    let user_eta_nonce = ctx.accounts.user_eta.state_nonce;

    // Build args for encrypted computation
    let args = ArgBuilder::new()
        // User's trade input (Enc<Shared, BuySharesInput>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(input_nonce)
        .encrypted_u64(amount_ciphertext)
        .encrypted_u16(selected_option_ciphertext)

        // Authorized reader context (Shared)
        .x25519_pubkey(authorized_reader_pubkey)
        .plaintext_u128(authorized_reader_nonce)

        // User's ETA (Enc<Shared, EncryptedTokenBalance>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(user_eta_nonce)
        .account(user_eta_key, 8, 32 * 1)

        // Share account context (Mxe for output encryption)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(ctx.accounts.share_account.state_nonce)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![BuyOpportunityMarketSharesCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: user_eta_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.share_account.key(),
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("buy_opportunity_market_shares")]
#[derive(Accounts)]
pub struct BuyOpportunityMarketSharesCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BUY_OPPORTUNITY_MARKET_SHARES))]
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
    pub user_encrypted_token_account: Account<'info, EncryptedTokenAccount>,

    #[account(mut)]
    pub share_account: Account<'info, ShareAccount>,
}

pub fn buy_opportunity_market_shares_callback(
    ctx: Context<BuyOpportunityMarketSharesCallback>,
    output: SignedComputationOutputs<BuyOpportunityMarketSharesOutput>,
) -> Result<()> {
    // Unlock accounts
    ctx.accounts.user_encrypted_token_account.locked = false;
    ctx.accounts.share_account.locked = false;

    // Verify output - on error, rollback and return Ok so mutations persist
    let res = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(BuyOpportunityMarketSharesOutput { field_0 }) => field_0,
        Err(_) => {
            // Rollback
            ctx.accounts.share_account.staked_at_timestamp = None;
            emit_ts!(StakedError {
                user: ctx.accounts.user_encrypted_token_account.owner,
            });
            return Ok(());
        }
    };

    if res.field_0 {
        // Rollback
        ctx.accounts.share_account.staked_at_timestamp = None;
        emit_ts!(StakedError {
            user: ctx.accounts.user_encrypted_token_account.owner,
        });
        return Ok(());
    }

    let new_user_balance = res.field_1;
    let bought_shares_mxe = res.field_2;
    let bought_shares_shared = res.field_3;

    // Update user balance to <previous balance> - <bought shares>
    ctx.accounts.user_encrypted_token_account.state_nonce = new_user_balance.nonce;
    ctx.accounts.user_encrypted_token_account.encrypted_state = new_user_balance.ciphertexts;
    ctx.accounts.user_encrypted_token_account.is_initialized = true;

    // Update share account to the value of bought shares
    ctx.accounts.share_account.state_nonce = bought_shares_mxe.nonce;
    ctx.accounts.share_account.encrypted_state = bought_shares_mxe.ciphertexts;
    ctx.accounts.share_account.state_nonce_disclosure = bought_shares_shared.nonce;
    ctx.accounts.share_account.encrypted_state_disclosure = bought_shares_shared.ciphertexts;

    emit_ts!(StakedEvent {
        user: ctx.accounts.user_encrypted_token_account.owner,
        market: ctx.accounts.share_account.market,
        encrypted_token_account: ctx.accounts.user_encrypted_token_account.key(),
        share_account: ctx.accounts.share_account.key(),
        share_encrypted_state: bought_shares_mxe.ciphertexts,
        share_state_nonce: bought_shares_mxe.nonce,
        share_encrypted_state_disclosure: bought_shares_shared.ciphertexts,
        share_state_disclosure_nonce: bought_shares_shared.nonce,
        encrypted_eta_balance: new_user_balance.ciphertexts[0],
        eta_balance_nonce: new_user_balance.nonce,
    });

    Ok(())
}
