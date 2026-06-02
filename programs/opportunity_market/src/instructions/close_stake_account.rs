use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED, STAKE_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, StakeAccountClosedEvent};
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};

#[derive(Accounts)]
#[instruction(option_id: u64, stake_account_id: u32)]
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
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        close = owner,
        // Staked tokens must have been returned before closing
        constraint = stake_account.unstaked_at_timestamp.is_some() @ ErrorCode::InvalidAccountState,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    /// CHECK: May be a closed account for non-winning options. PDA is validated in handler.
    #[account(mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &option_id.to_le_bytes()],
        bump,
    )]
    pub option: UncheckedAccount<'info>,

    #[account(address = market.mint)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Market-owned ATA holding all program-held tokens for this market
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner's token account to receive rewards
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

pub fn close_stake_account<'info>(
    ctx: Context<'info, CloseStakeAccount<'info>>,
    option_id: u64,
    _stake_account_id: u32,
) -> Result<()> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let stake_end = ctx
        .accounts
        .market
        .stake_end_timestamp
        .ok_or(ErrorCode::MarketNotOpen)?;
    let select_deadline = stake_end
        .checked_add(ctx.accounts.market.market_resolution_deadline_seconds)
        .ok_or(ErrorCode::Overflow)?;

    let resolved = ctx.accounts.market.resolved_at_timestamp.is_some();
    let expired = !resolved && current_time >= select_deadline;
    require!(resolved || expired, ErrorCode::MarketNotResolved);

    // Load option data if account is still open; a closed non-winning option has
    // owner == SystemProgram and empty data after Anchor zeroes it out.
    let option_closed =
        ctx.accounts.option.owner == &System::id() && ctx.accounts.option.data_is_empty();
    let option_acc: Option<Account<'info, OpportunityMarketOption>> = if !option_closed {
        Some(Account::<OpportunityMarketOption>::try_from(
            ctx.accounts.option.as_ref(),
        )?)
    } else {
        None
    };

    let payout: u64 = if resolved {
        // Reveal period must be over
        require!(
            ctx.accounts.market.reveal_ended,
            ErrorCode::MarketNotResolved,
        );

        let revealed_option = ctx
            .accounts
            .stake_account
            .revealed_option
            .ok_or(ErrorCode::NotRevealed)?;
        require!(revealed_option == option_id, ErrorCode::InvalidOptionId);

        compute_winning_payout(
            &ctx.accounts.stake_account,
            &ctx.accounts.market,
            option_acc.as_ref(),
        )?
    } else {
        // Market expired: refund reward_pool_fee + creator_fee
        let collected_fees = ctx.accounts.stake_account.collected_fees;
        ctx.accounts.market.deduct_stake_fees(&collected_fees)?
    };

    if payout > 0 {
        let platform = ctx.accounts.market.platform;
        let creator = ctx.accounts.market.creator;
        let index_bytes = ctx.accounts.market.index.to_le_bytes();
        let market_bump = ctx.accounts.market.bump;
        let market_seeds: &[&[&[u8]]] = &[&[
            OPPORTUNITY_MARKET_SEED,
            platform.as_ref(),
            creator.as_ref(),
            &index_bytes,
            &[market_bump],
        ]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.market_token_ata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                market_seeds,
            ),
            payout,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    let stake_account = &ctx.accounts.stake_account;
    let staked_at_timestamp = stake_account.staked_at_timestamp.unwrap_or(0);
    let stake_end_timestamp = stake_account.unstaked_at_timestamp.unwrap_or(stake_end);
    let score = stake_account.score.unwrap_or(0);

    // Decrement total_staked and write back; skipped if option was already closed.
    if let Some(mut opt) = option_acc {
        // Only decrement if stake reveal was finalized and `total_staked` was incremented
        if stake_account.score.is_some() {
            opt.total_staked = opt
                .total_staked
                .checked_sub(stake_account.amount)
                .ok_or(ErrorCode::Overflow)?;
        }
        opt.exit(ctx.program_id)?;
    }

    emit_ts!(StakeAccountClosedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        stake_account: stake_account.key(),
        stake_account_id: stake_account.id,
        option_id: option_id,
        stake_amount: stake_account.amount,
        reward_amount: if resolved { payout } else { 0 },
        staked_at_timestamp: staked_at_timestamp,
        stake_end_timestamp: stake_end_timestamp,
        score: score,
    });

    Ok(())
}

fn compute_winning_payout(
    stake_account: &Account<StakeAccount>,
    market: &Account<OpportunityMarket>,
    option: Option<&Account<OpportunityMarketOption>>,
) -> Result<u64> {
    let option = match option {
        None => return Ok(0),
        Some(o) => o,
    };

    if option.reward_bp == 0 {
        return Ok(0);
    }

    if stake_account.score.is_none() {
        return Ok(0);
    }

    let active_bp = market.winning_option_active_bp;
    require!(active_bp > 0, ErrorCode::NoFinalizedWinningOption);

    let user_score = stake_account.score.ok_or(ErrorCode::NotRevealed)?;
    let total_score = option.total_score;

    let reward = (user_score as u128)
        .checked_mul(market.reward_amount as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_mul(option.reward_bp as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(
            total_score
                .checked_mul(active_bp as u128)
                .ok_or(ErrorCode::Overflow)?,
        )
        .ok_or(ErrorCode::Overflow)? as u64;

    let fees = stake_account.collected_fees;
    let fees_refund = fees
        .reward_pool_fee
        .checked_add(fees.creator_fee)
        .ok_or(ErrorCode::Overflow)?;

    reward
        .checked_add(fees_refund)
        .ok_or(ErrorCode::Overflow.into())
}
