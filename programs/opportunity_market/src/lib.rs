#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod score;

pub use error::ErrorCode;
pub use instructions::*;
pub use state::*;

pub const COMP_DEF_OFFSET_WRAP_ENCRYPTED_TOKENS: u32 = comp_def_offset("wrap_encrypted_tokens");
pub const COMP_DEF_OFFSET_UNWRAP_ENCRYPTED_TOKENS: u32 = comp_def_offset("unwrap_encrypted_tokens");
pub const COMP_DEF_OFFSET_BUY_OPPORTUNITY_MARKET_SHARES: u32 = comp_def_offset("buy_opportunity_market_shares");
pub const COMP_DEF_OFFSET_REVEAL_SHARES: u32 = comp_def_offset("reveal_shares");
pub const COMP_DEF_OFFSET_UNSTAKE_EARLY: u32 = comp_def_offset("unstake_early");
pub const COMP_DEF_OFFSET_ADD_OPTION_STAKE: u32 = comp_def_offset("add_option_stake");
pub const COMP_DEF_OFFSET_CLOSE_EPHEMERAL_ENCRYPTED_TOKEN_ACCOUNT: u32 = comp_def_offset("close_ephemeral_encrypted_token_account");

declare_id!("bncZ1gDqgqhSWFzcxjeMoCtqN7odS8wYn1nS5tXZ9jA");

#[arcium_program]
pub mod opportunity_market {
    use super::*;

    pub fn wrap_encrypted_tokens_comp_def(ctx: Context<WrapEncryptedTokensCompDef>) -> Result<()> {
        instructions::wrap_encrypted_tokens_comp_def(ctx)
    }

    pub fn unwrap_encrypted_tokens_comp_def(ctx: Context<UnwrapEncryptedTokensCompDef>) -> Result<()> {
        instructions::unwrap_encrypted_tokens_comp_def(ctx)
    }

    pub fn reveal_shares_comp_def(ctx: Context<RevealSharesCompDef>) -> Result<()> {
        instructions::reveal_shares_comp_def(ctx)
    }

    pub fn unstake_early_comp_def(ctx: Context<UnstakeEarlyCompDef>) -> Result<()> {
        instructions::unstake_early_comp_def(ctx)
    }

    pub fn add_option_stake_comp_def(ctx: Context<AddOptionStakeCompDef>) -> Result<()> {
        instructions::add_option_stake_comp_def(ctx)
    }

    pub fn init_central_state(
        ctx: Context<InitCentralState>,
        earliness_cutoff_seconds: u64,
        min_option_deposit: u64,
        protocol_fee_bp: u16,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        instructions::init_central_state(ctx, earliness_cutoff_seconds, min_option_deposit, protocol_fee_bp, fee_recipient)
    }

    pub fn transfer_central_state_authority(
        ctx: Context<TransferCentralStateAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::transfer_central_state_authority(ctx, new_authority)
    }

    pub fn update_central_state(
        ctx: Context<UpdateCentralState>,
        earliness_cutoff_seconds: u64,
        min_option_deposit: u64,
        protocol_fee_bp: u16,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        instructions::update_central_state(ctx, earliness_cutoff_seconds, min_option_deposit, protocol_fee_bp, fee_recipient)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_index: u64,
        reward_amount: u64,
        time_to_stake: u64,
        time_to_reveal: u64,
        market_authority: Option<Pubkey>,
        unstake_delay_seconds: u64,
        authorized_reader_pubkey: [u8; 32],
        allow_closing_early: bool,
    ) -> Result<()> {
        instructions::create_market(
            ctx,
            market_index,
            reward_amount,
            time_to_stake,
            time_to_reveal,
            market_authority,
            unstake_delay_seconds,
            authorized_reader_pubkey,
            allow_closing_early,
        )
    }

