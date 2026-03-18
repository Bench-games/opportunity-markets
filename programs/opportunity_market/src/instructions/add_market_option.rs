use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, MarketOptionCreatedEvent, StakedError, StakedEvent};
use crate::state::{CentralState, OpportunityMarket, OpportunityMarketOption, ShareAccount, EncryptedTokenAccount};
use crate::instructions::stake::SHARE_ACCOUNT_SEED;
use crate::COMP_DEF_OFFSET_ADD_OPTION_STAKE;
use crate::{ID, ID_CONST, ArciumSignerAccount};

#[queue_computation_accounts("add_option_stake", creator)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, option_index: u16, share_account_id: u32)]
pub struct AddMarketOption<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        seeds = [b"central_state"],
        bump = central_state.bump,
    )]
    pub central_state: Box<Account<'info, CentralState>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OpportunityMarketOption::INIT_SPACE,
        seeds = [b"option", market.key().as_ref(), &option_index.to_le_bytes()],
        bump,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

    #[account(
        mut,
        constraint = source_eta.owner == creator.key() @ ErrorCode::Unauthorized,
        constraint = source_eta.token_mint == market.mint @ ErrorCode::InvalidMint,
        constraint = !source_eta.locked @ ErrorCode::Locked,
    )]
    pub source_eta: Box<Account<'info, EncryptedTokenAccount>>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, creator.key().as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump,
        constraint = share_account.staked_at_timestamp.is_none() @ ErrorCode::AlreadyPurchased,
        constraint = !share_account.locked @ ErrorCode::Locked,
    )]
    pub share_account: Box<Account<'info, ShareAccount>>,

    // Arcium accounts
    #[account(
        init_if_needed,
        space = 9,
        payer = creator,
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_OPTION_STAKE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

pub fn add_market_option(
    ctx: Context<AddMarketOption>,
    computation_offset: u64,
    option_index: u16,
    _share_account_id: u32,
    name: String,
    amount_ciphertext: [u8; 32],
    input_nonce: u128,
    authorized_reader_nonce: u128,
) -> Result<()> {
    let user_pubkey = ctx.accounts.source_eta.user_pubkey;
    let market = &mut ctx.accounts.market;
    let authorized_reader_pubkey = market.authorized_reader_pubkey;

    // Option index must match total_options + 1
    require!(
        option_index == market.total_options + 1,
        ErrorCode::InvalidOptionIndex
    );

    // Enforce staking period is not over (if market is open)
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    if let Some(open_timestamp) = market.open_timestamp {
        let stake_end_timestamp = open_timestamp + market.time_to_stake;
        require!(
            current_timestamp <= stake_end_timestamp,
            ErrorCode::StakingNotActive
        );
    }

    // Increment total options
    market.total_options = option_index;

    // Initialize the option account
    let option = &mut ctx.accounts.option;
    option.bump = ctx.bumps.option;
    option.index = option_index;
    option.name = name;
    option.total_shares = None;
    option.total_score = None;
    option.creator = ctx.accounts.creator.key();
    option.initialized = false;

    // Lock share account and set staked timestamp
    ctx.accounts.share_account.staked_at_timestamp = Some(current_timestamp);
    ctx.accounts.share_account.locked = true;

    let source_eta_key = ctx.accounts.source_eta.key();
    let source_eta_nonce = ctx.accounts.source_eta.state_nonce;

    let share_account_key = ctx.accounts.share_account.key();
    let option_key = ctx.accounts.option.key();

    ctx.accounts.source_eta.locked = true;

    // Build args for encrypted computation
    let args = ArgBuilder::new()
        // Encrypted amount input (Enc<Shared, AddOptionStakeInput>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(input_nonce)
        .encrypted_u64(amount_ciphertext)

        // Authorized reader context (Shared) - voluntary disclosure
        .x25519_pubkey(authorized_reader_pubkey)
        .plaintext_u128(authorized_reader_nonce)

        // User's ETA (Enc<Shared, EncryptedTokenBalance>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(source_eta_nonce)
        .account(source_eta_key, 8, 32 * 1)

        // Share account context (Shared)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(ctx.accounts.share_account.state_nonce)

        // Plaintext: min_deposit from central_state
        .plaintext_u64(ctx.accounts.central_state.min_option_deposit)

        // Plaintext: selected_option (u64 because no plaintext_u16)
        .plaintext_u64(option_index as u64)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![AddOptionStakeCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: source_eta_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: share_account_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: option_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("add_option_stake")]
#[derive(Accounts)]
pub struct AddOptionStakeCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_OPTION_STAKE))]
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
    pub source_eta: Account<'info, EncryptedTokenAccount>,

    #[account(mut)]
    pub share_account: Account<'info, ShareAccount>,

    #[account(mut)]
    pub option: Account<'info, OpportunityMarketOption>,
}

pub fn add_market_option_callback(
    ctx: Context<AddOptionStakeCallback>,
    output: SignedComputationOutputs<AddOptionStakeOutput>,
) -> Result<()> {
    // Unlock
    ctx.accounts.source_eta.locked = false;
    ctx.accounts.share_account.locked = false;

    // Verify output - on error, rollback and return Ok so mutations persist
    let res = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(AddOptionStakeOutput { field_0 }) => field_0,
        Err(_) => {
            // Rollback
            ctx.accounts.share_account.staked_at_timestamp = None;
            // TODO: Known issue (H-2) — market.total_options is not decremented on callback
            // failure, leaving a ghost option. To be addressed in a future update.
            emit_ts!(StakedError {
                user: ctx.accounts.source_eta.owner,
            });
            return Ok(());
        }
    };

    if res.field_0 {
        // Rollback
        ctx.accounts.share_account.staked_at_timestamp = None;
        emit_ts!(StakedError {
            user: ctx.accounts.source_eta.owner,
        });
        return Ok(());
    }

    let new_user_balance = res.field_1;
    let bought_shares = res.field_2;
    let bought_shares_disclosed = res.field_3;

    // Update source ETA balance
    ctx.accounts.source_eta.state_nonce = new_user_balance.nonce;
    ctx.accounts.source_eta.encrypted_state = new_user_balance.ciphertexts;
    ctx.accounts.source_eta.is_initialized = true;

    // Update share account encrypted state
    ctx.accounts.share_account.state_nonce = bought_shares.nonce;
    ctx.accounts.share_account.encrypted_state = bought_shares.ciphertexts;
    ctx.accounts.share_account.state_nonce_disclosure = bought_shares_disclosed.nonce;
    ctx.accounts.share_account.encrypted_state_disclosure =bought_shares_disclosed.ciphertexts;

    // Mark option as initialized
    ctx.accounts.option.initialized = true;

    emit_ts!(MarketOptionCreatedEvent {
        option: ctx.accounts.option.key(),
        market: ctx.accounts.share_account.market,
        index: ctx.accounts.option.index,
        name: ctx.accounts.option.name.clone(),
        creator: ctx.accounts.option.creator,
        by_market_creator: false
    });

    emit_ts!(StakedEvent {
        user: ctx.accounts.source_eta.owner,
        market: ctx.accounts.share_account.market,
        encrypted_token_account: ctx.accounts.source_eta.key(),
        share_account: ctx.accounts.share_account.key(),
        share_encrypted_state: bought_shares.ciphertexts,
        share_state_nonce: bought_shares.nonce,
        share_encrypted_state_disclosure: bought_shares_disclosed.ciphertexts,
        share_state_disclosure_nonce: bought_shares_disclosed.nonce,
        encrypted_eta_balance: new_user_balance.ciphertexts[0],
        eta_balance_nonce: new_user_balance.nonce,
    });

    Ok(())
}
