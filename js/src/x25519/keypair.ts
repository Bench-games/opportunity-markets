import { RescueCipher, x25519 } from "@arcium-hq/client";
import { BN } from "bn.js";
import { createHash } from "crypto";

export interface X25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generates a new X25519 keypair.
 * Used for encrypted computations with Arcium.
 */
export function generateX25519Keypair(): X25519Keypair {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

/**
 * Derives an X25519 keypair deterministically from a signature
 */
export function deriveX25519KeypairFromSignature(signature: Uint8Array): X25519Keypair {
  const secretKey = new Uint8Array(createHash("sha256").update(signature).digest());
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/**
 * Derives the shared secret between a user's secret key and the MXE public key.
 * Use this to create a RescueCipher for encryption/decryption.
 */
export function deriveSharedSecret(userSecretKey: Uint8Array, mxePublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(userSecretKey, mxePublicKey);
}

/**
 * Creates a RescueCipher from a user's secret key and MXE public key.
 * Convenience function combining deriveSharedSecret + RescueCipher creation.
 */
export function createCipher(userSecretKey: Uint8Array, mxePublicKey: Uint8Array): RescueCipher {
  const sharedSecret = deriveSharedSecret(userSecretKey, mxePublicKey);
  return new RescueCipher(sharedSecret);
}

export function nonceToBytes(nonce: bigint): Uint8Array {
  return Uint8Array.from(new BN(nonce.toString()).toArray("le", 16));
}
