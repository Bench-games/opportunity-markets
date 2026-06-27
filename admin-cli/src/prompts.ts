import fs from "node:fs";
import { confirm, input, select } from "@inquirer/prompts";
import { address, type Address } from "@solana/kit";
import { optionLabel } from "./render.js";

export async function promptString(message: string, defaultValue?: string): Promise<string> {
  return input({ message, default: defaultValue, required: true });
}

export async function promptOptionalString(message: string, defaultValue?: string): Promise<string | undefined> {
  const value = await input({ message, default: defaultValue ?? "" });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function promptAddress(message: string, defaultValue?: Address | string): Promise<Address> {
  const value = await input({ message, default: defaultValue?.toString(), required: true });
  return address(value.trim());
}

export async function promptBigInt(message: string, defaultValue: bigint | number | string): Promise<bigint> {
  const value = await input({ message, default: defaultValue.toString(), required: true });
  const parsed = BigInt(value.trim());
  if (parsed < 0n) throw new Error(`${message} must be non-negative`);
  return parsed;
}

export async function promptNumber(message: string, defaultValue: number): Promise<number> {
  const value = await input({ message, default: String(defaultValue), required: true });
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${message} must be a non-negative integer`);
  }
  return parsed;
}

export async function promptExistingFile(message: string, defaultValue?: string): Promise<string> {
  const value = await input({ message, default: defaultValue, required: true });
  if (!fs.existsSync(value)) throw new Error(`File does not exist: ${value}`);
  return value;
}

export async function chooseOne<T>(
  message: string,
  values: T[],
  label: (value: T, index: number) => string,
): Promise<T> {
  if (values.length === 0) throw new Error(`No choices available for: ${message}`);
  if (values.length === 1) return values[0]!;
  return select({
    message,
    choices: values.map((value, index) => ({
      name: optionLabel(index, label(value, index)),
      value,
    })),
    pageSize: 12,
  });
}

export async function confirmTransaction(yes: boolean, message = "Send transaction?"): Promise<void> {
  if (yes) return;
  const ok = await confirm({ message, default: false });
  if (!ok) throw new Error("Cancelled");
}
