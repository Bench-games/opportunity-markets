use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardWithdrawnEvent};
use crate::constants::{OPPORTUNITY_MARKET_SEED, SPONSOR_SEED};
use crate::state::{OpportunityMarket, OpportunityMarketSponsor};

#[derive(Accounts)]
pub struct WithdrawReward<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [SPONSOR_SEED, sponsor.key().as_ref(), market.key().as_ref()],
        bump = sponsor_account.bump,
        close = sponsor,
    )]
    pub sponsor_account: Account<'info, OpportunityMarketSponsor>,

    #[account(address = market.mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Market's ATA holding reward tokens
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: InterfaceAccount<'info, TokenAccount>,

    /// Sponsor's destination for refunded reward tokens
    #[account(
        mut,
        token::mint = token_mint,
        token::token_program = token_program,
    )]
    pub refund_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw_reward(ctx: Context<WithdrawReward>) -> Result<()> {
    let sponsor_account = &ctx.accounts.sponsor_account;

    // Locked sponsors cannot withdraw
    require!(!sponsor_account.reward_locked, ErrorCode::Unauthorized);

    let market = &ctx.accounts.market;

    // Allow anytime before staking ends
    if let Some(open_timestamp) = market.open_timestamp {
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp as u64;
        let stake_end = open_timestamp
            .checked_add(market.time_to_stake)
            .ok_or(ErrorCode::Overflow)?;
        require!(current_timestamp < stake_end, ErrorCode::StakingNotActive);
    }

    let reward_amount = sponsor_account.reward_deposited;

    // Transfer sponsor's deposited amount from market ATA to refund account
    if reward_amount > 0 {
        let creator_key = market.creator;
        let index_bytes = market.index.to_le_bytes();
        let bump = market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            OPPORTUNITY_MARKET_SEED,
            creator_key.as_ref(),
            &index_bytes,
            &[bump],
        ]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.market_token_ata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.refund_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            reward_amount,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    let market = &mut ctx.accounts.market;
    market.reward_amount = market
        .reward_amount
        .checked_sub(reward_amount)
        .ok_or(ErrorCode::Overflow)?;

    emit_ts!(RewardWithdrawnEvent {
        market: market.key(),
        sponsor: ctx.accounts.sponsor.key(),
        reward_amount: reward_amount,
        refund_token_account: ctx.accounts.refund_token_account.key(),
    });

    Ok(())
}
