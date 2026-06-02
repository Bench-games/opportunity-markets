use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeAccountClosedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};
use crate::utils::{check_close_market_state, refund_stake_fees, CloseMarketState};

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
    let market_state = check_close_market_state(&ctx.accounts.market)?;

    let mut fee_refund = 0;
    if market_state == CloseMarketState::Expired {
        fee_refund = refund_stake_fees(
            &mut ctx.accounts.market,
            &ctx.accounts.stake_account,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
        )?;
    }

    let option_closed =
        ctx.accounts.option.owner == &System::id() && ctx.accounts.option.data_is_empty();
    if !option_closed {
        let option = Account::<OpportunityMarketOption>::try_from(ctx.accounts.option.as_ref())?;
        require!(
            option.reward_bp == 0
                || ctx.accounts.stake_account.score.is_none()
                || ctx.accounts.stake_account.rewards_claimed,
            ErrorCode::InvalidAccountState
        );
    }

    let stake_account = &ctx.accounts.stake_account;
    emit_ts!(StakeAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        stake_account: stake_account.key(),
        stake_account_id: stake_account.id,
        option_id: stake_account.revealed_option,
        stake_amount: stake_account.amount,
        fee_refund: fee_refund,
        staked_at_timestamp: stake_account.staked_at_timestamp.unwrap_or(0),
        stake_end_timestamp: stake_account.unstaked_at_timestamp.unwrap_or(0),
        score: stake_account.score.unwrap_or(0),
    });

    Ok(())
}
