use anchor_lang::prelude::*;

use crate::state::FeeRates;

/// Emits an event with `timestamp` automatically set from `Clock::get()`.
macro_rules! emit_ts {
    ($event:ident { $($field:ident : $value:expr),* $(,)? }) => {{
        let clock = Clock::get()?;
        emit!($event {
            $($field: $value,)*
            timestamp: clock.unix_timestamp,
        });
    }};
}

pub(crate) use emit_ts;

#[event]
pub struct MarketCreatedEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub index: u64,
    pub mint: Pubkey,
    pub earliness_cutoff_seconds: u64,
    pub earliness_multiplier: u16,
    pub market_authority: Pubkey,
    pub authorized_reader_pubkey: [u8; 32],
    pub allow_unstaking_early: bool,
    pub min_stake_amount: u64,
    pub fee_rates: FeeRates,
    pub creator_fee_claimer: Pubkey,
    pub market_resolution_deadline_seconds: u64,
    pub reveal_period_seconds: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarketOptionCreatedEvent {
    pub option: Pubkey,
    pub market: Pubkey,
    pub signer: Pubkey,
    pub id: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub stake_encrypted_option: [u8; 32],
    pub stake_state_nonce: u128,
    pub stake_encrypted_option_disclosure: [u8; 32],
    pub stake_state_disclosure_nonce: u128,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakeRevealedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub stake_amount: u64,
    pub selected_option: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnstakedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarketOpenedEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub stake_end_timestamp: u64,
    pub timestamp: i64,
}

#[event]
pub struct WinningOptionSetEvent {
    pub market: Pubkey,
    pub market_authority: Pubkey,
    pub option: Pubkey,
    pub option_id: u64,
    pub reward_bp: u16,
    pub winning_option_allocation: u16,
    pub timestamp: i64,
}

#[event]
pub struct MarketResolvedEvent {
    pub market: Pubkey,
    pub market_authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StakeAccountClosedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub option_id: u64,
    pub reward_amount: u64,
    pub staked_at_timestamp: u64,
    pub stake_end_timestamp: u64,
    pub stake_amount: u64,
    pub score: u64,
    pub timestamp: i64,
}

#[event]
pub struct RevealStakeFinalizedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub option_id: u64,
    pub user_stake: u64,
    pub user_score: u64,

    pub total_score: u128,
    pub total_stake: u64,

    pub timestamp: i64,
}

#[event]
pub struct RewardAddedEvent {
    pub market: Pubkey,
    pub sponsor: Pubkey,
    pub amount: u64,
    pub total_reward_amount: u64,
    pub locked: bool,
    pub timestamp: i64,
}

#[event]
pub struct RewardWithdrawnEvent {
    pub market: Pubkey,
    pub sponsor: Pubkey,
    pub reward_amount: u64,
    pub refund_token_account: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RevealPeriodEndedEvent {
    pub market: Pubkey,
    pub signer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StakeAccountInitializedEvent {
    pub stake_account: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub account_id: u32,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimedEvent {
    pub market: Pubkey,
    pub platform: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AllowedMintInitializedEvent {
    pub allowed_mint: Pubkey,
    pub platform: Pubkey,
    pub mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StuckStakeClosedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub refunded_amount: u64,
    pub refunded_platform_fee: u64,
    pub refunded_reward_pool_fee: u64,
    pub refunded_creator_fee: u64,
    pub timestamp: i64,
}

#[event]
pub struct CreatorFeesClaimedEvent {
    pub market: Pubkey,
    pub creator_fee_claimer: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct UpdateAuthorityChangedEvent {
    pub platform_config: Pubkey,
    pub old_value: Pubkey,
    pub new_value: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeeClaimAuthorityChangedEvent {
    pub platform_config: Pubkey,
    pub old_value: Pubkey,
    pub new_value: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct OptionClosedEvent {
    pub option: Pubkey,
    pub option_id: u64,
    pub signer: Pubkey,
    pub creator: Pubkey,
    pub market: Pubkey,
    pub timestamp: i64,
}
