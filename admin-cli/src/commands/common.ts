import type { Command } from "commander";
import { createContext, createReadContext, type BaseCliContext, type CliContext } from "../context.js";

export async function getContext(command: Command): Promise<CliContext> {
  return createContext(command.optsWithGlobals());
}

export function getReadContext(command: Command): BaseCliContext {
  return createReadContext(command.optsWithGlobals());
}
