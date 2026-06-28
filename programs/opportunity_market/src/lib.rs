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

pub const COMP_DEF_OFFSET_VOUCH: u32 = comp_def_offset("vouch");
pub const COMP_DEF_OFFSET_REVEAL_VOUCH: u32 = comp_def_offset("reveal_vouch");

declare_id!("BENCLZWw5m2xTr3Mtb5nzWMLcBJFw6DNDtNAuhjNPgAe");

#[arcium_program]
pub mod opportunity_market {
    use super::*;

    pub fn reveal_vouch_comp_def(ctx: Context<RevealVouchCompDef>) -> Result<()> {
        instructions::reveal_vouch_comp_def(ctx)
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

    pub fn open_market(ctx: Context<OpenMarket>, time_to_vouch: u64) -> Result<()> {
        instructions::open_market(ctx, time_to_vouch)
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

    pub fn finalize_reveal_vouch(
        ctx: Context<FinalizeRevealVouch>,
        option_id: u64,
        vouch_account_id: u32,
    ) -> Result<()> {
        instructions::finalize_reveal_vouch(ctx, option_id, vouch_account_id)
    }

    pub fn claim_rewards<'info>(ctx: Context<'info, ClaimRewards<'info>>) -> Result<()> {
        instructions::claim_rewards(ctx)
    }

    pub fn close_vouch_account<'info>(ctx: Context<'info, CloseVouchAccount<'info>>) -> Result<()> {
        instructions::close_vouch_account(ctx)
    }

    pub fn close_unrevealed_vouch_account<'info>(
        ctx: Context<'info, CloseUnrevealedVouchAccount<'info>>,
    ) -> Result<()> {
        instructions::close_unrevealed_vouch_account(ctx)
    }

    pub fn close_stuck_vouch_account(
        ctx: Context<CloseStuckVouchAccount>,
        vouch_account_id: u32,
    ) -> Result<()> {
        instructions::close_stuck_vouch_account(ctx, vouch_account_id)
    }

    pub fn close_option_account(ctx: Context<CloseOptionAccount>, option_id: u64) -> Result<()> {
        instructions::close_option_account(ctx, option_id)
    }

    pub fn withdraw_vouch(ctx: Context<WithdrawVouch>, vouch_account_id: u32) -> Result<()> {
        instructions::withdraw_vouch(ctx, vouch_account_id)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees(ctx)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claim_creator_fees(ctx)
    }

    pub fn init_vouch_account(ctx: Context<InitVouchAccount>, vouch_account_id: u32) -> Result<()> {
        instructions::init_vouch_account(ctx, vouch_account_id)
    }

    pub fn vouch_comp_def(ctx: Context<VouchCompDef>) -> Result<()> {
        instructions::vouch_comp_def(ctx)
    }

    pub fn vouch(ctx: Context<Vouch>, params: VouchParameters) -> Result<()> {
        instructions::vouch(ctx, params)
    }

    #[arcium_callback(encrypted_ix = "vouch")]
    pub fn vouch_callback(
        ctx: Context<VouchCallback>,
        output: SignedComputationOutputs<VouchOutput>,
    ) -> Result<()> {
        instructions::vouch_callback(ctx, output)
    }

    pub fn reveal_vouch(
        ctx: Context<RevealVouch>,
        computation_offset: u64,
        vouch_account_id: u32,
    ) -> Result<()> {
        instructions::reveal_vouch(ctx, computation_offset, vouch_account_id)
    }

    #[arcium_callback(encrypted_ix = "reveal_vouch")]
    pub fn reveal_vouch_callback(
        ctx: Context<RevealVouchCallback>,
        output: SignedComputationOutputs<RevealVouchOutput>,
    ) -> Result<()> {
        instructions::reveal_vouch_callback(ctx, output)
    }
}
