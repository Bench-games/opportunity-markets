use anchor_lang::prelude::*;

use crate::state::CentralState;

#[derive(Accounts)]
pub struct InitCentralState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + CentralState::INIT_SPACE,
        seeds = [b"central_state"],
        bump,
    )]
    pub central_state: Account<'info, CentralState>,

    pub system_program: Program<'info, System>,
}

pub fn init_central_state(
    ctx: Context<InitCentralState>,
    earliness_cutoff_seconds: u64,
    min_option_deposit: u64,
    protocol_fee_bp: u16,
    fee_recipient: Pubkey,
    reward_withdraw_staked_limit: u32,
) -> Result<()> {
    let central_state = &mut ctx.accounts.central_state;
    central_state.bump = ctx.bumps.central_state;
    central_state.authority = ctx.accounts.payer.key();
    central_state.earliness_cutoff_seconds = earliness_cutoff_seconds;
    central_state.min_option_deposit = min_option_deposit;
    central_state.protocol_fee_bp = protocol_fee_bp;
    central_state.fee_recipient = fee_recipient;
    central_state.reward_withdraw_staked_limit = reward_withdraw_staked_limit;

    Ok(())
}
