use anchor_lang::prelude::*;
use arcium_anchor::prelude::ComputationDefinitionAccount;
use arcium_client::idl::arcium::types::{CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;

use crate::constants::{REVEAL_STAKE_CIRCUIT_URL, STAKE_CIRCUIT_URL};
use crate::error::ErrorCode;

pub fn require_stake_comp_def_hash(comp_def: &ComputationDefinitionAccount) -> Result<()> {
    require_off_chain_circuit(comp_def, STAKE_CIRCUIT_URL, circuit_hash!("stake"))
}

pub fn require_reveal_stake_comp_def_hash(comp_def: &ComputationDefinitionAccount) -> Result<()> {
    require_off_chain_circuit(
        comp_def,
        REVEAL_STAKE_CIRCUIT_URL,
        circuit_hash!("reveal_stake"),
    )
}

fn require_off_chain_circuit(
    comp_def: &ComputationDefinitionAccount,
    expected_source: &str,
    expected_hash: [u8; 32],
) -> Result<()> {
    match &comp_def.circuit_source {
        CircuitSource::OffChain(OffChainCircuitSource { source, hash }) => {
            require!(source == expected_source, ErrorCode::InvalidParameters);
            require!(*hash == expected_hash, ErrorCode::InvalidParameters);
        }
        _ => err!(ErrorCode::InvalidParameters)?,
    }
    Ok(())
}
