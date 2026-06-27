import {
  getCompDefAccOffset,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getCompDefAccAddress,
  getClusterAccAddress,
} from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";

const ARCIUM_CLUSTER_OFFSET = 456;
const PROGRAM_ID = new PublicKey("bnchXx34qGANGyEL6MxTYdG8iXmUmSPyQFAGhxj1VKn");

const COMP_DEF_OFFSETS = {
  INIT_VOTE_TOKEN_ACCOUNT: "init_vote_token_account",
  BUY_VOTE_TOKENS: "buy_vote_tokens",
  CLAIM_VOTE_TOKENS: "claim_vote_tokens",
  BUY_OPPORTUNITY_MARKET_SHARES: "buy_opportunity_market_shares",
  INIT_MARKET_SHARES: "init_market_shares",
  REVEAL_VOUCH: "reveal_vouch",
} as const;

console.log("Computing Arcium addresses...\n");

// Cluster address
const clusterAddress = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET);
console.log("CLUSTER_ADDRESS:", clusterAddress.toBase58());

// MXE address
const mxeAddress = getMXEAccAddress(PROGRAM_ID);
console.log("MXE_ADDRESS:", mxeAddress.toBase58());

// Mempool address
const mempoolAddress = getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET);
console.log("MEMPOOL_ADDRESS:", mempoolAddress.toBase58());

// Executing pool address
const executingPoolAddress = getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET);
console.log("EXECUTING_POOL_ADDRESS:", executingPoolAddress.toBase58());

// Sample computation address (with offset 0 as example)
const sampleComputationAddress = getComputationAccAddress(
  ARCIUM_CLUSTER_OFFSET,
  new BN(0)
);
console.log(
  "COMPUTATION_ADDRESS_BASE (offset 0):",
  sampleComputationAddress.toBase58()
);

console.log("\nComputation Definition Offsets:");

// Comp def offsets
for (const [key, value] of Object.entries(COMP_DEF_OFFSETS)) {
  const offset = getCompDefAccOffset(value);
  const numericOffset = Buffer.from(offset).readUInt32LE();
  const compDefAddress = getCompDefAccAddress(PROGRAM_ID, numericOffset);
  console.log(`${key}:`);
  console.log(`  - raw offset: ${JSON.stringify(Array.from(offset))}`);
  console.log(`  - numeric: ${numericOffset}`);
  console.log(`  - address: ${compDefAddress.toBase58()}`);
}

console.log("\n=== Copy these values to arcium.ts ===\n");

console.log(`export const ARCIUM_CLUSTER_OFFSET = ${ARCIUM_CLUSTER_OFFSET};`);
console.log(
  `export const CLUSTER_ADDRESS = new PublicKey("${clusterAddress.toBase58()}");`
);
console.log(
  `export const MXE_ADDRESS = new PublicKey("${mxeAddress.toBase58()}");`
);
console.log(
  `export const MEMPOOL_ADDRESS = new PublicKey("${mempoolAddress.toBase58()}");`
);
console.log(
  `export const EXECUTING_POOL_ADDRESS = new PublicKey("${executingPoolAddress.toBase58()}");`
);

console.log("\nexport const COMP_DEF_ADDRESSES = {");
for (const [key, value] of Object.entries(COMP_DEF_OFFSETS)) {
  const offset = getCompDefAccOffset(value);
  const numericOffset = Buffer.from(offset).readUInt32LE();
  const compDefAddress = getCompDefAccAddress(PROGRAM_ID, numericOffset);
  console.log(`  ${key}: new PublicKey("${compDefAddress.toBase58()}"),`);
}
console.log("} as const;");
