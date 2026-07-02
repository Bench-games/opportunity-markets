use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::constants::VOUCH_ACCOUNT_SEED;
use crate::error::ErrorCode;
use crate::events::{emit_ts, VouchedEvent};
use crate::state::{CollectedUserFees, MarketPhase, OpportunityMarket, VouchAccount};
use crate::COMP_DEF_OFFSET_VOUCH;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct VouchParameters {
    pub computation_offset: u64,
    pub vouch_account_id: u32,
    pub amount: u64,
    pub selected_option_ciphertext: [u8; 32],
    pub input_nonce: u128,
    pub authorized_reader_nonce: u128,
    pub user_pubkey: [u8; 32],
    pub state_nonce: u128,
}

#[queue_computation_accounts("vouch", payer)]
#[derive(Accounts)]
#[instruction(params: VouchParameters)]
pub struct Vouch<'info> {
    #[account(
        constraint = signer.key() == vouch_account.owner @ ErrorCode::Unauthorized,
    )]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [VOUCH_ACCOUNT_SEED, vouch_account.owner.as_ref(), market.key().as_ref(), &params.vouch_account_id.to_le_bytes()],
        bump = vouch_account.bump,
        constraint = vouch_account.vouched_at_timestamp.is_none() @ ErrorCode::AlreadyVouched,
        constraint = vouch_account.vouch_withdrawn_at_timestamp.is_none() @ ErrorCode::AlreadyVouchWithdrawn,
        constraint = vouch_account.pending_vouch_computation.is_none() @ ErrorCode::Locked,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

    // SPL token accounts
    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Funds the vouch.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
        token::token_program = token_program,
    )]
    pub signer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,

    // Arcium accounts
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(params.computation_offset, mxe_account))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOUCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

pub fn vouch(ctx: Context<Vouch>, params: VouchParameters) -> Result<()> {
    require!(params.amount > 0, ErrorCode::InsufficientBalance);
    require!(
        params.amount >= ctx.accounts.market.min_vouch_amount,
        ErrorCode::VouchBelowMinimum
    );

    let market = &ctx.accounts.market;
    let authorized_reader_pubkey = market.authorized_reader_pubkey;
    let now = Clock::get()?.unix_timestamp as u64;
    market.require_phase(now, MarketPhase::Vouching)?;

    let collected_fees = market.calculate_user_fees(params.amount)?;
    let net_amount = params
        .amount
        .checked_sub(collected_fees.total()?)
        .ok_or(ErrorCode::Overflow)?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.signer_token_account.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.market_token_ata.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        params.amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // Set vouch account fields
    ctx.accounts.vouch_account.vouched_at_timestamp = Some(now);
    ctx.accounts.vouch_account.amount = net_amount;
    ctx.accounts.vouch_account.collected_fees = collected_fees;
    ctx.accounts.vouch_account.user_pubkey = params.user_pubkey;
    ctx.accounts.vouch_account.state_nonce = params.state_nonce;
    ctx.accounts.vouch_account.pending_vouch_computation =
        Some(ctx.accounts.computation_account.key());

    let vouch_account_key = ctx.accounts.vouch_account.key();
    let market_key = ctx.accounts.market.key();

    // Build args for encrypted computation
    let args = ArgBuilder::new()
        // User's option input (Enc<Shared, SelectedOption>)
        .x25519_pubkey(params.user_pubkey)
        .plaintext_u128(params.input_nonce)
        .encrypted_u64(params.selected_option_ciphertext)
        // Authorized reader context (Shared)
        .x25519_pubkey(authorized_reader_pubkey)
        .plaintext_u128(params.authorized_reader_nonce) // .account => no locking by hand
        // Vouch account context (Shared for MXE output encryption)
        .x25519_pubkey(params.user_pubkey)
        .plaintext_u128(params.state_nonce)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        params.computation_offset,
        args,
        vec![VouchCallback::callback_ix(
            params.computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: vouch_account_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: market_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
        0,
    )?;

    Ok(())
}

#[callback_accounts("vouch")]
#[derive(Accounts)]
pub struct VouchCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOUCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,

    // Callback accounts
    #[account(mut)]
    pub vouch_account: Box<Account<'info, VouchAccount>>,
    #[account(
        mut,
        constraint = market.key() == vouch_account.market @ ErrorCode::InvalidAccountState,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,
}

pub fn vouch_callback(
    ctx: Context<VouchCallback>,
    output: SignedComputationOutputs<VouchOutput>,
) -> Result<()> {
    // On failure, revert so the account stays stuck.
    // The owner can recover via close_stuck_vouch_account.
    let res = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(VouchOutput { field_0 }) => field_0,
        Err(e) => return Err(e),
    };

    // Reject any callback that did not originate from the computation this
    // vouch_account is waiting on. Without this, a stale callback from a
    // previous (closed-then-reborn) account could land on a freshly re-vouched
    // account that has a different computation in flight, and overwrite the
    // user's ciphertext with the old vouch's data.
    require!(
        ctx.accounts.vouch_account.pending_vouch_computation
            == Some(ctx.accounts.computation_account.key()),
        ErrorCode::InvalidAccountState
    );

    // Unlock
    ctx.accounts.vouch_account.pending_vouch_computation = None;

    let vouch_data_mxe = res.field_0;
    let vouch_data_shared = res.field_1;

    // Update vouch account with encrypted option data
    ctx.accounts.vouch_account.state_nonce = vouch_data_mxe.nonce;
    ctx.accounts.vouch_account.encrypted_option = vouch_data_mxe.ciphertexts[0];
    ctx.accounts.vouch_account.state_nonce_disclosure = vouch_data_shared.nonce;
    ctx.accounts.vouch_account.encrypted_option_disclosure = vouch_data_shared.ciphertexts[0];

    let CollectedUserFees {
        platform_fee,
        reward_pool_fee,
        creator_fee,
    } = ctx.accounts.vouch_account.collected_fees;
    if platform_fee > 0 {
        ctx.accounts.market.collected_platform_fees = ctx
            .accounts
            .market
            .collected_platform_fees
            .checked_add(platform_fee)
            .ok_or(ErrorCode::Overflow)?;
    }
    if reward_pool_fee > 0 {
        ctx.accounts.market.reward_amount = ctx
            .accounts
            .market
            .reward_amount
            .checked_add(reward_pool_fee)
            .ok_or(ErrorCode::Overflow)?;
    }
    if creator_fee > 0 {
        ctx.accounts.market.collected_creator_fees = ctx
            .accounts
            .market
            .collected_creator_fees
            .checked_add(creator_fee)
            .ok_or(ErrorCode::Overflow)?;
    }

    emit_ts!(VouchedEvent {
        user: ctx.accounts.vouch_account.owner,
        market: ctx.accounts.vouch_account.market,
        vouch_account: ctx.accounts.vouch_account.key(),
        vouch_account_id: ctx.accounts.vouch_account.id,
        vouch_encrypted_option: vouch_data_mxe.ciphertexts[0],
        vouch_state_nonce: vouch_data_mxe.nonce,
        vouch_encrypted_option_disclosure: vouch_data_shared.ciphertexts[0],
        vouch_state_disclosure_nonce: vouch_data_shared.nonce,
        amount: ctx.accounts.vouch_account.amount,
    });

    Ok(())
}
