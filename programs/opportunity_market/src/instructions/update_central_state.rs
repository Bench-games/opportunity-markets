use anchor_lang::prelude::*;

use crate::constants::{CENTRAL_STATE_SEED, MAX_PROTOCOL_FEE_BP};
use crate::error::ErrorCode;
use crate::state::CentralState;

#[derive(Accounts)]
pub struct UpdateCentralState<'info> {
    pub update_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CENTRAL_STATE_SEED],
        bump = central_state.bump,
        constraint = central_state.update_authority == update_authority.key() @ ErrorCode::Unauthorized,
    )]
    pub central_state: Account<'info, CentralState>,
}

pub fn update_central_state(
    ctx: Context<UpdateCentralState>,
    protocol_fee_bp: u16,
) -> Result<()> {
    require!(
        protocol_fee_bp <= MAX_PROTOCOL_FEE_BP,
        ErrorCode::ProtocolFeeTooHigh
    );

    let central_state = &mut ctx.accounts.central_state;
    central_state.protocol_fee_bp = protocol_fee_bp;
    Ok(())
}
