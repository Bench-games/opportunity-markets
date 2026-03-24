use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeRevealedEvent};
use crate::instructions::stake::STAKE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, StakeAccount};
use crate::COMP_DEF_OFFSET_REVEAL_STAKE;
use crate::{ArciumSignerAccount, ID, ID_CONST};

#[queue_computation_accounts("reveal_stake", signer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, stake_account_id: u32)]
pub struct RevealStake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: Any account, this operation is permissionless.
    pub owner: UncheckedAccount<'info>,

    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = stake_account.revealed_option.is_none() @ ErrorCode::AlreadyRevealed,
        constraint = !stake_account.locked || stake_account.pending_reveal @ ErrorCode::Locked,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_STAKE))]
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
pub fn reveal_stake(
    ctx: Context<RevealStake>,
    computation_offset: u64,
    _stake_account_id: u32,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    // Check that staking period is over.
    let reveal_start = market
        .open_timestamp
        .ok_or(ErrorCode::MarketNotOpen)?
        .saturating_add(market.time_to_stake);

    require!(current_timestamp >= reveal_start, ErrorCode::MarketNotResolved);
    require!(
        market.selected_options.is_some(),
        ErrorCode::MarketNotResolved
    );

    let stake_account_key = ctx.accounts.stake_account.key();
    let stake_account_nonce = ctx.accounts.stake_account.state_nonce;

    // Lock StakeAccount while MPC computation is pending
    ctx.accounts.stake_account.locked = true;
    ctx.accounts.stake_account.pending_reveal = true;

    let user_pubkey = ctx.accounts.stake_account.user_pubkey;

    // Build args for encrypted computation (option decryption only)
    let args = ArgBuilder::new()
        // Stake account encrypted option (Enc<Shared, SelectedOption>)
        .x25519_pubkey(user_pubkey)
        .plaintext_u128(stake_account_nonce)
        .account(stake_account_key, 8, 32 * 1)
        .build();

    // Queue computation with callback
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![RevealStakeCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: stake_account_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
    )?;

    Ok(())
}

#[callback_accounts("reveal_stake")]
#[derive(Accounts)]
pub struct RevealStakeCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_STAKE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,

    // Callback accounts
    #[account(mut)]
    pub stake_account: Box<Account<'info, StakeAccount>>,
}

pub fn reveal_stake_callback(
    ctx: Context<RevealStakeCallback>,
    output: SignedComputationOutputs<RevealStakeOutput>,
) -> Result<()> {
    // Verify output — on failure, revert so the account stays locked
    // with pending_reveal=true, allowing the user to retry reveal_stake
    let revealed_option = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(RevealStakeOutput { field_0 }) => field_0,
        Err(e) => return Err(e),
    };

    // Unlock only on success
    ctx.accounts.stake_account.locked = false;
    ctx.accounts.stake_account.pending_reveal = false;

    // Set revealed option
    ctx.accounts.stake_account.revealed_option = Some(revealed_option);

    emit_ts!(StakeRevealedEvent {
        user: ctx.accounts.stake_account.owner,
        market: ctx.accounts.stake_account.market,
        stake_account: ctx.accounts.stake_account.key(),
        stake_account_id: ctx.accounts.stake_account.id,
        stake_amount: ctx.accounts.stake_account.amount,
        selected_option: revealed_option,
    });

    Ok(())
}
