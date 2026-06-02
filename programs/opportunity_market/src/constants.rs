pub const MAX_PLATFORM_FEE_BP: u16 = 300;
pub const MAX_CREATOR_FEE_BP: u16 = 500;
pub const MAX_REWARD_POOL_FEE_BP: u16 = 10_000;
pub const MAX_TOTAL_FEE_BP: u16 = 10_000;

/// Minimum and maximum length (in bytes) of a platform name.
pub const MIN_PLATFORM_NAME_LEN: usize = 3;
pub const MAX_PLATFORM_NAME_LEN: usize = 20;

#[cfg(feature = "production-settings")]
pub const MIN_MARKET_RESOLUTION_DEADLINE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[cfg(feature = "production-settings")]
pub const MIN_TIME_TO_STAKE_FLOOR_SECONDS: u64 = 24 * 60 * 60;

/// Bounds for the deadline after which end_reveal_period becomes permissionless.
pub const MIN_REVEAL_PERIOD_SECONDS: u64 = 24 * 60 * 60; // 1 day
pub const MAX_REVEAL_PERIOD_SECONDS: u64 = 60 * 24 * 60 * 60; // 60 days

// 2* PRECISION
pub const MAX_EARLINESS_MULTIPLIER: u16 = 20_000;

pub const MAX_TIME_TO_STAKE_SECONDS: u64 = 3 * 30 * 24 * 60 * 60;

/// PDA seeds
pub const PLATFORM_CONFIG_SEED: &[u8] = b"platform_config";
pub const ALLOWED_MINT_SEED: &[u8] = b"allowed_mint";
pub const OPPORTUNITY_MARKET_SEED: &[u8] = b"opportunity_market";
pub const OPTION_SEED: &[u8] = b"option";
pub const STAKE_ACCOUNT_SEED: &[u8] = b"stake_account";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
