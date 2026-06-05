use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::OPPORTUNITY_MARKET_SEED;
use crate::error::ErrorCode;
use crate::state::{OpportunityMarket, StakeAccount};

#[derive(PartialEq)]
pub enum CloseMarketState {
    Resolved,
    Expired,
}

pub fn check_close_market_state(market: &Account<OpportunityMarket>) -> Result<CloseMarketState> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let staking_window_end = market.staking_window_end.ok_or(ErrorCode::MarketNotOpen)?;
    let select_deadline = staking_window_end
        .checked_add(market.market_resolution_deadline_seconds)
        .ok_or(ErrorCode::Overflow)?;

    let resolved = market.resolved_at_timestamp.is_some();
    if resolved {
        require!(market.reveal_ended, ErrorCode::MarketNotResolved);
        return Ok(CloseMarketState::Resolved);
    }
    if current_time >= select_deadline {
        return Ok(CloseMarketState::Expired);
    }

    Err(ErrorCode::MarketNotResolved.into())
}

pub fn refund_stake_fees<'info>(
    market: &mut Account<'info, OpportunityMarket>,
    stake_account: &StakeAccount,
    token_mint: &InterfaceAccount<'info, Mint>,
    market_token_ata: &InterfaceAccount<'info, TokenAccount>,
    owner_token_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<u64> {
    let fee_refund = market.deduct_stake_fees(&stake_account.collected_fees)?;
    if fee_refund > 0 {
        transfer_from_market(
            market,
            token_mint,
            market_token_ata,
            owner_token_account,
            token_program,
            fee_refund,
        )?;
    }
    Ok(fee_refund)
}

pub fn transfer_from_market<'info>(
    market: &Account<'info, OpportunityMarket>,
    token_mint: &InterfaceAccount<'info, Mint>,
    market_token_ata: &InterfaceAccount<'info, TokenAccount>,
    recipient_token_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let platform = market.platform;
    let creator = market.creator;
    let index_bytes = market.index.to_le_bytes();
    let market_bump = market.bump;
    let market_seeds: &[&[&[u8]]] = &[&[
        OPPORTUNITY_MARKET_SEED,
        platform.as_ref(),
        creator.as_ref(),
        &index_bytes,
        &[market_bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: market_token_ata.to_account_info(),
                mint: token_mint.to_account_info(),
                to: recipient_token_account.to_account_info(),
                authority: market.to_account_info(),
            },
            market_seeds,
        ),
        amount,
        token_mint.decimals,
    )
}
