use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::CentralState;

#[derive(Accounts)]
pub struct UpdateCentralState<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"central_state"],
        bump = central_state.bump,
        constraint = central_state.authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub central_state: Account<'info, CentralState>,
}

pub fn update_central_state(
    ctx: Context<UpdateCentralState>,
    earliness_cutoff_seconds: u64,
    min_option_deposit: u64,
    protocol_fee_bp: u16,
    fee_recipient: Pubkey,
) -> Result<()> {
    let central_state = &mut ctx.accounts.central_state;
    central_state.earliness_cutoff_seconds = earliness_cutoff_seconds;
    central_state.min_option_deposit = min_option_deposit;
    central_state.protocol_fee_bp = protocol_fee_bp;
    central_state.fee_recipient = fee_recipient;
    Ok(())
}
