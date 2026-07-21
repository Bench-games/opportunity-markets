import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { Command } from "commander";
import { type Instruction } from "@solana/kit";
import {
  ProgramContext,
  createCipher,
  generateX25519Keypair,
  getVouchAccountAddress,
  initVouchAccount,
  randomComputationOffset,
} from "../../../js/src/index.js";
import { ARCIUM_MAINNET_CLUSTER_OFFSET } from "../defaults.js";
import { selectMarket } from "../discovery.js";
import { getMxePublicKeyHex } from "../arcium.js";
import { getContext } from "./common.js";
import {
  confirmTransaction,
  promptBigInt,
  promptNumber,
  promptOptionalString,
} from "../prompts.js";
import {
  printHeader,
  printSummary,
  printTxResult,
  shortAddress,
} from "../render.js";
import {
  createAtaIfMissingInstruction,
  getAta,
  TOKEN_PROGRAM_ADDRESS,
} from "../spl.js";
import { sendInstructions } from "../tx.js";

interface X25519KeypairJson {
  secretKey: number[];
  publicKey: number[];
}

function deserializeLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[index]!);
  }
  return result;
}

function loadX25519Keypair(filePath: string): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const parsed = JSON.parse(
    fs.readFileSync(filePath, "utf8")
  ) as X25519KeypairJson;
  if (!Array.isArray(parsed.secretKey) || !Array.isArray(parsed.publicKey)) {
    throw new Error(
      `X25519 keypair file must contain secretKey and publicKey arrays: ${filePath}`
    );
  }
  const secretKey = new Uint8Array(parsed.secretKey);
  const publicKey = new Uint8Array(parsed.publicKey);
  if (secretKey.length !== 32 || publicKey.length !== 32) {
    throw new Error("X25519 secretKey and publicKey must both be 32 bytes");
  }
  return { secretKey, publicKey };
}

export function registerVouchCommands(program: Command): void {
  program
    .command("vouch")
    .description("Initialize a vouch account and vouch on a selected option")
    .option("--amount <amount>")
    .option("--option-id <id>")
    .option("--x25519-keypair <path>")
    .option(
      "--cluster-offset <offset>",
      "Arcium cluster offset (mainnet: 10000; devnet: 456)",
      String(ARCIUM_MAINNET_CLUSTER_OFFSET)
    )
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const market = await selectMarket(ctx);
      const amount = options.amount
        ? BigInt(options.amount)
        : await promptBigInt("Vouch amount", market.data.minVouchAmount);
      const optionId = options.optionId
        ? Number(options.optionId)
        : await promptNumber("Option ID", 0);
      const keypairPath =
        options.x25519Keypair ??
        (await promptOptionalString(
          "X25519 keypair path (blank to generate ephemeral)"
        ));
      const x25519Keypair = keypairPath
        ? loadX25519Keypair(keypairPath)
        : generateX25519Keypair();
      const mxePublicKey = new Uint8Array(
        Buffer.from(await getMxePublicKeyHex(ctx), "hex")
      );

      const signerTokenAccount = await getAta(
        market.data.mint,
        ctx.payer.address
      );
      const createAtaIx = await createAtaIfMissingInstruction(
        ctx,
        market.data.mint,
        ctx.payer.address
      );
      const vouchAccountId = Math.floor(Math.random() * 1_000_000_000) + 1;
      const [vouchAccount] = await getVouchAccountAddress(
        ctx.payer.address,
        market.address,
        vouchAccountId,
        ctx.programId
      );

      printHeader("Vouch");
      printSummary({
        Market: market.address,
        Mint: market.data.mint,
        "Signer ATA": signerTokenAccount,
        Amount: amount,
        "Option ID": optionId,
        "Vouch account ID": vouchAccountId,
        "Vouch account": vouchAccount,
        "X25519 keypair": keypairPath ?? "ephemeral",
      });
      await confirmTransaction(ctx.yes);

      const initIx = await initVouchAccount({
        programAddress: ctx.programId,
        payer: ctx.payer,
        owner: ctx.payer.address,
        market: market.address,
        vouchAccountId,
      });
      const firstInstructions: Instruction[] = createAtaIx
        ? [createAtaIx, initIx as Instruction]
        : [initIx as Instruction];
      const initSig = await sendInstructions(
        ctx,
        firstInstructions,
        "init vouch account"
      );
      printTxResult(initSig);

      const cipher = createCipher(x25519Keypair.secretKey, mxePublicKey);
      const inputNonce = randomBytes(16);
      const selectedOptionCiphertext = cipher.encrypt(
        [BigInt(optionId)],
        inputNonce
      )[0];
      const computationOffset = randomComputationOffset();
      const programContext = new ProgramContext(
        Number(options.clusterOffset),
        ctx.programId
      );

      const vouchIx = await programContext.vouch(
        {
          signer: ctx.payer,
          payer: ctx.payer,
          market: market.address,
          vouchAccount,
          vouchAccountId,
          tokenMint: market.data.mint,
          signerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          amount,
          selectedOptionCiphertext,
          inputNonce: deserializeLE(inputNonce),
          authorizedReaderNonce: deserializeLE(randomBytes(16)),
          userPubkey: x25519Keypair.publicKey,
          stateNonce: deserializeLE(randomBytes(16)),
        },
        computationOffset
      );
      const vouchSig = await sendInstructions(
        ctx,
        [vouchIx as Instruction],
        "vouch"
      );
      printTxResult(vouchSig);
      console.log(`Vouch account ID: ${vouchAccountId}`);
    });
}
