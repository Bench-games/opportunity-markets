import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deserializeLE } from "@arcium-hq/client";
import {
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isNone,
  isSome,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  ALLOWED_MINT_DISCRIMINATOR,
  ProgramContext,
  ARCIUM_PROGRAM_ID,
  OPPORTUNITY_MARKET_DISCRIMINATOR,
  OPPORTUNITY_MARKET_OPTION_DISCRIMINATOR,
  OPPORTUNITY_MARKET_PROGRAM_ADDRESS,
  PLATFORM_CONFIG_DISCRIMINATOR,
  VOUCH_ACCOUNT_DISCRIMINATOR,
  addMarketOption,
  createCipher,
  createMarket,
  createPlatformConfig,
  fetchAllowedMint,
  fetchOpportunityMarket,
  fetchOpportunityMarketOption,
  fetchPlatformConfig,
  fetchVouchAccount,
  generateX25519Keypair,
  getAllowedMintAddress,
  getCompDefAccount,
  getMxeAccount,
  getOpportunityMarketAddress,
  getOpportunityMarketOptionAddress,
  getPlatformConfigAddress,
  getVouchAccountAddress,
  initAllowedMint,
  initVouchAccount,
  nonceToBytes,
  openMarket,
  randomComputationOffset,
} from "../js/src/index";

const MAINNET_USDC_MINT = address(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const USDC_DECIMALS = 6;
const VOUCH_AMOUNT = 10_000n; // 0.01 USDC; intentionally not configurable on mainnet.
const DEVNET_TOKEN_BALANCE = 1_000_000_000n;
const COMMITMENT = "confirmed" as const;
const USER_PLATFORM_FEE_BP = 50n;
const USER_CREATOR_FEE_BP = 50n;

type Network = "devnet" | "mainnet" | "mainnet10k";

function getNetwork(): Network {
  const network = process.argv[2];
  assert(
    network === "devnet" || network === "mainnet" || network === "mainnet10k",
    "Usage: bun scripts/test-vouch.ts <devnet|mainnet|mainnet10k>"
  );
  return network;
}

function getProgramContext(
  network: Network,
  programId: Address
): ProgramContext {
  switch (network) {
    case "devnet":
      return ProgramContext.devnet(programId);
    case "mainnet":
      return ProgramContext.mainnet(programId);
    case "mainnet10k":
      return ProgramContext.mainnet10k(programId);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`
    );
  }
}

function assertBytes(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  label: string
): void {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label}: mismatch at byte ${index}`);
    }
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.warn(`  attempt ${attempt}/${attempts} failed; retrying...`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw lastError;
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function readKeypair(path: string): Uint8Array {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  assert(Array.isArray(parsed), `Keypair must be a JSON number array: ${path}`);
  assert(
    parsed.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255
    ),
    `Invalid keypair byte in ${path}`
  );
  return Uint8Array.from(parsed);
}

async function waitForConfirmation(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err)
        throw new Error(
          `Transaction ${signature} failed: ${stringify(status.err)}`
        );
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    `Transaction ${signature} was not confirmed within 90 seconds`
  );
}

async function sendInstructions(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: KeyPairSigner,
  label: string,
  instructions: Instruction[]
): Promise<Signature> {
  const signature = await retry(async () => {
    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash({ commitment: COMMITMENT })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (current) => setTransactionMessageFeePayer(payer.address, current),
      (current) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
      (current) => appendTransactionMessageInstructions(instructions, current)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const encoded = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const simulation = await rpc
      .simulateTransaction(encoded, {
        commitment: COMMITMENT,
        encoding: "base64",
      })
      .send();

    if (simulation.value.err) {
      console.error(`\n[${label}] simulation failed`);
      for (const log of simulation.value.logs ?? []) console.error(log);
      throw new Error(
        `${label} simulation failed: ${stringify(simulation.value.err)}`
      );
    }

    console.log(
      `[${label}] simulation passed (units: ${
        simulation.value.unitsConsumed?.toString() ?? "unknown"
      })`
    );
    await rpc.sendTransaction(encoded, { encoding: "base64" }).send();
    return signature;
  });
  await waitForConfirmation(rpc, signature);
  console.log(`[${label}] confirmed: ${signature}`);
  return signature;
}

