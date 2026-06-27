use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{OPPORTUNITY_MARKET_SEED, OPTION_SEED, VOUCH_ACCOUNT_SEED};
use crate::error::ErrorCode;
use crate::events::{emit_ts, RewardsClaimedEvent};
use crate::state::{MarketPhase, OpportunityMarket, OpportunityMarketOption, VouchAccount};
use crate::utils::transfer_from_market;

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [OPPORTUNITY_MARKET_SEED, market.platform.as_ref(), market.creator.as_ref(), &market.index.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, OpportunityMarket>>,

    #[account(
        mut,
        seeds = [VOUCH_ACCOUNT_SEED, owner.key().as_ref(), market.key().as_ref(), &vouch_account.id.to_le_bytes()],
        bump = vouch_account.bump,
        constraint = !vouch_account.rewards_claimed @ ErrorCode::RewardAlreadyClaimed,
        constraint = vouch_account.revealed_option.is_some() @ ErrorCode::InvalidOptionId,
        constraint = vouch_account.score.is_some() @ ErrorCode::NotRevealed,
    )]
    pub vouch_account: Box<Account<'info, VouchAccount>>,

    #[account(
        mut,
        seeds = [OPTION_SEED, market.key().as_ref(), &vouch_account.revealed_option.unwrap().to_le_bytes()],
        bump,
        constraint = option.reward_bp > 0 @ ErrorCode::NoRewardToClaim,
    )]
    pub option: Box<Account<'info, OpportunityMarketOption>>,

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
}

pub fn claim_rewards<'info>(ctx: Context<'info, ClaimRewards<'info>>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let vouch_account = &mut ctx.accounts.vouch_account;
    let now = Clock::get()?.unix_timestamp as u64;
    market.require_phase(now, MarketPhase::Settlement)?;

    let rewards = compute_reward_payout(
        vouch_account.as_ref(),
        market.as_ref(),
        ctx.accounts.option.as_ref(),
    )?;

    if rewards > 0 {
        transfer_from_market(
            &ctx.accounts.market,
            &ctx.accounts.token_mint,
            &ctx.accounts.market_token_ata,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.token_program,
            rewards,
        )?;
    }

    vouch_account.rewards_claimed = true;

    let gross_vouch_amount = vouch_account
        .amount
        .checked_add(vouch_account.collected_fees.total()?)
        .ok_or(ErrorCode::Overflow)?;

    ctx.accounts.option.unclaimed_gross_vouch = ctx
        .accounts
        .option
        .unclaimed_gross_vouch
        .checked_sub(gross_vouch_amount)
        .ok_or(ErrorCode::Overflow)?;

    emit_ts!(RewardsClaimedEvent {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        vouch_account: ctx.accounts.vouch_account.key(),
        vouch_account_id: ctx.accounts.vouch_account.id,
        option_id: ctx.accounts.vouch_account.revealed_option.unwrap(),
        reward_amount: rewards,
        score: ctx.accounts.vouch_account.score.unwrap_or(0),
    });

    Ok(())
}

