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
import {
  OPPORTUNITY_MARKET_PROGRAM_ADDRESS,
  ProgramContext,
} from "../../js/src/index.js";
import { checkPayerBalance } from "./balance.js";

export type ProgramContextName = "devnet" | "mainnet" | "mainnet10k";

export interface CliOptions {
  yes?: boolean;
  keypair?: string;
  commitment?: Commitment;
}

export interface BaseCliContext {
  rpcUrl: string;
  rpc: ReturnType<typeof createSolanaRpc>;
  programId: Address;
  programContextName: ProgramContextName;
  programContext: ProgramContext;
  commitment: Commitment;
  yes: boolean;
}

export interface CliContext extends BaseCliContext {
  payer: KeyPairSigner;
  keypairPath: string;
}

function expandHome(value: string): string {
  return value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function readSecretKey(keypairPath: string): Uint8Array {
  const file = fs.readFileSync(expandHome(keypairPath), "utf8");
  const parsed = JSON.parse(file) as number[];
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Keypair file must contain a JSON number array: ${keypairPath}`
    );
  }
  return new Uint8Array(parsed);
}

export function createProgramContext(
  value: string | undefined,
  programId: Address
): { name: ProgramContextName; context: ProgramContext } {
  const name = getProgramContextName(value);

  switch (name) {
    case "devnet":
      return { name, context: ProgramContext.devnet(programId) };
    case "mainnet":
      return { name, context: ProgramContext.mainnet(programId) };
    case "mainnet10k":
      return { name, context: ProgramContext.mainnet10k(programId) };
  }
}

export function getProgramContextName(
  value: string | undefined
): ProgramContextName {
  const name = value ?? "mainnet";
  if (name === "devnet" || name === "mainnet" || name === "mainnet10k") {
    return name;
  }
  throw new Error(
    `Invalid PROGRAM_CONTEXT "${name}". Expected devnet, mainnet, or mainnet10k.`
  );
}

export function createReadContext(options: CliOptions): BaseCliContext {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL env var is required");

  const programId = address(
    process.env.PROGRAM_ID ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  );
  const programContext = createProgramContext(
    process.env.PROGRAM_CONTEXT,
    programId
  );

  return {
    rpcUrl,
    rpc: createSolanaRpc(rpcUrl),
    programId,
    programContextName: programContext.name,
    programContext: programContext.context,
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