async function createAndFundDevnetMint(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: KeyPairSigner,
  mint: KeyPairSigner,
  payerTokenAccount: Address
): Promise<Signature[]> {
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const createMintSignature = await sendInstructions(
    rpc,
    payer,
    "create devnet token mint",
    [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMintInstruction({
        mint: mint.address,
        decimals: USDC_DECIMALS,
        mintAuthority: payer.address,
      }),
    ]
  );
  const createAtaSignature = await sendInstructions(
    rpc,
    payer,
    "create devnet payer token account",
    [
      await getCreateAssociatedTokenInstructionAsync({
        payer,
        mint: mint.address,
        owner: payer.address,
      }),
    ]
  );
  const mintSignature = await sendInstructions(
    rpc,
    payer,
    "mint devnet test tokens",
    [
      getMintToInstruction({
        mint: mint.address,
        token: payerTokenAccount,
        mintAuthority: payer,
        amount: DEVNET_TOKEN_BALANCE,
      }),
    ]
  );
  return [createMintSignature, createAtaSignature, mintSignature];
}

async function assertArciumAccount(
  rpc: ReturnType<typeof createSolanaRpc>,
  accountAddress: Address,
  label: string
): Promise<void> {
  const response = await rpc
    .getAccountInfo(accountAddress, {
      commitment: COMMITMENT,
      encoding: "base64",
    })
    .send();
  assert(response.value, `${label} is missing: ${accountAddress}`);
  assertEqual(response.value.owner, ARCIUM_PROGRAM_ID, `${label} owner`);
}

async function fetchAndValidateTokenSetup(
  rpc: ReturnType<typeof createSolanaRpc>,
  tokenMint: Address,
  payerTokenAccount: Address,
  payer: KeyPairSigner,
  vouchAmount: bigint
) {
  const mint = await fetchMint(rpc, tokenMint, { commitment: COMMITMENT });
  assertEqual(mint.programAddress, TOKEN_PROGRAM_ADDRESS, "Mint program owner");
  assert(mint.data.isInitialized, `Mint is not initialized: ${tokenMint}`);
  assertEqual(mint.data.decimals, USDC_DECIMALS, "Mint decimals");

  const payerToken = await fetchToken(rpc, payerTokenAccount, {
    commitment: COMMITMENT,
  });
  assertEqual(
    payerToken.programAddress,
    TOKEN_PROGRAM_ADDRESS,
    "Payer token account owner"
  );
  assertEqual(payerToken.data.owner, payer.address, "Payer token authority");
  assertEqual(payerToken.data.mint, tokenMint, "Payer token mint");
  assert(
    payerToken.data.amount >= vouchAmount,
    `Payer token balance ${payerToken.data.amount} is below ${vouchAmount}`
  );

  return { mint, payerToken };
}