fn compute_reward_payout(
    vouch_account: &VouchAccount,
    market: &OpportunityMarket,
    option: &OpportunityMarketOption,
) -> Result<u64> {
    if option.reward_bp == 0 || option.total_score == 0 {
        return Ok(0);
    }

    let active_bp = market.winning_option_active_bp;
    require!(active_bp > 0, ErrorCode::NoFinalizedWinningOption);

    let user_score = vouch_account.score.ok_or(ErrorCode::NotRevealed)?;
    let total_score = option.total_score;

    let score_weighted_reward = (user_score as u128)
        .checked_mul(market.reward_amount as u128)
        .ok_or(ErrorCode::Overflow)?;

    let pro_rata_pool_share = score_weighted_reward
        .checked_div(total_score)
        .ok_or(ErrorCode::Overflow)?;

    let reward: u64 = pro_rata_pool_share
        .checked_mul(option.reward_bp as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(active_bp as u128)
        .ok_or(ErrorCode::Overflow)?
        .try_into()
        .map_err(|_| ErrorCode::Overflow)?;

    Ok(reward)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CollectedFees;

    fn test_vouch_account(score: Option<u64>, fees: CollectedFees) -> VouchAccount {
        VouchAccount {
            encrypted_option: [0; 32],
            state_nonce: 0,
            bump: 0,
            owner: Pubkey::default(),
            rent_payer: Pubkey::default(),
            market: Pubkey::default(),
            user_pubkey: [0; 32],
            encrypted_option_disclosure: [0; 32],
            state_nonce_disclosure: 0,
            vouched_at_timestamp: None,
            vouch_withdrawn_at_timestamp: None,
            amount: 0,
            collected_fees: fees,
            revealed_option: Some(0),
            score,
            rewards_claimed: false,
            id: 0,
            pending_vouch_computation: None,
            pending_reveal_computation: None,
            last_reveal_vouch_at: 0,
        }
    }

    fn test_market(reward_amount: u64, active_bp: u16) -> OpportunityMarket {
        OpportunityMarket {
            bump: 0,
            creator: Pubkey::default(),
            index: 0,
            total_options: 0,
            platform: Pubkey::default(),
            vouching_window_end: None,
            resolved_at_timestamp: None,
            winning_option_allocation: 0,
            winning_option_active_bp: active_bp,
            reward_amount,
            market_authority: Pubkey::default(),
            mint: Pubkey::default(),
            earliness_cutoff_seconds: 0,
            earliness_multiplier: 0,
            authorized_reader_pubkey: [0; 32],
            fee_rates: crate::state::FeeRates {
                platform_fee_bp: 0,
                reward_pool_fee_bp: 0,
                creator_fee_bp: 0,
            },
            collected_platform_fees: 0,
            collected_creator_fees: 0,
            creator_fee_claimer: Pubkey::default(),
            market_resolution_deadline_seconds: 0,
            reveal_period_seconds: 0,
            reveal_ended: false,
            min_vouch_amount: 0,
        }
    }

    fn test_option(total_score: u128, reward_bp: u16) -> OpportunityMarketOption {
        OpportunityMarketOption {
            bump: 0,
            id: 0,
            creator: Pubkey::default(),
            created_at: 0,
            unclaimed_gross_vouch: 0,
            total_score,
            reward_bp,
            included_in_active_bp: false,
        }
    }

    #[test]
    fn zero_total_score_returns_zero_payout() {
        let fees = CollectedFees {
            platform_fee: 100,
            reward_pool_fee: 200,
            creator_fee: 300,
        };
        let vouch = test_vouch_account(Some(0), fees);
        let market = test_market(1_000_000_000, 10_000);
        let option = test_option(0, 10_000);

        let payout = compute_reward_payout(&vouch, &market, &option).unwrap();
        assert_eq!(payout, 0);
    }

    #[test]
    fn zero_total_score_succeeds_even_when_active_bp_is_zero() {
        let fees = CollectedFees {
            platform_fee: 0,
            reward_pool_fee: 50,
            creator_fee: 50,
        };
        let vouch = test_vouch_account(Some(0), fees);
        let market = test_market(1_000_000_000, 0);
        let option = test_option(0, 5_000);

        assert!(compute_reward_payout(&vouch, &market, &option).is_ok());
    }

    #[test]
    fn high_supply_sole_winner_does_not_overflow() {
        let score = 200_000_000_000_000_000;
        let reward_amount = 200_000_000_000_000_000;
        let vouch = test_vouch_account(
            Some(score),
            CollectedFees {
                platform_fee: 0,
                reward_pool_fee: 0,
                creator_fee: 0,
            },
        );
        let market = test_market(reward_amount, 10_000);
        let option = test_option(score as u128, 10_000);

        let payout = compute_reward_payout(&vouch, &market, &option).unwrap();
        assert_eq!(payout, reward_amount);
    }

    #[test]
    fn non_zero_total_score_does_not_pay_rewards_plus_fees() {
        let fees = CollectedFees {
            platform_fee: 0,
            reward_pool_fee: 10,
            creator_fee: 20,
        };
        let vouch = test_vouch_account(Some(500), fees);
        let market = test_market(1_000_000, 10_000);
        let option = test_option(1_000, 10_000);

        let payout = compute_reward_payout(&vouch, &market, &option).unwrap();
        assert_eq!(payout, 500_000);
    }
}
