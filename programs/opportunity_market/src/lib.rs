#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod score;
pub mod state;

pub use error::ErrorCode;
pub use instructions::*;
pub use state::*;

pub const COMP_DEF_OFFSET_STAKE: u32 = comp_def_offset("stake");
pub const COMP_DEF_OFFSET_REVEAL_STAKE: u32 = comp_def_offset("reveal_stake");

declare_id!("B3NCHsGBkdZrPYPJY2rjg4UwmyRotMmFWhxa5hMHwLeg");

#[arcium_program]
pub mod opportunity_market {
    use super::*;

    pub fn reveal_stake_comp_def(ctx: Context<RevealStakeCompDef>) -> Result<()> {
        instructions::reveal_stake_comp_def(ctx)
    }

    pub fn init_platform_config(
        ctx: Context<InitPlatformConfig>,
        name: String,
        platform_fee_bp: u16,
        reward_pool_fee_bp: u16,
        creator_fee_bp: u16,
        fee_claim_authority: Pubkey,
        reveal_authority: Pubkey,
        min_time_to_stake_seconds: u64,
        reveal_period_seconds: u64,
        market_resolution_deadline_seconds: u64,
    ) -> Result<()> {
        instructions::init_platform_config(
            ctx,
            name,
            platform_fee_bp,
            reward_pool_fee_bp,
            creator_fee_bp,
            fee_claim_authority,
            reveal_authority,
            min_time_to_stake_seconds,
            reveal_period_seconds,
            market_resolution_deadline_seconds,
        )
    }

    pub fn update_platform_config(
        ctx: Context<UpdatePlatformConfig>,
        platform_fee_bp: u16,
        reward_pool_fee_bp: u16,
        creator_fee_bp: u16,
        reveal_authority: Pubkey,
        min_time_to_stake_seconds: u64,
        reveal_period_seconds: u64,
        market_resolution_deadline_seconds: u64,
    ) -> Result<()> {
        instructions::update_platform_config(
            ctx,
            platform_fee_bp,
            reward_pool_fee_bp,
            creator_fee_bp,
            reveal_authority,
            min_time_to_stake_seconds,
            reveal_period_seconds,
            market_resolution_deadline_seconds,
        )
    }

    pub fn set_update_authority(ctx: Context<SetUpdateAuthority>) -> Result<()> {
        instructions::set_update_authority(ctx)
    }

    pub fn set_fee_claim_authority(ctx: Context<SetFeeClaimAuthority>) -> Result<()> {
        instructions::set_fee_claim_authority(ctx)
    }

    pub fn init_allowed_mint(ctx: Context<InitAllowedMint>) -> Result<()> {
        instructions::init_allowed_mint(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_index: u64,
        market_authority: Pubkey,
        allow_unstaking_early: bool,
        authorized_reader_pubkey: [u8; 32],
        earliness_cutoff_seconds: u64,
        earliness_multiplier: u16,
        min_stake_amount: u64,
        creator_fee_claimer: Pubkey,
    ) -> Result<()> {
        instructions::create_market(
            ctx,
            market_index,
            market_authority,
            allow_unstaking_early,
            authorized_reader_pubkey,
            earliness_cutoff_seconds,
            earliness_multiplier,
            min_stake_amount,
            creator_fee_claimer,
        )
    }

    pub fn add_market_option(ctx: Context<AddMarketOption>, option_id: u64) -> Result<()> {
        instructions::add_market_option(ctx, option_id)
    }

    pub fn open_market(ctx: Context<OpenMarket>, time_to_stake: u64) -> Result<()> {
        instructions::open_market(ctx, time_to_stake)
    }

    pub fn set_winning_option(
        ctx: Context<SetWinningOption>,
        option_id: u64,
        reward_bp: u16,
    ) -> Result<()> {
        instructions::set_winning_option(ctx, option_id, reward_bp)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>) -> Result<()> {
        instructions::resolve_market(ctx)
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

    pub fn finalize_reveal_stake(
        ctx: Context<FinalizeRevealStake>,
        option_id: u64,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::finalize_reveal_stake(ctx, option_id, stake_account_id)
    }

    pub fn close_stake_account<'info>(
        ctx: Context<'info, CloseStakeAccount<'info>>,
        option_id: u64,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::close_stake_account(ctx, option_id, stake_account_id)
    }

    pub fn close_stuck_stake_account(
        ctx: Context<CloseStuckStakeAccount>,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::close_stuck_stake_account(ctx, stake_account_id)
    }

    pub fn close_option_account(ctx: Context<CloseOptionAccount>, option_id: u64) -> Result<()> {
        instructions::close_option_account(ctx, option_id)
    }

    pub fn unstake(ctx: Context<Unstake>, stake_account_id: u32) -> Result<()> {
        instructions::unstake(ctx, stake_account_id)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees(ctx)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claim_creator_fees(ctx)
    }

    pub fn init_stake_account(ctx: Context<InitStakeAccount>, stake_account_id: u32) -> Result<()> {
        instructions::init_stake_account(ctx, stake_account_id)
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
        state_nonce: u128,
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
            state_nonce,
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
}
