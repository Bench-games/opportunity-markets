use anchor_lang::prelude::*;

use crate::constants::STAKE_ACCOUNT_SEED;
use crate::events::{emit_ts, StakeAccountInitializedEvent};
use crate::state::{MarketPhase, OpportunityMarket, StakeAccount};

#[derive(Accounts)]
#[instruction(stake_account_id: u32)]
pub struct InitStakeAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: owner is verified by being a PDA seed input.
    /// No signature required: this instruction is permissionless.
    pub owner: UncheckedAccount<'info>,

    pub market: Account<'info, OpportunityMarket>,

    #[account(
        init,
        payer = payer,
        space = 8 + StakeAccount::INIT_SPACE,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    pub system_program: Program<'info, System>,
}

pub fn init_stake_account(ctx: Context<InitStakeAccount>, stake_account_id: u32) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.require_phase(Clock::get()?.unix_timestamp as u64, MarketPhase::Staking)?;

    let stake_account = &mut ctx.accounts.stake_account;

    stake_account.bump = ctx.bumps.stake_account;
    stake_account.owner = ctx.accounts.owner.key();
    stake_account.market = ctx.accounts.market.key();
    stake_account.id = stake_account_id;

    emit_ts!(StakeAccountInitializedEvent {
        stake_account: stake_account.key(),
        owner: stake_account.owner,
        account_id: stake_account_id,
        market: stake_account.market,
    });

    Ok(())
}
