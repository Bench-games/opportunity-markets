use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeAccountClosedEvent};
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption, StakeAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct CloseStakeAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account.id.to_le_bytes()],
        bump = stake_account.bump,
        close = owner,
        constraint = stake_account.unstaked_at_timestamp.is_some() @ ErrorCode::InvalidAccountState,
        constraint = stake_account.revealed_option.is_some() @ ErrorCode::InvalidOptionId,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    /// CHECK: option is validated by seeds and in the instruction
    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &stake_account.revealed_option.unwrap().to_le_bytes()],
        bump,
    )]
    pub option: UncheckedAccount<'info>,

    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn close_stake_account<'info>(ctx: Context<'info, CloseStakeAccount<'info>>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let stake_account = &mut ctx.accounts.stake_account;
    let now = Clock::get()?.unix_timestamp as u64;
    let phase = market.phase(now)?;
    require!(
        phase == MarketPhase::Settlement || phase == MarketPhase::Expired,
        ErrorCode::WrongMarketPhase
    );

    let mut fee_refund = 0;
    if phase == MarketPhase::Settlement {
        if stake_account.rewards_claimed {
            // If the stake account had any rewards claimed it means this was a winning option and we refund the fees
            // No market changes required as the fees are already deducted in the finalize_reveal_stake instruction
            fee_refund = stake_account
                .collected_fees
                .creator_fee
                .checked_add(stake_account.collected_fees.reward_pool_fee)
                .ok_or(ErrorCode::Overflow)?;
        } else if market.winning_option_active_bp == 0 {
            // If nobody revealed a stake on any of the winning options we refund the reward pool fee as there will be no one claiming rewards
            fee_refund = stake_account.collected_fees.reward_pool_fee;
            market.reward_amount = market
                .reward_amount
                .checked_sub(fee_refund)
                .ok_or(ErrorCode::Overflow)?;
        }
    } else if phase == MarketPhase::Expired {
        let fees = stake_account.collected_fees;
        market.reward_amount = market
            .reward_amount
            .checked_sub(fees.reward_pool_fee)
            .ok_or(ErrorCode::Overflow)?;
        market.collected_creator_fees = market
            .collected_creator_fees
            .checked_sub(fees.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
        fee_refund = fees
            .reward_pool_fee
            .checked_add(fees.creator_fee)
            .ok_or(ErrorCode::Overflow)?;
    };

    if fee_refund > 0 {
        transfer_from_market(
            market,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
            fee_refund,
        )?;
    }

    let option_closed =
        ctx.accounts.option.owner == &System::id() && ctx.accounts.option.data_is_empty();
    if !option_closed {
        let option = Account::<OpportunityMarketOption>::try_from(ctx.accounts.option.as_ref())?;
        require!(
            option.reward_bp == 0 || stake_account.score.is_none() || stake_account.rewards_claimed,
            ErrorCode::InvalidAccountState
        );
    }

    emit_ts!(StakeAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        stake_account: stake_account.key(),
        stake_account_id: stake_account.id,
        option_id: stake_account.revealed_option,
        stake_amount: stake_account.amount,
        fee_refund: fee_refund,
        staked_at_timestamp: stake_account.staked_at_timestamp.unwrap_or(0),
        staking_window_end: stake_account.unstaked_at_timestamp.unwrap_or(0),
        score: stake_account.score.unwrap_or(0),
    });

    Ok(())
}
