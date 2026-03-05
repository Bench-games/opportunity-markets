use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardClaimedEvent};
use crate::instructions::stake::SHARE_ACCOUNT_SEED;
use crate::state::{OpportunityMarket, OpportunityMarketOption, ShareAccount};

#[derive(Accounts)]
#[instruction(option_index: u16, share_account_id: u32)]
pub struct CloseShareAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, OpportunityMarket>,

    #[account(
        mut,
        seeds = [SHARE_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &share_account_id.to_le_bytes()],
        bump = share_account.bump,
        close = owner,
    )]
    pub share_account: Account<'info, ShareAccount>,

    #[account(
        seeds = [b"option", market.key().as_ref(), &option_index.to_le_bytes()],
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

pub fn close_share_account(ctx: Context<CloseShareAccount>, option_index: u16, _share_account_id: u32) -> Result<()> {
    let share_account = &ctx.accounts.share_account;
    let market = &ctx.accounts.market;
    let option = &ctx.accounts.option;

    // Check that shares have been revealed
    let revealed_option = share_account.revealed_option.ok_or(ErrorCode::NotRevealed)?;
    if share_account.revealed_amount.is_none() {
        return Err(ErrorCode::NotRevealed.into());
    }

    // Check that the option_index matches the user's revealed option
    require!(
        revealed_option == option_index,
        ErrorCode::InvalidOptionIndex
    );

    // Check that reveal period is over
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    if let Some(open_timestamp) = market.open_timestamp {
        let reveal_end = open_timestamp
            .checked_add(market.time_to_stake)
            .and_then(|t| t.checked_add(market.time_to_reveal))
            .ok_or(ErrorCode::Overflow)?;

        if current_time < reveal_end {
            return Err(ErrorCode::MarketNotResolved.into());
        }
    } else {
        // Market hasn't been opened yet
        return Err(ErrorCode::MarketNotOpen.into());
    }

    // Check if this share was bought for a winning option and user incremented the tally
    // If so, transfer proportional yield from market to user
    let mut user_reward: u64 = 0;
    if let Some(winning) = market.selected_options.as_ref().and_then(|opts| opts.iter().find(|w| w.option_index == revealed_option)) {
        if share_account.total_incremented {
            // User is eligible for yield
            let user_score = share_account.revealed_score.ok_or(ErrorCode::NotRevealed)?;
            let total_score = option.total_score.ok_or(ErrorCode::NotRevealed)?;

            // Calculate proportional reward: (user_score * reward_amount * percentage) / (total_score * 100)
            // Use u128 to prevent overflow during multiplication
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
                .ok_or(ErrorCode::Overflow)? as u64; // Round down

            // Transfer SPL tokens from market ATA to owner's token account
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
        }
    }

    emit_ts!(RewardClaimedEvent {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        share_account: ctx.accounts.share_account.key(),
        option: option_index,
        reward_amount: user_reward,
    });

    // Account will be closed automatically via the close constraint
    Ok(())
}
