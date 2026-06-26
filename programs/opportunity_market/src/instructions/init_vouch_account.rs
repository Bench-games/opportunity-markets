use anchor_lang::prelude::*;

use crate::constants::VOUCH_ACCOUNT_SEED;
use crate::events::{emit_ts, VouchAccountInitializedEvent};
use crate::state::{MarketPhase, OpportunityMarket, VouchAccount};

#[derive(Accounts)]
#[instruction(vouch_account_id: u32)]
pub struct InitVouchAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: owner is verified by being a PDA seed input.
    /// No signature required: this instruction is permissionless.
    pub owner: UncheckedAccount<'info>,

    pub market: Account<'info, OpportunityMarket>,

    #[account(
        init,
        payer = payer,
        space = 8 + VouchAccount::INIT_SPACE,
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account_id.to_le_bytes()],
        bump,
    )]
    pub vouch_account: Account<'info, VouchAccount>,

    pub system_program: Program<'info, System>,
}

pub fn init_vouch_account(ctx: Context<InitVouchAccount>, vouch_account_id: u32) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.require_phase(Clock::get()?.unix_timestamp as u64, MarketPhase::Vouching)?;

    let vouch_account = &mut ctx.accounts.vouch_account;

    vouch_account.bump = ctx.bumps.vouch_account;
    vouch_account.owner = ctx.accounts.owner.key();
    vouch_account.market = ctx.accounts.market.key();
    vouch_account.id = vouch_account_id;

    emit_ts!(VouchAccountInitializedEvent {
        vouch_account: vouch_account.key(),
        owner: vouch_account.owner,
        account_id: vouch_account_id,
        market: vouch_account.market,
    });

    Ok(())
}
