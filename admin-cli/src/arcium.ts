import { getMxeAccount, getCompDefAccount, ALL_COMP_DEF_CIRCUITS } from "../../js/src/index.js";
import { getComputeAccounts } from "../../js/src/arcium/computeAccounts.js";
import type { CliContext } from "./context.js";

export async function getMxePublicKeyHex(ctx: CliContext): Promise<string> {
  const mxe = await getMxeAccount(ctx.rpc as never, ctx.programId);
  if (mxe.data.utilityPubkeys.__kind !== "Set") {
    throw new Error("MXE public key not found; utility pubkeys are unset");
  }
  const [utilityPubkeys] = mxe.data.utilityPubkeys.fields;
  return Buffer.from(utilityPubkeys.x25519Pubkey).toString("hex");
}

export function getVouchComputeAddresses(ctx: CliContext, clusterOffset: number, computationOffset = 0n) {
  return getComputeAccounts("vouch", {
    clusterOffset,
    computationOffset,
    programId: ctx.programId,
  });
}

export { ALL_COMP_DEF_CIRCUITS, getCompDefAccount };
