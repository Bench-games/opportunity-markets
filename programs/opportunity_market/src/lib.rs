#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod score;

pub use error::ErrorCode;
pub use instructions::*;
pub use state::*;

pub const COMP_DEF_OFFSET_STAKE: u32 = comp_def_offset("stake");
pub const COMP_DEF_OFFSET_REVEAL_STAKE: u32 = comp_def_offset("reveal_stake");

declare_id!("BENCHauvSzMY39khAvj43LHRpbVewb76Wv8ETsVuHn8C");

#[arcium_program]
pub mod opportunity_market {
    use super::*;

    pub fn reveal_stake_comp_def(ctx: Context<RevealStakeCompDef>) -> Result<()> {
        instructions::reveal_stake_comp_def(ctx)
    }

    pub fn init_central_state(
        ctx: Context<InitCentralState>,
        protocol_fee_bp: u16,
        fee_claimer: Pubkey,
    ) -> Result<()> {
        instructions::init_central_state(ctx, protocol_fee_bp, fee_claimer)
    }

    pub fn update_central_state(
        ctx: Context<UpdateCentralState>,
        protocol_fee_bp: u16,
    ) -> Result<()> {
        instructions::update_central_state(ctx, protocol_fee_bp)
    }

    pub fn propose_new_update_authority(
        ctx: Context<ProposeNewUpdateAuthority>,
    ) -> Result<()> {
        instructions::propose_new_update_authority(ctx)
    }

    pub fn propose_new_fee_claimer(
        ctx: Context<ProposeNewFeeClaimer>,
    ) -> Result<()> {
        instructions::propose_new_fee_claimer(ctx)
    }

    pub fn finalize_new_update_authority(
        ctx: Context<FinalizeNewUpdateAuthority>,
    ) -> Result<()> {
        instructions::finalize_new_update_authority(ctx)
    }

    pub fn finalize_new_fee_claimer(
        ctx: Context<FinalizeNewFeeClaimer>,
    ) -> Result<()> {
        instructions::finalize_new_fee_claimer(ctx)
    }

    pub fn cancel_update_authority_change(
        ctx: Context<CancelUpdateAuthorityChange>,
    ) -> Result<()> {
        instructions::cancel_update_authority_change(ctx)
    }

    pub fn cancel_fee_claimer_change(
        ctx: Context<CancelFeeClaimerChange>,
    ) -> Result<()> {
        instructions::cancel_fee_claimer_change(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_index: u64,
        time_to_stake: u64,
        time_to_reveal: u64,
        market_authority: Pubkey,
        unstake_delay_seconds: u64,
        authorized_reader_pubkey: [u8; 32],
        allow_closing_early: bool,
        reveal_period_authority: Pubkey,
        earliness_cutoff_seconds: u64,
    ) -> Result<()> {
        instructions::create_market(
            ctx,
            market_index,
            time_to_stake,
            time_to_reveal,
            market_authority,
            unstake_delay_seconds,
            authorized_reader_pubkey,
            allow_closing_early,
            reveal_period_authority,
            earliness_cutoff_seconds,
        )
    }

    pub fn add_market_option(ctx: Context<AddMarketOption>) -> Result<()> {
        instructions::add_market_option(ctx)
    }

    pub fn open_market(ctx: Context<OpenMarket>, open_timestamp: u64) -> Result<()> {
        instructions::open_market(ctx, open_timestamp)
    }

    pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
        instructions::pause_market(ctx)
    }

    pub fn resume_market(ctx: Context<ResumeMarket>) -> Result<()> {
        instructions::resume_market(ctx)
    }

    pub fn select_winning_options(ctx: Context<SelectWinningOptions>, selections: Vec<WinningOption>) -> Result<()> {
        instructions::select_winning_options(ctx, selections)
    }

    pub fn withdraw_reward(ctx: Context<WithdrawReward>) -> Result<()> {
        instructions::withdraw_reward(ctx)
    }

    pub fn end_reveal_period(ctx: Context<EndRevealPeriod>) -> Result<()> {
        instructions::end_reveal_period(ctx)
    }

    pub fn add_reward(ctx: Context<AddReward>, amount: u64, lock: bool) -> Result<()> {
        instructions::add_reward(ctx, amount, lock)
    }

    pub fn increment_option_tally(ctx: Context<IncrementOptionTally>, option_id: u64, stake_account_id: u32) -> Result<()> {
        instructions::increment_option_tally(ctx, option_id, stake_account_id)
    }

    pub fn close_stake_account(ctx: Context<CloseStakeAccount>, option_id: u64, stake_account_id: u32) -> Result<()> {
        instructions::close_stake_account(ctx, option_id, stake_account_id)
    }

    pub fn close_stuck_stake_account(ctx: Context<CloseStuckStakeAccount>, stake_account_id: u32) -> Result<()> {
        instructions::close_stuck_stake_account(ctx, stake_account_id)
    }

    pub fn reclaim_stake(ctx: Context<ReclaimStake>, stake_account_id: u32) -> Result<()> {
        instructions::reclaim_stake(ctx, stake_account_id)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees(ctx)
    }

    pub fn init_stake_account(
        ctx: Context<InitStakeAccount>,
        state_nonce: u128,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::init_stake_account(ctx, state_nonce, stake_account_id)
    }

    pub fn init_token_vault(
        ctx: Context<InitTokenVault>,
    ) -> Result<()> {
        instructions::init_token_vault(ctx)
    }

    pub fn stake_comp_def(ctx: Context<StakeCompDef>) -> Result<()> {
        instructions::stake_comp_def(ctx)
    }

    pub fn stake(
        ctx: Context<Stake>,
        computation_offset: u64,
        stake_account_id: u32,
        amount: u64,
        selected_option_ciphertext: [u8; 32],
        input_nonce: u128,
        authorized_reader_nonce: u128,
        user_pubkey: [u8; 32],
    ) -> Result<()> {
        instructions::stake(
            ctx,
            computation_offset,
            stake_account_id,
            amount,
            selected_option_ciphertext,
            input_nonce,
            authorized_reader_nonce,
            user_pubkey,
        )
    }

    #[arcium_callback(encrypted_ix = "stake")]
    pub fn stake_callback(
        ctx: Context<StakeCallback>,
        output: SignedComputationOutputs<StakeOutput>,
    ) -> Result<()> {
        instructions::stake_callback(ctx, output)
    }

    pub fn reveal_stake(
        ctx: Context<RevealStake>,
        computation_offset: u64,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::reveal_stake(ctx, computation_offset, stake_account_id)
    }

    #[arcium_callback(encrypted_ix = "reveal_stake")]
    pub fn reveal_stake_callback(
        ctx: Context<RevealStakeCallback>,
        output: SignedComputationOutputs<RevealStakeOutput>,
    ) -> Result<()> {
        instructions::reveal_stake_callback(ctx, output)
    }

    pub fn unstake_early(
        ctx: Context<UnstakeEarly>,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::unstake_early(ctx, stake_account_id)
    }

    pub fn do_unstake_early(
        ctx: Context<DoUnstakeEarly>,
        stake_account_id: u32,
        stake_account_owner: Pubkey,
    ) -> Result<()> {
        instructions::do_unstake_early(ctx, stake_account_id, stake_account_owner)
    }
}
