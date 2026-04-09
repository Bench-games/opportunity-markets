use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, AccountChangeCancelledEvent};
use crate::state::{CentralState, TimelockedAccountChange};

#[derive(Accounts)]
pub struct CancelUpdateAuthorityChange<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [CENTRAL_STATE_SEED],
        bump = central_state.bump,
    )]
    pub central_state: Account<'info, CentralState>,

    #[account(
        mut,
        close = signer,
        seeds = [TIMELOCKED_CHANGE_SEED, UPDATE_AUTHORITY_SEED, central_state.key().as_ref()],
        bump = timelocked_change.bump,
    )]
    pub timelocked_change: Account<'info, TimelockedAccountChange>,
}

pub fn cancel_update_authority_change(ctx: Context<CancelUpdateAuthorityChange>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let change = &ctx.accounts.timelocked_change;

    require!(
        signer == ctx.accounts.central_state.update_authority
            || signer == change.proposed_value,
        ErrorCode::Unauthorized
    );

    emit_ts!(AccountChangeCancelledEvent {
        central_state: ctx.accounts.central_state.key(),
        change_type: "update_authority".to_string(),
        cancelled_by: signer,
        proposed_value: change.proposed_value,
    });

    Ok(())
}
