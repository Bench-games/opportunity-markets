use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::constants::{REVEAL_VOUCH_COOLDOWN_SECONDS, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, VouchRevealedEvent};
use crate::state::{MarketPhase, OpportunityMarket, VouchAccount};
use crate::COMP_DEF_OFFSET_REVEAL_VOUCH;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[queue_computation_accounts("reveal_vouch", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, vouch_account_id: u32)]
pub struct RevealVouch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Any account, this operation is permissionless.
    pub owner: UncheckedAccount<'info>,

    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account_id.to_le_bytes()],
        bump = vouch_account.bump,
        constraint = vouch_account.revealed_option.is_none() @ ErrorCode::AlreadyRevealed,
        constraint = vouch_account.pending_vouch_computation.is_none() @ ErrorCode::Locked,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

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
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_VOUCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

// This operation is permissionless:
// after the vouching period has ended and an option has been selected, anyone can reveal anyones vote.
pub fn reveal_vouch(
    ctx: Context<RevealVouch>,
    computation_offset: u64,
    _vouch_account_id: u32,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let current_time = Clock::get()?.unix_timestamp as u64;
    market.require_phase(current_time, MarketPhase::Revealing)?;

    require!(
        current_time
            >= ctx.accounts.vouch_account.last_reveal_vouch_at + REVEAL_VOUCH_COOLDOWN_SECONDS,
        ErrorCode::Locked,
    );

    let vouch_account_key = ctx.accounts.vouch_account.key();
    let vouch_account_nonce = ctx.accounts.vouch_account.state_nonce;

    ctx.accounts.vouch_account.last_reveal_vouch_at = current_time;
    ctx.accounts.vouch_account.pending_reveal_computation =
        Some(ctx.accounts.computation_account.key());

    let user_pubkey = ctx.accounts.vouch_account.user_pubkey;

    // Build args for encrypted computation (option decryption only)
    let args = ArgBuilder::new()
        // Vouch account encrypted option (Enc<Shared, SelectedOption>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(vouch_account_nonce)
        .account(vouch_account_key, 8, 32)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![RevealVouchCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: vouch_account_key,
                is_writable: true,
            }],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("reveal_vouch")]
#[derive(Accounts)]
pub struct RevealVouchCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_VOUCH))]
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
}

pub fn reveal_vouch_callback(
    ctx: Context<RevealVouchCallback>,
    output: SignedComputationOutputs<RevealVouchOutput>,
) -> Result<()> {
    // On failure, revert so pending_reveal_computation stays set; retry after cooldown.
    let revealed_option = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(RevealVouchOutput { field_0 }) => field_0,
        Err(e) => return Err(e),
    };

    // Reject stale callbacks (mirrors vouch_callback's pending_vouch_computation check).
    require_keys_eq!(
        ctx.accounts
            .vouch_account
            .pending_reveal_computation
            .ok_or(ErrorCode::InvalidAccountState)?,
        ctx.accounts.computation_account.key(),
        ErrorCode::InvalidAccountState,
    );
    require!(
        ctx.accounts.vouch_account.revealed_option.is_none(),
        ErrorCode::InvalidAccountState
    );

    ctx.accounts.vouch_account.pending_reveal_computation = None;

    // Set revealed option
    ctx.accounts.vouch_account.revealed_option = Some(revealed_option);

    emit_ts!(VouchRevealedEvent {
        user: ctx.accounts.vouch_account.owner,
        market: ctx.accounts.vouch_account.market,
        vouch_account: ctx.accounts.vouch_account.key(),
        vouch_account_id: ctx.accounts.vouch_account.id,
        vouch_amount: ctx.accounts.vouch_account.amount,
        selected_option: revealed_option,
    });

    Ok(())
}
