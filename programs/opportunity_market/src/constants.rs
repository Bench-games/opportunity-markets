/// Maximum protocol fee: 5% = 500 basis points
pub const MAX_PROTOCOL_FEE_BP: u16 = 500;

/// Fixed timelock delay: 48 hours
pub const TIMELOCK_DELAY_SECONDS: i64 = 48 * 60 * 60;

/// PDA seeds
pub const CENTRAL_STATE_SEED: &[u8] = b"central_state";
pub const OPPORTUNITY_MARKET_SEED: &[u8] = b"opportunity_market";
pub const OPTION_SEED: &[u8] = b"option";
pub const STAKE_ACCOUNT_SEED: &[u8] = b"stake_account";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const TIMELOCKED_CHANGE_SEED: &[u8] = b"timelocked_change";
pub const UPDATE_AUTHORITY_SEED: &[u8] = b"update_authority";
pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