    pub fn add_market_option(
        ctx: Context<AddMarketOption>,
        computation_offset: u64,
        option_index: u16,
        share_account_id: u32,
        name: String,
        amount_ciphertext: [u8; 32],
        input_nonce: u128,
        authorized_reader_nonce: u128,
    ) -> Result<()> {
        instructions::add_market_option(
            ctx,
            computation_offset,
            option_index,
            share_account_id,
            name,
            amount_ciphertext,
            input_nonce,
            authorized_reader_nonce,
        )
    }

    pub fn add_market_option_as_creator(
        ctx: Context<AddMarketOptionAsCreator>,
        option_index: u16,
        name: String,
    ) -> Result<()> {
        instructions::add_market_option_as_creator(ctx, option_index, name)
    }

    #[arcium_callback(encrypted_ix = "add_option_stake")]
    pub fn add_option_stake_callback(
        ctx: Context<AddOptionStakeCallback>,
        output: SignedComputationOutputs<AddOptionStakeOutput>,
    ) -> Result<()> {
        instructions::add_market_option_callback(ctx, output)
    }

    pub fn open_market(ctx: Context<OpenMarket>, open_timestamp: u64) -> Result<()> {
        instructions::open_market(ctx, open_timestamp)
    }

    pub fn select_winning_options(ctx: Context<SelectWinningOptions>, selections: Vec<WinningOption>) -> Result<()> {
        instructions::select_winning_options(ctx, selections)
    }

    pub fn extend_reveal_period(ctx: Context<ExtendRevealPeriod>, new_time_to_reveal: u64) -> Result<()> {
        instructions::extend_reveal_period(ctx, new_time_to_reveal)
    }

    pub fn increment_option_tally(ctx: Context<IncrementOptionTally>, option_index: u16, share_account_id: u32) -> Result<()> {
        instructions::increment_option_tally(ctx, option_index, share_account_id)
    }

    pub fn close_share_account(ctx: Context<CloseShareAccount>, option_index: u16, share_account_id: u32) -> Result<()> {
        instructions::close_share_account(ctx, option_index, share_account_id)
    }

    pub fn claim_pending_deposit(ctx: Context<ClaimPendingDeposit>) -> Result<()> {
        instructions::claim_pending_deposit(ctx)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees(ctx)
    }

    pub fn init_share_account(
        ctx: Context<InitShareAccount>,
        state_nonce: u128,
        share_account_id: u32,
    ) -> Result<()> {
        instructions::init_share_account(ctx, state_nonce, share_account_id)
    }

    pub fn init_encrypted_token_account(
        ctx: Context<InitEncryptedTokenAccount>,
        user_pubkey: [u8; 32],
        state_nonce: u128,
    ) -> Result<()> {
        instructions::init_encrypted_token_account(ctx, user_pubkey, state_nonce)
    }

    pub fn init_token_vault(
        ctx: Context<InitTokenVault>,
        fund_manager: Pubkey,
    ) -> Result<()> {
        instructions::init_token_vault(ctx, fund_manager)
    }

    pub fn init_ephemeral_encrypted_token_account(
        ctx: Context<InitEphemeralEncryptedTokenAccount>,
        index: u64,
        state_nonce: u128,
    ) -> Result<()> {
        instructions::init_ephemeral_encrypted_token_account(ctx, index, state_nonce)
    }

    pub fn wrap_encrypted_tokens(
        ctx: Context<WrapEncryptedTokens>,
        computation_offset: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::wrap_encrypted_tokens(ctx, computation_offset, amount)
    }

    #[arcium_callback(encrypted_ix = "wrap_encrypted_tokens")]
    pub fn wrap_encrypted_tokens_callback(
        ctx: Context<WrapEncryptedTokensCallback>,
        output: SignedComputationOutputs<WrapEncryptedTokensOutput>,
    ) -> Result<()> {
        instructions::wrap_encrypted_tokens_callback(ctx, output)
    }

    pub fn unwrap_encrypted_tokens(
        ctx: Context<UnwrapEncryptedTokens>,
        computation_offset: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::unwrap_encrypted_tokens(ctx, computation_offset, amount)
    }

