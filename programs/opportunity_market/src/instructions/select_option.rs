use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::{emit_ts, OptionSelectedEvent};
use crate::state::{OpportunityMarket, WinningOption};

#[derive(Accounts)]
pub struct SelectOption<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = market.creator == authority.key()
            || market.market_authority == Some(authority.key()) @ ErrorCode::Unauthorized,
    )]
    pub market: Account<'info, OpportunityMarket>,
}

pub fn select_option(ctx: Context<SelectOption>, selections: Vec<WinningOption>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Validate selection count
    require!(!selections.is_empty() && selections.len() <= 10, ErrorCode::InvalidWinningOptionsInput);

    // Validate each selection
    let mut percentage_sum: u16 = 0;
    for (i, sel) in selections.iter().enumerate() {
        // Each option index must be valid
        require!(
            sel.option_index >= 1 && sel.option_index <= market.total_options,
            ErrorCode::InvalidOptionIndex
        );
        // Percentage must be > 0
        require!(sel.reward_percentage > 0, ErrorCode::InvalidWinningOptionsInput);
        percentage_sum += sel.reward_percentage as u16;

        // Check for duplicates
        for other in &selections[..i] {
            require!(
                sel.option_index != other.option_index,
                ErrorCode::InvalidWinningOptionsInput
            );
        }
    }

    // Percentages must sum to 100
    require!(percentage_sum == 100, ErrorCode::InvalidWinningOptionsInput);

    // Enforce market is open
    let open_timestamp = market.open_timestamp.ok_or_else(|| ErrorCode::MarketNotOpen)?;
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    require!(
        current_timestamp >= open_timestamp,
        ErrorCode::InvalidTimestamp
    );

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
        market.time_to_stake = (current_timestamp - open_timestamp).saturating_sub(1);
    }

    // Save the selected options
    market.selected_options = Some(selections.clone());

    emit_ts!(OptionSelectedEvent {
        market: market.key(),
        authority: ctx.accounts.authority.key(),
        selected_options: selections,
    });

    Ok(())
}
