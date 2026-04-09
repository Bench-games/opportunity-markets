use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, TIMELOCK_DELAY_SECONDS, TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, AccountChangeProposedEvent};
use crate::state::{CentralState, TimelockedAccountChange};

#[derive(Accounts)]
pub struct ProposeNewUpdateAuthority<'info> {
    #[account(mut)]
    pub update_authority: Signer<'info>,

    #[account(
        seeds = [CENTRAL_STATE_SEED],
        bump = central_state.bump,
        constraint = central_state.update_authority == update_authority.key() @ ErrorCode::Unauthorized,
    )]
    pub central_state: Account<'info, CentralState>,

    /// CHECK: Stored as proposed value; must co-sign at finalize time.
    pub proposed_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = update_authority,
        space = 8 + TimelockedAccountChange::INIT_SPACE,
        seeds = [TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED, central_state.key().as_ref()],
        bump,
    )]
    pub timelocked_change: Account<'info, TimelockedAccountChange>,

    pub system_program: Program<'info, System>,
}

pub fn propose_new_update_authority(ctx: Context<ProposeNewUpdateAuthority>) -> Result<()> {
    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DELAY_SECONDS)
        .ok_or(ErrorCode::Overflow)?;

    let change = &mut ctx.accounts.timelocked_change;
    change.bump = ctx.bumps.timelocked_change;
    change.current_value = ctx.accounts.central_state.update_authority;
    change.proposed_value = ctx.accounts.proposed_authority.key();
    change.execute_after = execute_after;

    emit_ts!(AccountChangeProposedEvent {
        central_state: ctx.accounts.central_state.key(),
        change_type: "update_authority".to_string(),
        current_value: change.current_value,
        proposed_value: change.proposed_value,
        execute_after: execute_after,
    });

    Ok(())
}