    #[arcium_callback(encrypted_ix = "unwrap_encrypted_tokens")]
    pub fn unwrap_encrypted_tokens_callback(
        ctx: Context<UnwrapEncryptedTokensCallback>,
        output: SignedComputationOutputs<UnwrapEncryptedTokensOutput>,
    ) -> Result<()> {
        instructions::unwrap_encrypted_tokens_callback(ctx, output)
    }

    pub fn buy_opportunity_market_shares_comp_def(ctx: Context<BuyOpportunityMarketSharesCompDef>) -> Result<()> {
        instructions::buy_opportunity_market_shares_comp_def(ctx)
    }

    pub fn stake(
        ctx: Context<Stake>,
        computation_offset: u64,
        share_account_id: u32,
        amount_ciphertext: [u8; 32],
        selected_option_ciphertext: [u8; 32],
        input_nonce: u128,
        authorized_reader_nonce: u128,
    ) -> Result<()> {
        instructions::stake(
            ctx,
            computation_offset,
            share_account_id,
            amount_ciphertext,
            selected_option_ciphertext,
            input_nonce,
            authorized_reader_nonce,
        )
    }

    #[arcium_callback(encrypted_ix = "buy_opportunity_market_shares")]
    pub fn buy_opportunity_market_shares_callback(
        ctx: Context<BuyOpportunityMarketSharesCallback>,
        output: SignedComputationOutputs<BuyOpportunityMarketSharesOutput>,
    ) -> Result<()> {
        instructions::buy_opportunity_market_shares_callback(ctx, output)
    }
    pub fn reveal_shares(
        ctx: Context<RevealShares>,
        computation_offset: u64,
        share_account_id: u32,
    ) -> Result<()> {
        instructions::reveal_shares(ctx, computation_offset, share_account_id)
    }

    #[arcium_callback(encrypted_ix = "reveal_shares")]
    pub fn reveal_shares_callback(
        ctx: Context<RevealSharesCallback>,
        output: SignedComputationOutputs<RevealSharesOutput>,
    ) -> Result<()> {
        instructions::reveal_shares_callback(ctx, output)
    }

    pub fn unstake_early(
        ctx: Context<UnstakeEarly>,
        share_account_id: u32,
    ) -> Result<()> {
        instructions::unstake_early(ctx, share_account_id)
    }

    pub fn do_unstake_early(
        ctx: Context<DoUnstakeEarly>,
        computation_offset: u64,
        share_account_id: u32,
        share_account_owner: Pubkey,
    ) -> Result<()> {
        instructions::do_unstake_early(ctx, computation_offset, share_account_id, share_account_owner)
    }

    #[arcium_callback(encrypted_ix = "unstake_early")]
    pub fn unstake_early_callback(
        ctx: Context<UnstakeEarlyCallback>,
        output: SignedComputationOutputs<UnstakeEarlyOutput>,
    ) -> Result<()> {
        instructions::unstake_early_callback(ctx, output)
    }

    pub fn close_ephemeral_encrypted_token_account_comp_def(
        ctx: Context<CloseEphemeralEncryptedTokenAccountCompDef>,
    ) -> Result<()> {
        instructions::close_ephemeral_encrypted_token_account_comp_def(ctx)
    }

    pub fn close_ephemeral_encrypted_token_account(
        ctx: Context<CloseEphemeralEncryptedTokenAccount>,
        computation_offset: u64,
        index: u64,
    ) -> Result<()> {
        instructions::close_ephemeral_encrypted_token_account(ctx, computation_offset, index)
    }

    #[arcium_callback(encrypted_ix = "close_ephemeral_encrypted_token_account")]
    pub fn close_ephemeral_encrypted_token_account_callback(
        ctx: Context<CloseEphemeralEncryptedTokenAccountCallback>,
        output: SignedComputationOutputs<CloseEphemeralEncryptedTokenAccountOutput>,
    ) -> Result<()> {
        instructions::close_ephemeral_encrypted_token_account_callback(ctx, output)
    }
}
