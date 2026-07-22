import chalk from "chalk";
import type { Address, Signature } from "@solana/kit";

export function shortAddress(value: string | Address, chars = 4): string {
  const text = value.toString();
  if (text.length <= chars * 2 + 3) return text;
  return `${text.slice(0, chars)}...${text.slice(-chars)}`;
}

export function printHeader(title: string): void {
  console.log(chalk.bold.cyan(title));
}

export function printTxResult(signature: Signature): void {
  console.log(`${chalk.green("Confirmed")} ${signature}`);
}

export function printSummary(rows: Record<string, unknown>): void {
  const width = Math.max(...Object.keys(rows).map((key) => key.length), 0);
  for (const [key, value] of Object.entries(rows)) {
    console.log(`${chalk.dim(key.padEnd(width))}  ${String(value)}`);
  }
}

export function printProgramContextBadge(name: string): void {
  const label = `[${name}]`;
  const badge =
    name === "devnet"
      ? chalk.bold.green(label)
      : name === "mainnet"
      ? chalk.bold.red(label)
      : name === "mainnet10k"
      ? chalk.bold.yellow(label)
      : chalk.bold.red(label);
  console.log("-".repeat(80));
  console.log(`context: ${badge}`);
}

export function optionLabel(
  index: number,
  label: string,
  detail?: string
): string {
  return `${chalk.cyan(String(index + 1).padStart(2, " "))}  ${label}${
    detail ? chalk.dim(`  ${detail}`) : ""
  }`;
}
