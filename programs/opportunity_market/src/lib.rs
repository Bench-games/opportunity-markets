#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod score;
pub mod state;
pub mod utils;

pub use error::ErrorCode;
pub use instructions::*;
pub use state::*;

pub const COMP_DEF_OFFSET_STAKE: u32 = comp_def_offset("stake");
pub const COMP_DEF_OFFSET_REVEAL_STAKE: u32 = comp_def_offset("reveal_stake");

declare_id!("bncqApu6NkUibDwnbfXR5oRPCLiYjwHgVuCdHRTD6rp");

#[arcium_program]
pub mod opportunity_market {
    use super::*;

    pub fn reveal_stake_comp_def(ctx: Context<RevealStakeCompDef>) -> Result<()> {
        instructions::reveal_stake_comp_def(ctx)
    }

    pub fn init_platform_config(
        ctx: Context<InitPlatformConfig>,
        params: InitPlatformParameters,
    ) -> Result<()> {
        instructions::init_platform_config(ctx, params)
    }

    pub fn update_platform_config(
        ctx: Context<UpdatePlatformConfig>,
        params: UpdatePlatformParameters,
    ) -> Result<()> {
        instructions::update_platform_config(ctx, params)
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

    pub fn create_market(ctx: Context<CreateMarket>, params: CreateMarketParameters) -> Result<()> {
        instructions::create_market(ctx, params)
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

    pub fn add_reward(ctx: Context<AddReward>, amount: u64) -> Result<()> {
        instructions::add_reward(ctx, amount)
    }

    pub fn finalize_reveal_stake(
        ctx: Context<FinalizeRevealStake>,
        option_id: u64,
        stake_account_id: u32,
    ) -> Result<()> {
        instructions::finalize_reveal_stake(ctx, option_id, stake_account_id)
    }

    pub fn claim_rewards<'info>(ctx: Context<'info, ClaimRewards<'info>>) -> Result<()> {
        instructions::claim_rewards(ctx)
    }

    pub fn close_stake_account<'info>(ctx: Context<'info, CloseStakeAccount<'info>>) -> Result<()> {
        instructions::close_stake_account(ctx)
    }

    pub fn close_unrevealed_stake_account<'info>(
        ctx: Context<'info, CloseUnrevealedStakeAccount<'info>>,
    ) -> Result<()> {
        instructions::close_unrevealed_stake_account(ctx)
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

    pub fn stake(ctx: Context<Stake>, params: StakeParameters) -> Result<()> {
        instructions::stake(ctx, params)
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
