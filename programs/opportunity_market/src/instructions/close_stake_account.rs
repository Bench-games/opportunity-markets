use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardClaimedEvent};
use crate::instructions::stake::STAKE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, OpportunityMarketOption, StakeAccount};

#[derive(Accounts)]
#[instruction(option_id: u64, stake_account_id: u32)]
pub struct CloseStakeAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &stake_account_id.to_le_bytes()],
        bump = stake_account.bump,
        close = owner,
        // Staked tokens must have been returned before closing
        constraint = stake_account.stake_reclaimed
            || stake_account.unstaked_at_timestamp.is_some()
            @ ErrorCode::InvalidAccountState,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        seeds = [b"option", market.key().as_ref(), &option_id.to_le_bytes()],
        bump = option.bump,
    )]
    pub option: Account<'info, OpportunityMarketOption>,

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

    /// Owner's token account to receive rewards
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn close_stake_account(ctx: Context<CloseStakeAccount>, option_id: u64, _stake_account_id: u32) -> Result<()> {
    let stake_account = &ctx.accounts.stake_account;
    let market = &ctx.accounts.market;
    let option = &ctx.accounts.option;

    // Market must be resolved: either winners selected or reward withdrawn
    require!(
        market.selected_options.is_some() || market.reward_withdrawn,
        ErrorCode::MarketNotResolved
    );

    // Check that reveal period is over
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    let open_timestamp = market.open_timestamp.ok_or(ErrorCode::MarketNotOpen)?;
    let reveal_end = open_timestamp
        .checked_add(market.time_to_stake)
        .and_then(|t| t.checked_add(market.time_to_reveal))
        .ok_or(ErrorCode::Overflow)?;

    require!(current_time >= reveal_end, ErrorCode::MarketNotResolved);

    if market.reward_withdrawn {
        // Reward was withdrawn — no reveal required, no reward to distribute.
        emit_ts!(RewardClaimedEvent {
            owner: ctx.accounts.owner.key(),
            market: market.key(),
            stake_account: ctx.accounts.stake_account.key(),
            option_id: option_id,
            stake_amount: stake_account.amount,
            reward_amount: 0u64,
            staked_at_timestamp: stake_account.staked_at_timestamp.unwrap_or(0),
            unstaked_at_timestamp: stake_account.unstaked_at_timestamp.unwrap_or(0),
            score: 0u64,
        });

        return Ok(());
    }

    // Normal path: winners were selected, stakes must be revealed
    let revealed_option = stake_account.revealed_option.ok_or(ErrorCode::NotRevealed)?;

    // Check that the option_id matches the user's revealed option
    require!(
        revealed_option == option_id,
        ErrorCode::InvalidOptionId
    );

    // Check if this stake was for a winning option and user incremented the tally
    // If so, calculate reward
    let mut user_reward: u64 = 0;
    if let Some(winning) = market.selected_options.as_ref().and_then(|opts| opts.iter().find(|w| w.option_id == revealed_option)) {
        if stake_account.total_incremented {
            let user_score = stake_account.score.ok_or(ErrorCode::NotRevealed)?;
            let total_score = option.total_score;

            let reward_amount = market.reward_amount as u128;
            let percentage = winning.reward_percentage as u128;
            user_reward = (user_score as u128)
                .checked_mul(reward_amount)
                .ok_or(ErrorCode::Overflow)?
                .checked_mul(percentage)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(
                    (total_score as u128)
                        .checked_mul(100)
                        .ok_or(ErrorCode::Overflow)?
                )
                .ok_or(ErrorCode::Overflow)? as u64;
        }
    }

    // If user has a reward, transfer
    if user_reward > 0 {
        let creator_key = market.creator;
        let index_bytes = market.index.to_le_bytes();
        let bump = market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"opportunity_market",
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
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            user_reward,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    let staked_at_timestamp = stake_account.staked_at_timestamp.ok_or(ErrorCode::NotRevealed)?;
    let unstaked_at_timestamp = stake_account.unstaked_at_timestamp.unwrap_or(
        open_timestamp
            .checked_add(market.time_to_stake)
            .ok_or(ErrorCode::Overflow)?
    );
    let score = stake_account.score.unwrap_or(0);
    emit_ts!(RewardClaimedEvent {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        stake_account: stake_account.key(),
        option_id: option_id,
        stake_amount: stake_account.amount,
        reward_amount: user_reward,
        staked_at_timestamp: staked_at_timestamp,
        unstaked_at_timestamp: unstaked_at_timestamp,
        score: score,
    });

    Ok(())
}
