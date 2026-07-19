import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
  type Commitment,
  type KeyPairSigner,
} from "@solana/kit";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "../../js/src/generated/index.js";
import { checkPayerBalance } from "./balance.js";

export interface CliOptions {
  yes?: boolean;
  keypair?: string;
  commitment?: Commitment;
}

export interface BaseCliContext {
  rpcUrl: string;
  rpc: ReturnType<typeof createSolanaRpc>;
  programId: Address;
  commitment: Commitment;
  yes: boolean;
}

export interface CliContext extends BaseCliContext {
  payer: KeyPairSigner;
  keypairPath: string;
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function readSecretKey(keypairPath: string): Uint8Array {
  const file = fs.readFileSync(expandHome(keypairPath), "utf8");
  const parsed = JSON.parse(file) as number[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Keypair file must contain a JSON number array: ${keypairPath}`);
  }
  return new Uint8Array(parsed);
}

export function createReadContext(options: CliOptions): BaseCliContext {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL env var is required");

  const programId = address(process.env.PROGRAM_ID ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS);

  return {
    rpcUrl,
    rpc: createSolanaRpc(rpcUrl),
    programId,
    commitment: options.commitment ?? "confirmed",
    yes: Boolean(options.yes),
  };
}

export async function createContext(options: CliOptions): Promise<CliContext> {
  const readContext = createReadContext(options);
  const keypairPath =
    options.keypair ??
    process.env.KEYPAIR_PATH ??
    `${os.homedir()}/.config/solana/id.json`;
  const secretKey = readSecretKey(keypairPath);
  const payer = await createKeyPairSignerFromBytes(secretKey);

  const ctx = {
    ...readContext,
    payer,
    keypairPath,
  };
  await checkPayerBalance(ctx);
  return ctx;
}
