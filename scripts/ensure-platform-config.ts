import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Rpc,
  type SolanaRpcApi,
  type Signature,
} from "@solana/kit";
import {
  createPlatformConfig,
  updatePlatformConfig,
  fetchMaybePlatformConfig,
  getPlatformConfigAddress,
} from "../js/src";
import config from "./platformConfig.json";
import * as fs from "fs";
import * as os from "os";

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

function readSecretKey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  return new Uint8Array(JSON.parse(file.toString()));
}

async function sendAndConfirmTx(
  rpc: Rpc<SolanaRpcApi>,
  signedTx: Parameters<typeof getBase64EncodedWireTransaction>[0]
): Promise<Signature> {
  const encodedTx = getBase64EncodedWireTransaction(signedTx);
  const signature = getSignatureFromTransaction(signedTx);
  await rpc.sendTransaction(encodedTx, { encoding: "base64" }).send();

  const start = Date.now();
  const timeout = 60_000;
  while (Date.now() - start < timeout) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      return signature;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${signature} not confirmed within ${timeout / 1000}s`);
}

async function main() {
  const keypairPath = process.env.DEPLOYER_KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
  const secretKey = readSecretKey(keypairPath);
  const payer = await createKeyPairSignerFromBytes(secretKey);
  const rpc = createSolanaRpc(RPC_URL);

  const feeClaimAuthority = config.feeClaimAuthority ? address(config.feeClaimAuthority) : payer.address;

  const minTimeToStakeSeconds = BigInt(config.minTimeToStakeSeconds);
  const revealPeriodSeconds = BigInt(config.revealPeriodSeconds);
  const marketResolutionDeadlineSeconds = BigInt(config.marketResolutionDeadlineSeconds);
  const revealAuthority = config.revealAuthority
    ? address(config.revealAuthority)
    : payer.address;

  const [platformConfigAddress] = await getPlatformConfigAddress(
    payer.address,
    config.name,
    PROGRAM_ID,
  );
  const existing = await fetchMaybePlatformConfig(rpc, platformConfigAddress);
  const mode = existing.exists ? "update" : "create";

  console.log(`Program:                    ${PROGRAM_ID}`);
  console.log(`Payer:                      ${payer.address}`);
  console.log(`Name:                       ${config.name}`);
  console.log(`Platform config address:    ${platformConfigAddress}`);
  console.log(`Mode:                       ${mode}`);
  console.log(`Platform fee:               ${config.platformFeeBp} bp`);
  console.log(`Reward-pool fee:            ${config.rewardPoolFeeBp} bp`);
  console.log(`Creator fee:                ${config.creatorFeeBp} bp`);
  console.log(`Fee claim authority:        ${feeClaimAuthority}`);
  console.log(`Min time to stake (s):      ${minTimeToStakeSeconds}`);
  console.log(`Reveal period (s):          ${revealPeriodSeconds}`);
  console.log(`Reveal authority:           ${revealAuthority}`);
  console.log(`Resolution deadline (s):    ${marketResolutionDeadlineSeconds}`);

  const ix = existing.exists
    ? await updatePlatformConfig(rpc, {
        programAddress: PROGRAM_ID,
        signer: payer,
        name: config.name,
        platformFeeBp: config.platformFeeBp,
        rewardPoolFeeBp: config.rewardPoolFeeBp,
        creatorFeeBp: config.creatorFeeBp,
        minTimeToStakeSeconds,
        revealAuthority,
        revealPeriodSeconds,
        marketResolutionDeadlineSeconds,
      })
    : await createPlatformConfig(rpc, {
        programAddress: PROGRAM_ID,
        signer: payer,
        name: config.name,
        platformFeeBp: config.platformFeeBp,
        rewardPoolFeeBp: config.rewardPoolFeeBp,
        creatorFeeBp: config.creatorFeeBp,
        feeClaimAuthority,
        revealAuthority,
        minTimeToStakeSeconds,
        revealPeriodSeconds,
        marketResolutionDeadlineSeconds,
      });

  console.log("\nSending transaction...");

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

  const signedTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions([ix], msg)
    )
  );

  const sig = await sendAndConfirmTx(rpc, signedTx);
  console.log(`Done (${mode}). Signature: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
