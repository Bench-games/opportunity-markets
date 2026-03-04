use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TokenVault {
    pub bump: u8,
    pub fund_manager: Pubkey,
    pub mint: Pubkey,
    pub collected_fees: u64,
    pub protocol_fee_bp: u16,
}

#[account]
#[derive(InitSpace)]
pub struct CentralState {
    pub bump: u8,

    // Point at which `earliness` becomes negligible
    pub earliness_cutoff_seconds: u64,

    // Allowed to update
    pub authority: Pubkey,

    // Minimum deposit required when creating a market option
    pub min_option_deposit: u64,

    // Protocol fee in basis points (e.g. 100 = 1%)
    pub protocol_fee_bp: u16,

    // Receives claimed fees
    pub fee_recipient: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarket {
    pub bump: u8,
    pub creator: Pubkey,      // part of PDA seed
    pub index: u64,           // part of PDA seed
    pub total_options: u16,

    // If set, means market is funded and ready to be opened for staking.
    // What actions are possible depends on current timestamp in relation to
    // `open_timestamp`, `time_to_stake` and `time_to_reveal`
    pub open_timestamp: Option<u64>,

    // Seconds from open_timestamp
    pub time_to_stake: u64,

    // Seconds from open_timestamp + time_to_stake
    pub time_to_reveal: u64,

    pub selected_option: Option<u16>,

    // Reward to be shared with stakers (in SPL token base units)
    pub reward_amount: u64,

    // Optional authority that can manage the market (select winning option, extend reveal period)
    pub market_authority: Option<Pubkey>,

    // SPL token mint for this market (vote tokens and rewards)
    pub mint: Pubkey,

    // Score component configuration
    pub earliness_cutoff_seconds: u64,

    // Unstake delay seconds
    pub unstake_delay_seconds: u64,

    // Public key for voluntary disclosure of encrypted stake data
    pub authorized_reader_pubkey: [u8; 32],

    // If false, market can only be closed after stake period ends
    pub allow_closing_early: bool,
}

#[account]
#[derive(InitSpace)]
pub struct EncryptedTokenAccount {
    pub encrypted_state: [[u8; 32]; 1],  // encrypted token amount
    pub bump: u8,
    pub index: u64,  // PDA seed index (0 for regular ETAs, arbitrary for ephemeral ETAs)
    pub owner: Pubkey,
    pub state_nonce: u128,
    pub token_mint: Pubkey,
    pub user_pubkey: [u8; 32],

    // Locked while waiting for Arcium MPC callback
    pub locked: bool,

    // Tracks unconfirmed deposits for safety
    pub pending_deposit: u64,

    // Who paid rent for this account (None for regular ETAs, Some for ephemeral ETAs)
    pub rent_payer: Option<Pubkey>,

    // Whether this ETA has been initialized with encrypted state via a callback
    pub is_initialized: bool,
}

#[account]
#[derive(InitSpace)]
pub struct ShareAccount {
    pub encrypted_state: [[u8; 32]; 2],  // stake amount and option
    pub state_nonce: u128,
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,

    pub encrypted_state_disclosure: [[u8; 32];2],
    pub state_nonce_disclosure: u128,
    pub staked_at_timestamp: Option<u64>,
    pub unstaked_at_timestamp: Option<u64>,

    pub revealed_amount: Option<u64>,
    pub revealed_option: Option<u16>,

    // Amount that scales by time-in-market.
    pub revealed_score: Option<u64>,

    pub total_incremented: bool,

    pub unstakeable_at_timestamp: Option<u64>,

    // Locked while waiting for Arcium MPC callback
    pub locked: bool,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketOption {
    pub bump: u8,
    pub creator: Pubkey,
    pub index: u16,

    /// Name of the option
    #[max_len(50)]
    pub name: String,

    /// Total shares bought for this option (tally)
    pub total_shares: Option<u64>,

    // Scales by time-in-market
    pub total_score: Option<u64>,

    // Whether this option has been fully initialized (set true in MPC callback)
    pub initialized: bool,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketShare {
    // [share_amount, selected_option]
    pub encrypted_state: [[u8; 32]; 2],
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub state_nonce: u128,
}
