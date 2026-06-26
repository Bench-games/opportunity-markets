use anchor_lang::prelude::*;

use crate::constants::{OPTION_SEED, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, RevealVouchFinalizedEvent};
use crate::score::calculate_user_score;
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption, VouchAccount};

#[derive(Accounts)]
#[instruction(option_id: u64, vouch_account_id: u32)]
pub struct FinalizeRevealVouch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: this is a permissionless operation
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account_id.to_le_bytes()],
        bump = vouch_account.bump,

        constraint = vouch_account.score.is_none() @ ErrorCode::TallyAlreadyIncremented,
    )]
    pub vouch_account: Account<'info, VouchAccount>,

    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

    pub system_program: Program<'info, System>,
}

pub fn finalize_reveal_vouch(
    ctx: Context<FinalizeRevealVouch>,
    option_id: u64,
    _vouch_account_id: u32,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let option = &mut ctx.accounts.option;
    let vouch_account = &mut ctx.accounts.vouch_account;

    let current_time = Clock::get()?.unix_timestamp as u64;
    market.require_phase(current_time, MarketPhase::Revealing)?;

    let revealed_option = vouch_account
        .revealed_option
        .ok_or(ErrorCode::NotRevealed)?;
    require!(revealed_option == option_id, ErrorCode::InvalidOptionId);

    let gross_vouch_amount = vouch_account
        .amount
        .checked_add(vouch_account.collected_fees.total()?)
        .ok_or(ErrorCode::Overflow)?;

    option.unclaimed_gross_vouch = option
        .unclaimed_gross_vouch
        .checked_add(gross_vouch_amount)
        .ok_or(ErrorCode::Overflow)?;

    let vouched_at_timestamp = vouch_account
        .vouched_at_timestamp
        .ok_or(ErrorCode::NoVouch)?;
    let vouching_window_end = market
        .vouching_window_end
        .ok_or(ErrorCode::WrongMarketPhase)?;
    let user_vouch_end = vouch_account
        .unvouched_at_timestamp
        .unwrap_or(vouching_window_end);

    let user_score = calculate_user_score(
        option.created_at,
        vouching_window_end,
        vouched_at_timestamp,
        user_vouch_end,
        gross_vouch_amount,
        market.earliness_cutoff_seconds,
        market.earliness_multiplier,
    )?;

    option.total_score = option
        .total_score
        .checked_add(user_score as u128)
        .ok_or(ErrorCode::Overflow)?;

    // Store the user's score in their vouch account for reward calculation
    vouch_account.score = Some(user_score);

    if option.reward_bp > 0 && !option.included_in_active_bp && option.total_score > 0 {
        market.winning_option_active_bp = market
            .winning_option_active_bp
            .checked_add(option.reward_bp)
            .ok_or(ErrorCode::Overflow)?;
        option.included_in_active_bp = true;
    }

    // Winning option means vouch fees get refunded, so deduct from market account.
    // Actual refund transfer happens in `close_vouch_account`.
    if option.reward_bp > 0 {
        let fees = vouch_account.collected_fees;
        market.deduct_vouch_fees(&fees)?;
    }

    emit_ts!(RevealVouchFinalizedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        vouch_account: vouch_account.key(),
        vouch_account_id: vouch_account.id,
        option_id: option_id,
        user_vouch: gross_vouch_amount,
        user_score: user_score,

        total_score: option.total_score,
        total_vouch: option.unclaimed_gross_vouch,
    });

    Ok(())
}