async function main(): Promise<void> {
  const network = getNetwork();
  const rpcUrl = requiredEnv("RPC_URL");
  const programId = address(
    process.env.PROGRAM_ID?.trim() || OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  );
  const payerSecret = readKeypair(requiredEnv("DEPLOYER_KEYPAIR_PATH"));
  const payer = await createKeyPairSignerFromBytes(payerSecret);
  const programContext = getProgramContext(network, programId);
  const devnetMint =
    network === "devnet" ? await generateKeyPairSigner() : undefined;
  const tokenMint = devnetMint?.address ?? MAINNET_USDC_MINT;

  const rpc = createSolanaRpc(rpcUrl);

  const programInfo = await rpc
    .getAccountInfo(programId, { commitment: COMMITMENT, encoding: "base64" })
    .send();
  assert(programInfo.value, `Program account is missing: ${programId}`);
  assert(
    programInfo.value.executable,
    `Program is not executable: ${programId}`
  );

  const payerBalance = (
    await rpc.getBalance(payer.address, { commitment: COMMITMENT }).send()
  ).value;
  assert(payerBalance > 0n, `Payer has no SOL: ${payer.address}`);

  const vouchAmount = VOUCH_AMOUNT;
  const expectedPlatformFee = (vouchAmount * USER_PLATFORM_FEE_BP) / 10_000n;
  const expectedCreatorFee = (vouchAmount * USER_CREATOR_FEE_BP) / 10_000n;
  const expectedNet = vouchAmount - expectedPlatformFee - expectedCreatorFee;

  const [payerTokenAccount] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  let tokenSetup =
    network === "devnet"
      ? undefined
      : await fetchAndValidateTokenSetup(
          rpc,
          tokenMint,
          payerTokenAccount,
          payer,
          vouchAmount
        );

  const computationOffset = randomComputationOffset();
  const computeAccounts = programContext.getComputeAccounts(
    "vouch",
    computationOffset
  );
  await assertArciumAccount(rpc, computeAccounts.mxeAccount, "MXE account");
  await assertArciumAccount(
    rpc,
    computeAccounts.clusterAccount,
    "Arcium cluster account"
  );
  await assertArciumAccount(
    rpc,
    computeAccounts.mempoolAccount,
    "Arcium mempool account"
  );
  await assertArciumAccount(
    rpc,
    computeAccounts.executingPool,
    "Arcium executing pool"
  );
  await assertArciumAccount(
    rpc,
    getCompDefAccount("vouch", programId),
    "vouch comp-def"
  );
  await assertArciumAccount(
    rpc,
    getCompDefAccount("reveal_vouch", programId),
    "reveal_vouch comp-def"
  );

  const mxe = await getMxeAccount(rpc, programId);
  const [utilityPubkeys] = mxe.data.utilityPubkeys.fields;
  const mxePublicKey = Uint8Array.from(utilityPubkeys.x25519Pubkey);
  assertEqual(mxePublicKey.length, 32, "MXE X25519 public key length");

  const platformName = `vouch-${Date.now().toString(36)}`;
  assert(platformName.length <= 20, "Generated platform name is too long");
  const marketIndex = 0n;
  const optionIds = [0, 1, 2] as const;
  const selectedOptionId = 1;
  const vouchAccountId = randomBytes(4).readUInt32LE(0) || 1;
  const authorizedReader = generateX25519Keypair();
  const vouchOwnerEncryption = generateX25519Keypair();
  const inputNonceBytes = randomBytes(16);
  const stateNonce = deserializeLE(randomBytes(16));
  const [platformConfig] = await getPlatformConfigAddress(
    payer.address,
    platformName,
    programId
  );
  const [allowedMint] = await getAllowedMintAddress(
    platformConfig,
    tokenMint,
    programId
  );
  const [market] = await getOpportunityMarketAddress(
    platformConfig,
    payer.address,
    marketIndex,
    programId
  );
  const [marketTokenAccount] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: market,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [vouchAccount] = await getVouchAccountAddress(
    payer.address,
    market,
    vouchAccountId,
    programId
  );
  const optionAddresses = await Promise.all(
    optionIds.map(
      async (optionId) =>
        (
          await getOpportunityMarketOptionAddress(market, optionId, programId)
        )[0]
    )
  );

  console.log("\nOpportunity Markets vouch smoke test");
  console.log(`  Cluster: ${network}`);
  console.log(`  Arcium cluster offset: ${programContext.clusterOffset}`);
  console.log(`  Program: ${programId}`);
  console.log(`  Fee payer/authority: ${payer.address}`);
  console.log(`  Payer SOL: ${payerBalance} lamports`);
  console.log(`  Mint: ${tokenMint} (${USDC_DECIMALS} decimals)`);
  console.log(
    `  Token transfer: ${formatTokenAmount(
      vouchAmount,
      USDC_DECIMALS
    )} token (${vouchAmount} raw)`
  );
  console.log(`  Payer token account: ${payerTokenAccount}`);
  console.log(`  Market token recipient: ${marketTokenAccount}`);
  console.log(`  Platform: ${platformConfig} (${platformName})`);
  console.log(`  Allowed mint: ${allowedMint}`);
  console.log(`  Market: ${market}`);
  console.log(`  Options: ${optionAddresses.join(", ")}`);
  console.log(`  Vouch account: ${vouchAccount} (id ${vouchAccountId})`);
  const transactionCount = network === "devnet" ? 12 : 9;
  console.log(
    `  Writes: ${transactionCount} transactions; each is simulated before submission\n`
  );

  assert(
    process.env.EXECUTE === "1",
    `Preflight passed. Set EXECUTE=1 to authorize the ${transactionCount} ${network} transactions.`
  );

  const signatures: Signature[] = [];
  if (devnetMint) {
    signatures.push(
      ...(await createAndFundDevnetMint(
        rpc,
        payer,
        devnetMint,
        payerTokenAccount
      ))
    );
    tokenSetup = await fetchAndValidateTokenSetup(
      rpc,
      tokenMint,
      payerTokenAccount,
      payer,
      vouchAmount
    );
  }
  assert(tokenSetup, "Token setup was not initialized");
  const payerTokenBefore = tokenSetup.payerToken;

  signatures.push(
    await sendInstructions(rpc, payer, "create platform", [
      await createPlatformConfig(rpc, {
        programAddress: programId,
        signer: payer,
        name: platformName,
        userPlatformFeeBp: Number(USER_PLATFORM_FEE_BP),
        userRewardPoolFeeBp: 0,
        userCreatorFeeBp: Number(USER_CREATOR_FEE_BP),
        sponsorPlatformFeeBp: 0,
        feeClaimAuthority: payer.address,
        revealAuthority: payer.address,
        optionCreationAuthority: payer.address,
        minTimeToVouchSeconds: 86_400n,
        revealPeriodSeconds: 2_592_000n,
        marketResolutionDeadlineSeconds: 604_800n,
      }),
    ])
  );
  const platform = await fetchPlatformConfig(rpc, platformConfig, {
    commitment: COMMITMENT,
  });
  assertEqual(platform.programAddress, programId, "Platform account owner");
  assertBytes(
    platform.data.discriminator,
    PLATFORM_CONFIG_DISCRIMINATOR,
    "Platform discriminator"
  );
  assertEqual(platform.data.name, platformName, "Platform name");

  signatures.push(
    await sendInstructions(rpc, payer, "allow mint", [
      (await initAllowedMint({
        programAddress: programId,
        updateAuthority: payer,
        platformConfig,
        tokenMint,
      })) as Instruction,
    ])
  );
  const allowed = await fetchAllowedMint(rpc, allowedMint, {
    commitment: COMMITMENT,
  });
  assertEqual(allowed.programAddress, programId, "Allowed-mint account owner");
  assertBytes(
    allowed.data.discriminator,
    ALLOWED_MINT_DISCRIMINATOR,
    "Allowed-mint discriminator"
  );
  assertEqual(allowed.data.platform, platformConfig, "Allowed-mint platform");
  assertEqual(allowed.data.mint, tokenMint, "Allowed-mint mint");

  signatures.push(
    await sendInstructions(rpc, payer, "create market", [
      (await createMarket({
        programAddress: programId,
        creator: payer,
        platformConfig,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        marketIndex,
        marketAuthority: payer.address,
        authorizedReaderPubkey: authorizedReader.publicKey,
        earlinessCutoffSeconds: 7_200n,
        earlinessMultiplier: 10_000,
        minVouchAmount: 1n,
        creatorFeeClaimer: payer.address,
      })) as Instruction,
    ])
  );

  signatures.push(
    await sendInstructions(rpc, payer, "open market", [
      openMarket({
        programAddress: programId,
        marketAuthority: payer,
        market,
        platformConfig,
        timeToVouch: 86_400n,
      }) as Instruction,
    ])
  );

  for (const optionId of optionIds) {
    signatures.push(
      await sendInstructions(rpc, payer, `add option ${optionId}`, [
        (await addMarketOption({
          programAddress: programId,
          signer: payer,
          platformConfig,
          market,
          optionId,
        })) as Instruction,
      ])
    );
  }

  const marketAccount = await fetchOpportunityMarket(rpc, market, {
    commitment: COMMITMENT,
  });
  assertEqual(marketAccount.programAddress, programId, "Market account owner");
  assertBytes(
    marketAccount.data.discriminator,
    OPPORTUNITY_MARKET_DISCRIMINATOR,
    "Market discriminator"
  );
  assertEqual(marketAccount.data.platform, platformConfig, "Market platform");
  assertEqual(marketAccount.data.mint, tokenMint, "Market mint");
  assertEqual(marketAccount.data.totalOptions, 3n, "Market option count");
  assert(
    isSome(marketAccount.data.vouchingWindowEnd),
    "Market is not open for vouching"
  );

  for (let index = 0; index < optionIds.length; index += 1) {
    const option = await fetchOpportunityMarketOption(
      rpc,
      optionAddresses[index],
      {
        commitment: COMMITMENT,
      }
    );
    assertEqual(
      option.programAddress,
      programId,
      `Option ${optionIds[index]} account owner`
    );
    assertBytes(
      option.data.discriminator,
      OPPORTUNITY_MARKET_OPTION_DISCRIMINATOR,
      `Option ${optionIds[index]} discriminator`
    );
    assertEqual(
      option.data.id,
      BigInt(optionIds[index]),
      `Option ${optionIds[index]} ID`
    );
  }

  signatures.push(
    await sendInstructions(rpc, payer, "initialize vouch account", [
      (await initVouchAccount({
        programAddress: programId,
        payer,
        owner: payer.address,
        market,
        vouchAccountId,
      })) as Instruction,
    ])
  );

  const inputCipher = createCipher(
    vouchOwnerEncryption.secretKey,
    mxePublicKey
  );
  const selectedOptionCiphertext = inputCipher.encrypt(
    [BigInt(selectedOptionId)],
    inputNonceBytes
  )[0];
  const vouchInstruction = await programContext.vouch(
    {
      signer: payer,
      payer,
      market,
      vouchAccount,
      vouchAccountId,
      tokenMint,
      signerTokenAccount: payerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: vouchAmount,
      selectedOptionCiphertext,
      inputNonce: deserializeLE(inputNonceBytes),
      authorizedReaderNonce: deserializeLE(randomBytes(16)),
      userPubkey: vouchOwnerEncryption.publicKey,
      stateNonce,
    },
    computationOffset
  );
  const vouchSignature = await sendInstructions(rpc, payer, "vouch", [
    vouchInstruction as Instruction,
  ]);
  signatures.push(vouchSignature);

  console.log("[vouch callback] waiting for Arcium finalization...");
  const callbackSignature = await programContext.awaitVouchFinalization(
    rpc,
    vouchSignature,
    computationOffset,
    { commitment: COMMITMENT }
  );
  console.log(`[vouch callback] confirmed: ${callbackSignature}`);

  const finalizedVouch = await fetchVouchAccount(rpc, vouchAccount, {
    commitment: COMMITMENT,
  });
  assertEqual(finalizedVouch.programAddress, programId, "Vouch account owner");
  assertBytes(
    finalizedVouch.data.discriminator,
    VOUCH_ACCOUNT_DISCRIMINATOR,
    "Vouch discriminator"
  );
  assertEqual(finalizedVouch.data.owner, payer.address, "Vouch owner");
  assertEqual(finalizedVouch.data.market, market, "Vouch market");
  assertEqual(finalizedVouch.data.id, vouchAccountId, "Vouch account ID");
  assertBytes(
    finalizedVouch.data.userPubkey,
    vouchOwnerEncryption.publicKey,
    "Vouch user X25519 pubkey"
  );
  assert(
    isNone(finalizedVouch.data.pendingVouchComputation),
    "Vouch computation is still pending"
  );
  assert(
    isSome(finalizedVouch.data.vouchedAtTimestamp),
    "Vouch timestamp is missing"
  );
  assertEqual(finalizedVouch.data.amount, expectedNet, "Net vouch amount");
  assertEqual(
    finalizedVouch.data.collectedFees.platformFee,
    expectedPlatformFee,
    "Platform fee"
  );
  assertEqual(
    finalizedVouch.data.collectedFees.creatorFee,
    expectedCreatorFee,
    "Creator fee"
  );

  const decryptedOwnerChoice = createCipher(
    vouchOwnerEncryption.secretKey,
    mxePublicKey
  ).decrypt(
    [finalizedVouch.data.encryptedOption],
    nonceToBytes(finalizedVouch.data.stateNonce)
  )[0];
  const decryptedReaderChoice = createCipher(
    authorizedReader.secretKey,
    mxePublicKey
  ).decrypt(
    [finalizedVouch.data.encryptedOptionDisclosure],
    nonceToBytes(finalizedVouch.data.stateNonceDisclosure)
  )[0];
  assertEqual(
    decryptedOwnerChoice,
    BigInt(selectedOptionId),
    "Owner-decrypted choice"
  );
  assertEqual(
    decryptedReaderChoice,
    BigInt(selectedOptionId),
    "Reader-decrypted choice"
  );

  const payerTokenAfter = await fetchToken(rpc, payerTokenAccount, {
    commitment: COMMITMENT,
  });
  const marketTokenAfter = await fetchToken(rpc, marketTokenAccount, {
    commitment: COMMITMENT,
  });
  assertEqual(
    payerTokenBefore.data.amount - payerTokenAfter.data.amount,
    vouchAmount,
    "Payer token delta"
  );
  assertEqual(
    marketTokenAfter.data.owner,
    market,
    "Market token account authority"
  );
  assertEqual(
    marketTokenAfter.data.mint,
    tokenMint,
    "Market token account mint"
  );
  assertEqual(
    marketTokenAfter.data.amount,
    vouchAmount,
    "Market token balance"
  );

  console.log("\nPASS: vouch encrypted and decrypted correctly");
  console.log(`  Submitted option: ${selectedOptionId}`);
  console.log(`  Owner decrypted: ${decryptedOwnerChoice}`);
  console.log(`  Reader decrypted: ${decryptedReaderChoice}`);
  console.log(`  Vouch account: ${vouchAccount}`);
  console.log(`  Callback: ${callbackSignature}`);
  console.log("  Transactions:");
  for (const signature of signatures) console.log(`    ${signature}`);
}

main().catch((error) => {
  console.error(
    "\nFAIL:",
    error instanceof Error ? error.stack ?? error.message : error
  );
  process.exitCode = 1;
});
