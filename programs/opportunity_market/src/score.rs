use crate::error::ErrorCode;
use anchor_lang::prelude::*;

// At this point no more boost for being early
pub const EARLINESS_INTERSECTION_POINT_SECONDS: u64 = 86_400;

// Fixed-point scale factor to avoid decimal division
pub const PRECISION: u64 = 10_000;

pub fn calculate_user_score_components(
    market_opened: u64,
    market_closed: u64,
    user_staked_at: u64,
    stake_amount: u64,
    earliness_cutoff_seconds: u64,
) -> Result<(u64, u64, u64)> {
    let earliness_cutoff = earliness_cutoff_seconds.max(1);
    let total_market_time = market_closed
        .checked_sub(market_opened)
        .ok_or(ErrorCode::Overflow)?;

    let stake_since_opening = user_staked_at
        .checked_sub(market_opened)
        .ok_or(ErrorCode::Overflow)?
        .max(1);

    let actual_stake_duration = market_closed
        .checked_sub(user_staked_at)
        .ok_or(ErrorCode::Overflow)?;

    // earliness_factor = 2 - x / x_n, scaled by PRECISION
    // Range: [PRECISION..2*PRECISION] i.e. [1.0x..2.0x]
    // Clamped so staking after the intersection point gives factor = 1.0
    let earliness_factor = (2 * PRECISION)
        .checked_sub(
            stake_since_opening
                .min(earliness_cutoff)
                .checked_mul(PRECISION)
                .ok_or(ErrorCode::Overflow)?
                / earliness_cutoff,
        )
        .ok_or(ErrorCode::Overflow)?;

    let stake_time_percentage = (actual_stake_duration as u128)
        .checked_mul(100)
        .ok_or(ErrorCode::Overflow)?
        .checked_div((total_market_time.max(1)) as u128)
        .ok_or(ErrorCode::Overflow)?
        .max(1) as u64;

    Ok((stake_amount, stake_time_percentage, earliness_factor))
}

pub fn calculate_user_score(
    market_opened: u64,
    market_closed: u64,
    user_staked_at: u64,
    stake_amount: u64,
    earliness_cutoff_seconds: u64,
) -> Result<u64> {
    let (amount, time_pct, earliness) =
        calculate_user_score_components(market_opened, market_closed, user_staked_at, stake_amount, earliness_cutoff_seconds)?;

    // score = amount * time_pct * earliness / PRECISION
    // Use u128 intermediate to avoid overflow
    let user_score = (amount as u128)
        .checked_mul(time_pct as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_mul(earliness as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(ErrorCode::Overflow)? as u64;

    Ok(user_score)
}
