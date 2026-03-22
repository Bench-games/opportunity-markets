use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardWithdrawnEvent};
use crate::state::{CentralState, OpportunityMarket};

#[derive(Accounts)]
pub struct WithdrawReward<'info> {
    pub creator: Signer<'info>,

    #[account(
        mut,
        has_one = creator @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,

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

    /// Creator-specified destination for refunded reward tokens
    #[account(
        mut,
        token::mint = token_mint,
        token::token_program = token_program,
    )]
    pub refund_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [b"central_state"],
        bump = central_state.bump,
    )]
    pub central_state: Account<'info, CentralState>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw_reward(ctx: Context<WithdrawReward>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Cannot withdraw if winners already selected
    require!(market.selected_options.is_none(), ErrorCode::WinnerAlreadySelected);

    // Cannot withdraw twice
    require!(!market.reward_withdrawn, ErrorCode::RewardAlreadyWithdrawn);

    let limit = ctx.accounts.central_state.reward_withdraw_staked_limit;
    require!(
        market.total_staked_count <= limit as u64,
        ErrorCode::Unauthorized
    );

    // Market must be opened
    let open_timestamp = market.open_timestamp.ok_or(ErrorCode::MarketNotOpen)?;

    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    require!(current_timestamp >= open_timestamp, ErrorCode::InvalidTimestamp);

    // Check if closing early is allowed
    let stake_end_timestamp = open_timestamp + market.time_to_stake;
    if !market.allow_closing_early {
        require!(
            current_timestamp >= stake_end_timestamp,
            ErrorCode::ClosingEarlyNotAllowed
        );
    }

    // If staking is still open, close it by setting time_to_stake to end now
    if current_timestamp < stake_end_timestamp {
        market.time_to_stake = current_timestamp - open_timestamp;
    }

    let reward_amount = market.reward_amount;

    // Transfer reward tokens from market ATA to refund account
    if reward_amount > 0 {
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
                    to: ctx.accounts.refund_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            reward_amount,
            ctx.accounts.token_mint.decimals,
        )?;
    }

    market.reward_withdrawn = true;
    market.reward_amount = 0;

    emit_ts!(RewardWithdrawnEvent {
        market: market.key(),
        creator: ctx.accounts.creator.key(),
        reward_amount: reward_amount,
        refund_token_account: ctx.accounts.refund_token_account.key(),
    });

    Ok(())
}
