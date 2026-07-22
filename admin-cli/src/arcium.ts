import {
  getMxeAccount,
  getCompDefAccount,
  ALL_COMP_DEF_CIRCUITS,
} from "../../js/src/index.js";
import type { BaseCliContext } from "./context.js";

export async function getMxePublicKeyHex(ctx: BaseCliContext): Promise<string> {
  const mxe = await getMxeAccount(ctx.rpc as never, ctx.programId);
  const [utilityPubkeys] = mxe.data.utilityPubkeys.fields;
  return Buffer.from(utilityPubkeys.x25519Pubkey).toString("hex");
}

export function getVouchComputeAddresses(
  ctx: BaseCliContext,
  computationOffset = 0n
) {
  return ctx.programContext.getComputeAccounts("vouch", computationOffset);
}

export { ALL_COMP_DEF_CIRCUITS, getCompDefAccount };
