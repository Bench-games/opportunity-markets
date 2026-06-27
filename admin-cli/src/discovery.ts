import ora from "ora";
import {
  address,
  isNone,
  isSome,
  parseBase64RpcAccount,
  type Account,
  type Address,
} from "@solana/kit";
import {
  ALLOWED_MINT_DISCRIMINATOR,
  decodeAllowedMint,
  decodeOpportunityMarket,
  decodePlatformConfig,
  OPPORTUNITY_MARKET_DISCRIMINATOR,
  PLATFORM_CONFIG_DISCRIMINATOR,
  type AllowedMint,
  type OpportunityMarket,
  type PlatformConfig,
} from "../../js/src/generated/index.js";
import type { BaseCliContext } from "./context.js";
import { chooseOne } from "./prompts.js";
import { shortAddress } from "./render.js";

export type PlatformAccount = Account<PlatformConfig>;
export type AllowedMintAccount = Account<AllowedMint>;
export type MarketAccount = Account<OpportunityMarket>;

function discriminatorFilter(bytes: Uint8Array) {
  return {
    memcmp: {
      offset: 0n,
      encoding: "base64",
      bytes: Buffer.from(bytes).toString("base64") as never,
    },
  } as const;
}

async function fetchProgramAccounts(ctx: BaseCliContext, discriminator: Uint8Array) {
  return ctx.rpc
    .getProgramAccounts(ctx.programId, {
      encoding: "base64",
      filters: [discriminatorFilter(discriminator)],
      commitment: ctx.commitment,
    })
    .send() as unknown as Promise<Array<{ pubkey: Address; account: unknown }>>;
}

function parseProgramAccount(
  ctx: BaseCliContext,
  item: { pubkey: Address; account: unknown },
): unknown {
  const accountAddress = address(item.pubkey.toString());
  const encoded = parseBase64RpcAccount(accountAddress, item.account as never);
  if (encoded.programAddress !== ctx.programId) {
    throw new Error(`Account ${accountAddress} is not owned by program ${ctx.programId}`);
  }
  return encoded;
}

function decodePlatformAccount(ctx: BaseCliContext, item: { pubkey: Address; account: unknown }): PlatformAccount {
  return decodePlatformConfig(parseProgramAccount(ctx, item) as never) as PlatformAccount;
}

function decodeAllowedMintAccount(ctx: BaseCliContext, item: { pubkey: Address; account: unknown }): AllowedMintAccount {
  return decodeAllowedMint(parseProgramAccount(ctx, item) as never) as AllowedMintAccount;
}

function decodeMarketAccount(ctx: BaseCliContext, item: { pubkey: Address; account: unknown }): MarketAccount {
  return decodeOpportunityMarket(parseProgramAccount(ctx, item) as never) as MarketAccount;
}

export async function listPlatforms(ctx: BaseCliContext): Promise<PlatformAccount[]> {
  const spinner = ora("Fetching platform configs").start();
  const accounts = await fetchProgramAccounts(ctx, Uint8Array.from(PLATFORM_CONFIG_DISCRIMINATOR));
  const decoded = accounts.map((item) => decodePlatformAccount(ctx, item));
  spinner.succeed(`Fetched ${decoded.length} platform config(s)`);
  return decoded.sort((a, b) => a.data.name.localeCompare(b.data.name));
}

export async function listAllowedMints(ctx: BaseCliContext, platform?: Address): Promise<AllowedMintAccount[]> {
  const spinner = ora("Fetching allowed mints").start();
  const accounts = await fetchProgramAccounts(ctx, Uint8Array.from(ALLOWED_MINT_DISCRIMINATOR));
  const decoded = accounts
    .map((item) => decodeAllowedMintAccount(ctx, item))
    .filter((item) => !platform || item.data.platform === platform)
    .sort((a, b) => a.data.mint.localeCompare(b.data.mint));
  spinner.succeed(`Fetched ${decoded.length} allowed mint(s)`);
  return decoded;
}

export async function listMarkets(ctx: BaseCliContext, platform?: Address): Promise<MarketAccount[]> {
  const spinner = ora("Fetching markets").start();
  const accounts = await fetchProgramAccounts(ctx, Uint8Array.from(OPPORTUNITY_MARKET_DISCRIMINATOR));
  const decoded = accounts
    .map((item) => decodeMarketAccount(ctx, item))
    .filter((item) => !platform || item.data.platform === platform)
    .sort((a, b) => Number(a.data.index - b.data.index));
  spinner.succeed(`Fetched ${decoded.length} market(s)`);
  return decoded;
}

export function describeMarketPhase(market: OpportunityMarket): string {
  if (isSome(market.resolvedAtTimestamp)) return market.revealEnded ? "settlement" : "revealing";
  if (isNone(market.vouchingWindowEnd)) return "not open";
  const end = Number(market.vouchingWindowEnd.value);
  return Math.floor(Date.now() / 1000) < end ? "vouching" : "selection/expired";
}

export async function selectPlatform(ctx: BaseCliContext, message = "Select platform"): Promise<PlatformAccount> {
  const platforms = await listPlatforms(ctx);
  return chooseOne(message, platforms, (item) => {
    const fees = item.data.feeRates;
    return `${item.data.name}  ${shortAddress(item.address)}  fees ${fees.platformFeeBp}/${fees.rewardPoolFeeBp}/${fees.creatorFeeBp}bp`;
  });
}

export async function selectAllowedMint(
  ctx: BaseCliContext,
  platform: Address,
  message = "Select allowed mint",
): Promise<AllowedMintAccount> {
  const mints = await listAllowedMints(ctx, platform);
  return chooseOne(message, mints, (item) => `${shortAddress(item.data.mint)}  account ${shortAddress(item.address)}`);
}

export async function selectMarket(ctx: BaseCliContext, platform?: Address, message = "Select market"): Promise<MarketAccount> {
  const markets = await listMarkets(ctx, platform);
  return chooseOne(message, markets, (item) => {
    return `#${item.data.index}  ${describeMarketPhase(item.data)}  ${shortAddress(item.address)}  mint ${shortAddress(item.data.mint)}`;
  });
}
