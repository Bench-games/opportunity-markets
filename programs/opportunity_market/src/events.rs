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
    pub time_to_stake: u64,
    pub time_to_reveal: u64,
    pub market_authority: Option<Pubkey>,
    pub authorized_reader_pubkey: [u8; 32],
    pub unstake_delay_seconds: u64,
    pub allow_closing_early: bool,
    pub timestamp: i64,
}

#[event]
pub struct MarketOptionCreatedEvent {
    pub option: Pubkey,
    pub market: Pubkey,
    pub creator: Pubkey,
    pub by_market_creator: bool, 
    pub index: u16, pub name: String,
    pub timestamp: i64,
}

#[event]
pub struct EncryptedTokensWrappedEvent {
    pub encrypted_token_account: Pubkey,
    pub user: Pubkey,
    pub deposit_amount: u64,
    pub encrypted_new_balance: [u8; 32],
    pub nonce: u128,
    pub timestamp: i64,
}

#[event]
pub struct StakedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub share_account: Pubkey,
    pub share_encrypted_state: [[u8; 32]; 2], // share amount and option
    pub share_state_nonce: u128,
    pub share_encrypted_state_disclosure: [[u8; 32]; 2],
    pub share_state_disclosure_nonce: u128,
    pub encrypted_eta_balance: [u8; 32],
    pub eta_balance_nonce: u128,
    pub timestamp: i64,
}

#[event]
pub struct StakeRevealedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub share_account: Pubkey,
    pub shares_amount: u64,
    pub selected_option: u16,
    pub timestamp: i64,
}

#[event]
pub struct UnstakedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub share_account: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StakeRevealedError {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StakedError {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct UnstakedError {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EncryptedTokensUnwrappedError {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EncryptedTokensUnwrappedEvent {
    pub user: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub amount_withdrawn: u64,
    pub encrypted_new_balance: [u8; 32],
    pub nonce: u128,
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
pub struct OptionSelectedEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub selected_options: Vec<WinningOption>,
    pub timestamp: i64,
}

#[event]
pub struct RewardClaimedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub share_account: Pubkey,
    pub option: u16,
    pub reward_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct TallyIncrementedEvent {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub share_account: Pubkey,
    pub option: u16,
    pub revealed_amount: u64,
    pub user_score: u64,
    pub timestamp: i64,
}

#[event]
pub struct RevealPeriodExtendedEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub new_time_to_reveal: u64,
    pub timestamp: i64,
}

#[event]
pub struct PendingDepositClaimedEvent {
    pub user: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EphemeralAccountClosedEvent {
    pub user: Pubkey,
    pub encrypted_token_account: Pubkey,
    pub encrypted_new_balance: [u8; 32],
    pub nonce: u128,
    pub timestamp: i64,
}

#[event]
pub struct EphemeralAccountClosedError {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct UnstakeInitiatedEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub share_account: Pubkey,
    pub unstakeable_at_timestamp: u64,
    pub timestamp: i64,
}

#[event]
pub struct EncryptedTokenAccountInitializedEvent {
    pub encrypted_token_account: Pubkey,
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EphemeralEncryptedTokenAccountInitializedEvent {
    pub encrypted_token_account: Pubkey,
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub index: u64,
    pub rent_payer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ShareAccountInitializedEvent {
    pub share_account: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimedEvent {
    pub token_vault: Pubkey,
    pub mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
