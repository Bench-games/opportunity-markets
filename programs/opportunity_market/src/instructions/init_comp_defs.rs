use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
#[cfg(feature = "production-settings")]
use arcium_client::idl::arcium::types::{CircuitSource, OffChainCircuitSource};
#[cfg(feature = "production-settings")]
use arcium_macros::circuit_hash;

use crate::ID;

#[init_computation_definition_accounts("stake", payer)]
#[derive(Accounts)]
pub struct StakeCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    /// CHECK: address_lookup_table, checked by arcium program.
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program is the Address Lookup Table program.
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn stake_comp_def(ctx: Context<StakeCompDef>) -> Result<()> {
    #[cfg(feature = "production-settings")]
    {
        init_computation_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://blobs.bench.markets/stake.arcis"
                    .to_string(),
                hash: circuit_hash!("stake"),
            })),
        )?;
    }
    #[cfg(not(feature = "production-settings"))]
    {
        init_computation_def(ctx.accounts, None)?;
    }
    Ok(())
}

#[init_computation_definition_accounts("reveal_stake", payer)]
#[derive(Accounts)]
pub struct RevealStakeCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    /// CHECK: address_lookup_table, checked by arcium program.
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program is the Address Lookup Table program.
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn reveal_stake_comp_def(ctx: Context<RevealStakeCompDef>) -> Result<()> {
    #[cfg(feature = "production-settings")]
    {
        init_computation_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://blobs.bench.markets/reveal_stake.arcis"
                    .to_string(),
                hash: circuit_hash!("reveal_stake"),
            })),
        )?;
    }
    #[cfg(not(feature = "production-settings"))]
    {
        init_computation_def(ctx.accounts, None)?;
    }
    Ok(())
}
