use crate::error::ErrorCode;
use anchor_lang::prelude::*;

// Fixed-point scale factor to avoid decimal division
pub const PRECISION: u64 = 10_000;
// Dividing score by 200 ensures that there is no overflow possible while still maintaining score as precise as possible
pub const OVERFLOW_DIVISOR: u128 = 200;

pub fn calculate_user_score_components(
    option_created: u64,
    vouching_window_end: u64,
    user_vouched_at: u64,
    user_vouch_end: u64,
    earliness_cutoff_seconds: u64, // unlimited, not an issue
    earliness_multiplier: u16,     // 10000 - 20000
) -> Result<(u64, u64)> {
    require!(
        vouching_window_end > option_created,
        ErrorCode::InvalidParameters
    );

    let earliness_cutoff = earliness_cutoff_seconds.max(1);
    let earliness_multiplier = earliness_multiplier as u64;

    // saturating_sub: a vouch placed before the option existed gets peak earliness boost
    let delay_after_option_creation = user_vouched_at.saturating_sub(option_created).max(1);

    let earliest_vouch_start = option_created;
    let latest_vouch_end = vouching_window_end;
    let valid_vouch_start = user_vouched_at.max(earliest_vouch_start);
    let valid_vouch_end = user_vouch_end.min(latest_vouch_end);

    let max_vouch_duration = latest_vouch_end
        .checked_sub(earliest_vouch_start)
        .ok_or(ErrorCode::Overflow)?;

    let valid_vouch_duration = valid_vouch_end
        .checked_sub(valid_vouch_start)
        .ok_or(ErrorCode::Overflow)?;

    let vouch_time_percentage = valid_vouch_duration
        .checked_mul(100)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(max_vouch_duration)
        .ok_or(ErrorCode::Overflow)?;

    let boost_range = earliness_multiplier
        .checked_sub(PRECISION)
        .ok_or(ErrorCode::Overflow)?;

    let earliness_factor = earliness_multiplier
        .checked_sub(
            delay_after_option_creation
                .min(earliness_cutoff)
                .checked_mul(boost_range)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(earliness_cutoff)
                .ok_or(ErrorCode::Overflow)?,
        )
        .ok_or(ErrorCode::Overflow)?;

    Ok((vouch_time_percentage, earliness_factor))
}

