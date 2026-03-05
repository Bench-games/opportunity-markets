use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, UnstakeInitiatedEvent};
use crate::instructions::stake::SHARE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, ShareAccount};

#[derive(Accounts)]
#[instruction(share_account_id: u32)]
pub struct UnstakeEarly<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.open_timestamp.is_some() @ ErrorCode::MarketNotOpen,
        constraint = market.selected_options.is_none() @ ErrorCode::WinnerAlreadySelected,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, signer.key().as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump = share_account.bump,
        constraint = share_account.unstaked_at_timestamp.is_none() @ ErrorCode::AlreadyUnstaked,
        constraint = share_account.unstakeable_at_timestamp.is_none() @ ErrorCode::InvalidAccountState,
        constraint = !share_account.locked @ ErrorCode::Locked,
    )]
    pub share_account: Box<Account<'info, ShareAccount>>,
}

pub fn unstake_early(
    ctx: Context<UnstakeEarly>,
    _share_account_id: u32,
) -> Result<()> {
    // Enforce staking period is active
    let market = &ctx.accounts.market;
    let open_timestamp = market.open_timestamp.ok_or_else(|| ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;
    let stake_end_timestamp = open_timestamp + market.time_to_stake;

    require!(
        current_timestamp >= open_timestamp && current_timestamp <= stake_end_timestamp,
        ErrorCode::StakingNotActive
    );

    // Set the timestamp when shares become unstakeable
    let unstakeable_at = current_timestamp + market.unstake_delay_seconds;
    ctx.accounts.share_account.unstakeable_at_timestamp = Some(unstakeable_at);

    emit_ts!(UnstakeInitiatedEvent {
        user: ctx.accounts.signer.key(),
        market: market.key(),
        share_account: ctx.accounts.share_account.key(),
        unstakeable_at_timestamp: unstakeable_at,
    });

    Ok(())
}
