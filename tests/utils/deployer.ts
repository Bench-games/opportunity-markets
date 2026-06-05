import * as fs from "fs";
import * as os from "os";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

function walletPath(): string {
  return process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;
}

export function getWalletSecretKey(): Uint8Array {
  const file = fs.readFileSync(walletPath());
  return new Uint8Array(JSON.parse(file.toString()));
}

let cached: KeyPairSigner | null = null;

export async function getDeployerKeypair(): Promise<KeyPairSigner> {
  if (cached) return cached;
  cached = await createKeyPairSignerFromBytes(getWalletSecretKey());
  return cached;
}
