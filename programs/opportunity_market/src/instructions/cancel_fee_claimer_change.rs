use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, FEE_CLAIMER_SEED, TIMELOCKED_CHANGE_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, AccountChangeCancelledEvent};
use crate::state::{CentralState, TimelockedAccountChange};

#[derive(Accounts)]
pub struct CancelFeeClaimerChange<'info> {
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
        seeds = [TIMELOCKED_CHANGE_SEED, FEE_CLAIMER_SEED, central_state.key().as_ref()],
        bump = timelocked_change.bump,
    )]
    pub timelocked_change: Account<'info, TimelockedAccountChange>,
}

pub fn cancel_fee_claimer_change(ctx: Context<CancelFeeClaimerChange>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let change = &ctx.accounts.timelocked_change;

    require!(
        signer == ctx.accounts.central_state.update_authority
            || signer == change.proposed_value,
        ErrorCode::Unauthorized
    );

    emit_ts!(AccountChangeCancelledEvent {
        central_state: ctx.accounts.central_state.key(),
        change_type: "fee_claimer".to_string(),
        cancelled_by: signer,
        proposed_value: change.proposed_value,
    });

    Ok(())
}
