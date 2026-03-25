use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TokenVault {
    pub bump: u8,
    pub mint: Pubkey,
    pub collected_fees: u64,
    pub protocol_fee_bp: u16,

    /// Reserved for future use
    pub _reserved: [u8; 128],
}

#[account]
#[derive(InitSpace)]
pub struct CentralState {
    pub bump: u8,

    // Point at which `earliness` becomes negligible
    // TODO: move to market level config
    pub earliness_cutoff_seconds: u64,

    // Allowed to update
    pub authority: Pubkey,

    // Protocol fee in basis points (e.g. 100 = 1%)
    pub protocol_fee_bp: u16,

    // Receives claimed fees
    pub fee_recipient: Pubkey,

    pub minimum_initial_reveal_period: u64,

    /// Reserved for future use
    pub _reserved: [u8; 128],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct WinningOption {
    pub option_id: u64,
    pub reward_percentage: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarket {
    pub bump: u8,
    pub creator: Pubkey,      // part of PDA seed
    pub index: u64,           // part of PDA seed
    pub total_options: u64,

    // If set, means market is funded and ready to be opened for staking.
    // What actions are possible depends on current timestamp in relation to
    // `open_timestamp`, `time_to_stake` and `time_to_reveal`
    pub open_timestamp: Option<u64>,

    // Seconds from open_timestamp
    pub time_to_stake: u64,

    // Seconds from open_timestamp + time_to_stake
    pub time_to_reveal: u64,

    #[max_len(10)]
    pub selected_options: Option<Vec<WinningOption>>,

    // Reward to be shared with stakers (in SPL token base units)
    pub reward_amount: u64,

    pub market_authority: Pubkey,

    pub reveal_period_authority: Pubkey,

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
pub struct StakeAccount {
    pub encrypted_option: [u8; 32],          // encrypted option ciphertext
    pub state_nonce: u128,
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub user_pubkey: [u8; 32],               // x25519 pubkey for MPC decryption
    pub encrypted_option_disclosure: [u8; 32],
    pub state_nonce_disclosure: u128,
    pub staked_at_timestamp: Option<u64>,
    pub unstaked_at_timestamp: Option<u64>,
    pub amount: u64,                         // stake amount in market token mint base units
    pub fee: u64,                            // fee paid during stake(), for stuck refunds
    pub revealed_option: Option<u64>,
    pub score: Option<u64>,
    pub total_incremented: bool,
    pub unstakeable_at_timestamp: Option<u64>,
    pub locked: bool,
    pub stake_reclaimed: bool,               // whether staked tokens have been returned
    pub pending_stake: bool,                 // true while MPC stake computation is in flight
    pub pending_reveal: bool,                // true while MPC reveal computation is in flight
    pub id: u32,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketOption {
    pub bump: u8,
    pub id: u64,

    // Total tallies, collected in `increment_option_tally`
    pub total_staked: u64,
    pub total_score: u64,
}

#[account]
#[derive(InitSpace)]
pub struct OpportunityMarketSponsor {
    pub bump: u8,
    pub sponsor: Pubkey,
    pub market: Pubkey,
    pub reward_deposited: u64,
    pub reward_locked: bool,
}

