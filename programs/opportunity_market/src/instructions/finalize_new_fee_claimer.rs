use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, FEE_CLAIMER_SEED, TIMELOCKED_CHANGE_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, AccountChangeFinalizedEvent};
use crate::state::{CentralState, TimelockedAccountChange};

#[derive(Accounts)]
pub struct FinalizeNewFeeClaimer<'info> {
    #[account(mut)]
    pub update_authority: Signer<'info>,

    /// The proposed new fee claimer must co-sign to prevent fat-finger mistakes.
    pub proposed_fee_claimer: Signer<'info>,

    #[account(
        mut,
        seeds = [CENTRAL_STATE_SEED],
        bump = central_state.bump,
        constraint = central_state.update_authority == update_authority.key() @ ErrorCode::Unauthorized,
    )]
    pub central_state: Account<'info, CentralState>,

    #[account(
        mut,
        close = update_authority,
        seeds = [TIMELOCKED_CHANGE_SEED, FEE_CLAIMER_SEED, central_state.key().as_ref()],
        bump = timelocked_change.bump,
        constraint = timelocked_change.proposed_value == proposed_fee_claimer.key() @ ErrorCode::Unauthorized,
    )]
    pub timelocked_change: Account<'info, TimelockedAccountChange>,
}

pub fn finalize_new_fee_claimer(ctx: Context<FinalizeNewFeeClaimer>) -> Result<()> {
    let clock = Clock::get()?;
    let change = &ctx.accounts.timelocked_change;

    require!(
        clock.unix_timestamp >= change.execute_after,
        ErrorCode::TimelockNotElapsed
    );

    let old_value = ctx.accounts.central_state.fee_claimer;
    ctx.accounts.central_state.fee_claimer = change.proposed_value;

    emit_ts!(AccountChangeFinalizedEvent {
        central_state: ctx.accounts.central_state.key(),
        change_type: "fee_claimer".to_string(),
        old_value: old_value,
        new_value: change.proposed_value,
    });

    Ok(())
}
