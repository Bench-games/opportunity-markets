use anchor_lang::prelude::*;

use crate::state::WinningOption;

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
    pub index: u64,
    pub mint: Pubkey,
    pub time_to_stake: u64,
    pub time_to_reveal: u64,
    pub earliness_cutoff_seconds: u64,
    pub market_authority: Pubkey,
    pub authorized_reader_pubkey: [u8; 32],
    pub unstake_delay_seconds: u64,
    pub allow_closing_early: bool,
    pub timestamp: i64,
}

#[event]
pub struct MarketOptionCreatedEvent {
    pub option: Pubkey,
    pub market: Pubkey,
    pub market_authority: Pubkey,
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
    pub user: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub timestamp: i64,
}

#[event]
pub struct MarketOpenedEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub open_timestamp: u64,
    pub timestamp: i64,
}

#[event]
pub struct WinningOptionsSelectedEvent {
    pub market: Pubkey,
    pub market_authority: Pubkey,
    pub selected_options: Vec<WinningOption>,
    pub timestamp: i64,
}

#[event]
pub struct RewardClaimedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub option_id: u64,
    pub reward_amount: u64,
    pub staked_at_timestamp: u64,
    pub unstaked_at_timestamp: u64,
    pub stake_amount: u64,
    pub score: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakeReclaimedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct TallyIncrementedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub option_id: u64,
    pub user_stake: u64,
    pub user_score: u64,

    pub total_score: u64,
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
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct UnstakeInitiatedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub unstakeable_at_timestamp: u64,
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
    pub token_vault: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarketPausedEvent {
    pub market: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MarketResumedEvent {
    pub market: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StuckStakeClosedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub stake_account: Pubkey,
    pub stake_account_id: u32,
    pub refunded_amount: u64,
    pub refunded_fee: u64,
    pub timestamp: i64,
}

#[event]
pub struct AccountChangeProposedEvent {
    pub central_state: Pubkey,
    pub change_type: String,
    pub current_value: Pubkey,
    pub proposed_value: Pubkey,
    pub execute_after: i64,
    pub timestamp: i64,
}

#[event]
pub struct AccountChangeFinalizedEvent {
    pub central_state: Pubkey,
    pub change_type: String,
    pub old_value: Pubkey,
    pub new_value: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AccountChangeCancelledEvent {
    pub central_state: Pubkey,
    pub change_type: String,
    pub cancelled_by: Pubkey,
    pub proposed_value: Pubkey,
    pub timestamp: i64,
}