pub fn calculate_user_score(
    option_created: u64,
    vouching_window_end: u64,
    user_vouched_at: u64,
    user_vouch_end: u64,
    vouch_amount: u64,
    earliness_cutoff_seconds: u64,
    earliness_multiplier: u16,
) -> Result<u64> {
    let (time_pct, earliness) = calculate_user_score_components(
        option_created,
        vouching_window_end,
        user_vouched_at,
        user_vouch_end,
        earliness_cutoff_seconds,
        earliness_multiplier,
    )?;

    // score = amount * time_pct * earliness / (PRECISION * OVERFLOW_DIVISOR)
    Ok((vouch_amount as u128)
        .checked_mul(time_pct as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_mul(earliness as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(OVERFLOW_DIVISOR)
        .ok_or(ErrorCode::Overflow)?
        .try_into()
        .map_err(|_| ErrorCode::Overflow)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_TIME_TO_VOUCH_SECONDS;

    // Realistic baseline: 1,000,000 tokens with 9 decimals
    const VOUCH: u64 = 1_000_000_000_000_000;

    // Realistic Solana clock values (≈ 2024-05-01).
    const MARKET_OPENED: u64 = 1_714_521_600;
    const ONE_WEEK: u64 = 7 * 24 * 60 * 60;

    const MULT_1_5X: u16 = 15_000;
    const MULT_2X: u16 = 20_000;
    const MULT_1X: u16 = 10_000;

    #[test]
    fn peak_boost_when_vouching_at_market_open() {
        // Vouching user enters at t=0 and never withdraws their vouch early.
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let (time_pct, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED,
            vouching_window_end,
            ONE_WEEK,
            MULT_2X,
        )
        .unwrap();

        assert_eq!(time_pct, 100);
        // .max(1) on delay_after_option_creation shaves one tick off the peak.
        assert_eq!(earliness, 2 * PRECISION - (PRECISION / ONE_WEEK));
    }

    #[test]
    fn no_boost_at_cutoff_boundary() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let cutoff = 24 * 60 * 60; // 1 day
        let (_, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + cutoff,
            vouching_window_end,
            cutoff,
            MULT_2X,
        )
        .unwrap();

        // 1.0x
        assert_eq!(earliness, PRECISION);
    }

    #[test]
    fn no_boost_after_cutoff() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let cutoff = 24 * 60 * 60;
        let (_, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + 2 * cutoff,
            vouching_window_end,
            cutoff,
            MULT_2X,
        )
        .unwrap();

        // 1.0x
        assert_eq!(earliness, PRECISION);
    }

    #[test]
    fn midway_boost_is_linear() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let cutoff = 24 * 60 * 60;
        let (_, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + cutoff / 2,
            vouching_window_end,
            cutoff,
            MULT_2X,
        )
        .unwrap();

        // 2.0x at t=0, 1.5x at t=cutoff/2.
        assert_eq!(earliness, PRECISION + PRECISION / 2);
    }

    #[test]
    fn multiplier_equal_to_precision_means_no_boost() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let (_, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + 60,
            vouching_window_end,
            ONE_WEEK,
            MULT_1X,
        )
        .unwrap();

        assert_eq!(earliness, PRECISION);
    }

    #[test]
    fn realistic_full_score_with_1_5x_multiplier() {
        // Vouch 1M tokens (9 decimals) at t=0 of a 1-week market, never withdraw.
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let score = calculate_user_score(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED,
            vouching_window_end,
            VOUCH,
            ONE_WEEK,
            MULT_1_5X,
        )
        .unwrap();

        let expected = 750000000000000;
        assert_eq!(score as u128, expected);
    }

    #[test]
    fn max_value_vouch_does_not_overflow() {
        let result = calculate_user_score(
            MARKET_OPENED,
            MARKET_OPENED + MAX_TIME_TO_VOUCH_SECONDS,
            MARKET_OPENED,
            u64::MAX,
            u64::MAX,
            u64::MAX,
            MULT_2X,
        );
        println!("result: {:?}", result);
        assert!(result.is_ok());
    }

    #[test]
    fn early_vouch_withdrawal_pulls_time_pct_below_full() {
        // User vouches at t=0, then withdraws the vouch 1 day into a 1-week market.
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let day = 24 * 60 * 60;
        let (time_pct, _) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED,
            MARKET_OPENED + day,
            ONE_WEEK,
            MULT_1_5X,
        )
        .unwrap();

        // 1 day out of 7 → 14% (integer truncation).
        assert_eq!(time_pct, 14);
    }

    #[test]
    fn zero_amount_yields_zero_score() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let score = calculate_user_score(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED,
            vouching_window_end,
            0,
            ONE_WEEK,
            MULT_2X,
        )
        .unwrap();

        assert_eq!(score, 0);
    }

    #[test]
    fn zero_vouch_duration_yields_zero_score() {
        // Vouching user withdraws the vouch the same second they vouch.
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let t = MARKET_OPENED + 60;
        let score = calculate_user_score(
            MARKET_OPENED,
            vouching_window_end,
            t,
            t,
            VOUCH,
            ONE_WEEK,
            MULT_2X,
        )
        .unwrap();

        assert_eq!(score, 0);
    }

    #[test]
    fn zero_cutoff_does_not_panic_and_gives_no_boost() {
        // Cutoff = 0 is .max(1)'d internally; any delay_after_option_creation >= 1 hits the
        // clamp, so factor = PRECISION (1.0x) regardless of vouching time.
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let (_, earliness) = calculate_user_score_components(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + 60,
            vouching_window_end,
            0,
            MULT_2X,
        )
        .unwrap();

        assert_eq!(earliness, PRECISION);
    }

    #[test]
    fn reveal_before_option_creation_errors() {
        let r = calculate_user_score(
            MARKET_OPENED,
            // vouching_window_end < option_created
            MARKET_OPENED - 1,
            MARKET_OPENED,
            MARKET_OPENED,
            VOUCH,
            ONE_WEEK,
            MULT_2X,
        );
        assert!(r.is_err());
    }

    #[test]
    fn option_created_at_vouching_window_end_errors() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let r = calculate_user_score(
            vouching_window_end,
            vouching_window_end,
            MARKET_OPENED,
            vouching_window_end,
            VOUCH,
            ONE_WEEK,
            MULT_2X,
        );
        assert!(r.is_err());
    }

    #[test]
    fn vouch_end_before_vouch_start_errors() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let r = calculate_user_score(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED + 100,
            // withdraw before vouch
            MARKET_OPENED + 50,
            VOUCH,
            ONE_WEEK,
            MULT_2X,
        );
        assert!(r.is_err());
    }

    #[test]
    fn vouch_before_option_creation_gets_peak_earliness() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let user_vouched_at = MARKET_OPENED + 10;
        let option_created = MARKET_OPENED + 60 * 60;

        let (_, earliness) = calculate_user_score_components(
            option_created,
            vouching_window_end,
            user_vouched_at,
            vouching_window_end,
            ONE_WEEK,
            MULT_2X,
        )
        .unwrap();

        assert_eq!(earliness, 2 * PRECISION - (PRECISION / ONE_WEEK));
    }

    #[test]
    fn tiny_vouch_gets_some_score() {
        let vouching_window_end = MARKET_OPENED + ONE_WEEK;
        let score = calculate_user_score(
            MARKET_OPENED,
            vouching_window_end,
            MARKET_OPENED,
            vouching_window_end,
            1,
            ONE_WEEK,
            MULT_2X,
        )
        .unwrap();
        assert_eq!(score, 1);
    }
}
