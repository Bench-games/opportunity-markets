use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, AccountChangeFinalizedEvent};
use crate::state::{CentralState, TimelockedAccountChange};

#[derive(Accounts)]
pub struct FinalizeNewUpdateAuthority<'info> {
    #[account(mut)]
    pub update_authority: Signer<'info>,

    /// The proposed new authority must co-sign to prevent fat-finger mistakes.
    pub proposed_authority: Signer<'info>,

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
        seeds = [TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED, central_state.key().as_ref()],
        bump = timelocked_change.bump,
        constraint = timelocked_change.proposed_value == proposed_authority.key() @ ErrorCode::Unauthorized,
    )]
    pub timelocked_change: Account<'info, TimelockedAccountChange>,
}

pub fn finalize_new_update_authority(ctx: Context<FinalizeNewUpdateAuthority>) -> Result<()> {
    let clock = Clock::get()?;
    let change = &ctx.accounts.timelocked_change;

    require!(
        clock.unix_timestamp >= change.execute_after,
        ErrorCode::TimelockNotElapsed
    );

    let old_value = ctx.accounts.central_state.update_authority;
    ctx.accounts.central_state.update_authority = change.proposed_value;

    emit_ts!(AccountChangeFinalizedEvent {
        central_state: ctx.accounts.central_state.key(),
        change_type: "update_authority".to_string(),
        old_value: old_value,
        new_value: change.proposed_value,
    });

    Ok(())
}
