use anchor_lang::prelude::*;

use crate::events::{emit_ts, StakeAccountInitializedEvent};
use crate::state::{OpportunityMarket, StakeAccount};
use crate::constants::STAKE_ACCOUNT_SEED;

#[derive(Accounts)]
#[instruction(state_nonce: u128, stake_account_id: u32)]
pub struct InitStakeAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub market: Account<'info, OpportunityMarket>,

    #[account(
        init,
        payer = signer,
        space = 8 + StakeAccount::INIT_SPACE,
        seeds = [STAKE_ACCOUNT_SEED, signer.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    pub system_program: Program<'info, System>,
}

pub fn init_stake_account(
    ctx: Context<InitStakeAccount>,
    state_nonce: u128,
    stake_account_id: u32,
) -> Result<()> {
    let stake_account = &mut ctx.accounts.stake_account;

    stake_account.bump = ctx.bumps.stake_account;
    stake_account.owner = ctx.accounts.signer.key();
    stake_account.market = ctx.accounts.market.key();
    stake_account.state_nonce = state_nonce;
    stake_account.state_nonce_disclosure = 0;
    stake_account.encrypted_option = [0u8; 32];
    stake_account.encrypted_option_disclosure = [0u8; 32];
    stake_account.user_pubkey = [0u8; 32];
    stake_account.amount = 0;
    stake_account.fee = 0;
    stake_account.revealed_option = None;
    stake_account.locked = false;
    stake_account.stake_reclaimed = false;
    stake_account.pending_stake = false;
    stake_account.pending_reveal = false;
    stake_account.id = stake_account_id;

    emit_ts!(StakeAccountInitializedEvent {
        stake_account: stake_account.key(),
        owner: stake_account.owner,
        account_id: stake_account_id,
        market: stake_account.market,
    });

    Ok(())
}
