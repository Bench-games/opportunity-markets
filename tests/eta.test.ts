import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  address,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  sendAndConfirmTransactionFactory,
  type Address,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  awaitComputationFinalization,
  initEncryptedTokenAccount,
  initEphemeralEncryptedTokenAccount,
  closeEphemeralEncryptedTokenAccount,
  wrapEncryptedTokens,
  unwrapEncryptedTokens,
  randomComputationOffset,
  randomStateNonce,
  fetchEncryptedTokenAccount,
  fetchMaybeCentralState,
  getEncryptedTokenAccountAddress,
  getEphemeralEncryptedTokenAccountAddress,
  getInitCentralStateInstructionAsync,
  getTokenVaultAddress,
  initTokenVault,
} from "../js/src";
import { initializeAllCompDefs } from "./utils/comp-defs";
import { sendTransaction } from "./utils/transaction";
import { createMintAndFundAccount, createAta } from "./utils/spl-token";
import { nonceToBytes } from "./utils/nonce";
import { getArciumEnv, getMXEPublicKey } from "@arcium-hq/client";
import { OpportunityMarket } from "../target/types/opportunity_market";
import * as fs from "fs";
import * as os from "os";
import { generateX25519Keypair, createCipher } from "../js/src/x25519/keypair";
import { expect } from "chai";
import { shouldThrowCustomError } from "./utils/errors";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WS_URL = RPC_URL.replace("http", "ws").replace(":8899", ":8900");

describe("Encrypted Token Account (SPL)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.OpportunityMarket as Program<OpportunityMarket>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const programId = address(program.programId.toBase58());
  const arciumEnv = getArciumEnv();

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
  const airdrop = airdropFactory({ rpc, rpcSubscriptions });
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  let mxePublicKey: Uint8Array;

  /**
   * Initializes a per-mint token vault and creates the vault's ATA.
   * Returns the token vault address.
   */
  async function initTokenVaultForMint(
    payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
    mint: Address,
  ): Promise<Address> {
    const [vaultAddress] = await getTokenVaultAddress(mint, programId);
    const vaultAccount = await rpc.getAccountInfo(vaultAddress).send();
    if (!vaultAccount.value) {
      const initVaultIx = await initTokenVault({
        payer,
        tokenMint: mint,
        fundManager: payer.address,
      });
      await sendTransaction(rpc, sendAndConfirm, payer, [initVaultIx], {
        label: "initTokenVault",
      });
    }
    await createAta(rpc, sendAndConfirm, payer, mint, vaultAddress);
    return vaultAddress;
  }

  before(async () => {
    const file = fs.readFileSync(`${os.homedir()}/.config/solana/id.json`);
    const secretKey = new Uint8Array(JSON.parse(file.toString()));
    await initializeAllCompDefs(rpc, sendAndConfirm, secretKey, programId, [
      "wrap_encrypted_tokens",
      "unwrap_encrypted_tokens",
      "close_ephemeral_encrypted_token_account",
    ]);
    mxePublicKey = await getMXEPublicKey(provider, program.programId);

    // Ensure central state exists (required by initTokenVault)
    const { getProgramDerivedAddress, getBytesEncoder } = await import("@solana/kit");
    const [centralStateAddress] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [getBytesEncoder().encode(new Uint8Array([99, 101, 110, 116, 114, 97, 108, 95, 115, 116, 97, 116, 101]))],
    });
    const centralState = await fetchMaybeCentralState(rpc, centralStateAddress);
    if (!centralState.exists) {
      const payer = await generateKeyPairSigner();
      await airdrop({ recipientAddress: payer.address, lamports: lamports(2_000_000_000n), commitment: "confirmed" });
      const ix = await getInitCentralStateInstructionAsync({
        payer,
        earlinessCutoffSeconds: 0n,
        minOptionDeposit: 1n,
        protocolFeeBp: 0,
        feeRecipient: payer.address,
      });
      await sendTransaction(rpc, sendAndConfirm, payer, [ix], { label: "Init central state" });
    }
  });

  /**
   * Fetches the ETA from chain and decrypts the encrypted balance.
   */
  async function decryptEtaBalance(
    etaAddress: Parameters<typeof fetchEncryptedTokenAccount>[1],
    userSecretKey: Uint8Array,
  ): Promise<bigint> {
    const eta = await fetchEncryptedTokenAccount(rpc, etaAddress);
    const cipher = createCipher(userSecretKey, mxePublicKey);
    const nonceBytes = nonceToBytes(eta.data.stateNonce);
    const decrypted = cipher.decrypt(eta.data.encryptedState, nonceBytes);
    return decrypted[0];
  }

  it("can init ETA, wrap encrypted tokens, and unwrap them back", async () => {
    // Generate a user keypair and airdrop SOL for fees
    const user = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: user.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    // Create an SPL token mint and fund the user's ATA with tokens
    const splAmount = 100_000_000n;
    const { mint, ata: userAta } = await createMintAndFundAccount(
      rpc,
      sendAndConfirm,
      user,
      user.address,
      splAmount,
    );

    // Generate x25519 keypair for encryption
    const keypair = generateX25519Keypair();

    // Init encrypted token account (no MPC needed - just creates empty account)
    const stateNonce = randomStateNonce();
    const initEtaIx = await initEncryptedTokenAccount({
      signer: user,
      tokenMint: mint.address,
      userPubkey: keypair.publicKey,
      stateNonce,
    });

    await sendTransaction(rpc, sendAndConfirm, user, [initEtaIx], {
      label: "initEncryptedTokenAccount",
    });

    // Verify ETA was created with correct owner and mint
    const [etaAddress] = await getEncryptedTokenAccountAddress(mint.address, user.address, programId);
    const etaAccount = await fetchEncryptedTokenAccount(rpc, etaAddress);
    expect(etaAccount.data.owner).to.equal(user.address);
    expect(etaAccount.data.tokenMint).to.equal(mint.address);
    expect(etaAccount.data.stateNonce).to.equal(stateNonce);

    // Initialize per-mint token vault and its ATA
    await initTokenVaultForMint(user, mint.address);

    // Wrap encrypted tokens (transfers SPL tokens from user ATA -> token vault ATA, updates encrypted balance)
    const wrapAmount = 50_000_000n;
    const wrapOffset = randomComputationOffset();

    const wrapIx = await wrapEncryptedTokens(
      {
        signer: user,
        tokenMint: mint.address,
        encryptedTokenAccount: etaAddress,
        signerTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: wrapAmount,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: wrapOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, user, [wrapIx], {
      label: "wrapEncryptedTokens",
    });
    await awaitComputationFinalization(rpc, wrapOffset);

    // Verify encrypted balance equals wrapped amount
    const balanceAfterWrap = await decryptEtaBalance(etaAddress, keypair.secretKey);
    expect(balanceAfterWrap).to.equal(wrapAmount);

    // Unwrap encrypted tokens (transfers SPL tokens from ETA's ATA -> user ATA, updates encrypted balance)
    const unwrapAmount = 25_000_000n;
    const unwrapOffset = randomComputationOffset();

    const unwrapIx = await unwrapEncryptedTokens(
      {
        signer: user,
        tokenMint: mint.address,
        encryptedTokenAccount: etaAddress,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: unwrapAmount,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: unwrapOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, user, [unwrapIx], {
      label: "unwrapEncryptedTokens",
    });
    await awaitComputationFinalization(rpc, unwrapOffset);

    // Verify encrypted balance decreased by unwrapped amount
    const balanceAfterUnwrap = await decryptEtaBalance(etaAddress, keypair.secretKey);
    expect(balanceAfterUnwrap).to.equal(wrapAmount - unwrapAmount);
  });

  it("another user can create ephemeral ETA", async () => {
    // Generate owner keypair and airdrop SOL
    const owner = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: owner.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    // Generate another user (payer) who will create the ephemeral ETA
    const payer = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: payer.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    // Create an SPL token mint and fund owner's ATA with tokens
    const splAmount = 100_000_000n;
    const { mint, ata: ownerAta } = await createMintAndFundAccount(
      rpc,
      sendAndConfirm,
      owner,
      owner.address,
      splAmount,
    );

    // Generate x25519 keypair for encryption
    const keypair = generateX25519Keypair();

    // Owner inits their regular ETA first
    const initEtaIx = await initEncryptedTokenAccount({
      signer: owner,
      tokenMint: mint.address,
      userPubkey: keypair.publicKey,
      stateNonce: randomStateNonce(),
    });

    await sendTransaction(rpc, sendAndConfirm, owner, [initEtaIx], {
      label: "initEncryptedTokenAccount (owner)",
    });

    // Payer creates ephemeral ETA for owner (permissionless)
    const ephemeralIndex = 1n;
    const initEphemeralIx = await initEphemeralEncryptedTokenAccount({
      signer: payer,
      owner: owner.address,
      tokenMint: mint.address,
      index: ephemeralIndex,
      stateNonce: randomStateNonce(),
    });

    await sendTransaction(rpc, sendAndConfirm, payer, [initEphemeralIx], {
      label: "initEphemeralEncryptedTokenAccount (payer creates for owner)",
    });

    // Verify ephemeral ETA was created with correct owner and copied user_pubkey
    const [ephemeralEtaAddress] = await getEphemeralEncryptedTokenAccountAddress(
      mint.address,
      owner.address,
      ephemeralIndex,
      programId,
    );
    const ephemeralEta = await fetchEncryptedTokenAccount(rpc, ephemeralEtaAddress);
    expect(ephemeralEta.data.owner).to.equal(owner.address);
    expect(ephemeralEta.data.tokenMint).to.equal(mint.address);

    // Initialize per-mint token vault and its ATA
    await initTokenVaultForMint(owner, mint.address);

    // Owner wraps tokens to their ephemeral ETA
    const wrapAmount = 50_000_000n;
    const wrapOffset = randomComputationOffset();

    const wrapIx = await wrapEncryptedTokens(
      {
        signer: owner,
        tokenMint: mint.address,
        encryptedTokenAccount: ephemeralEtaAddress,
        signerTokenAccount: ownerAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: wrapAmount,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: wrapOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, owner, [wrapIx], {
      label: "wrapEncryptedTokens (to ephemeral ETA)",
    });
    await awaitComputationFinalization(rpc, wrapOffset);

    // Verify encrypted balance in ephemeral ETA
    const balanceAfterWrap = await decryptEtaBalance(ephemeralEtaAddress, keypair.secretKey);
    expect(balanceAfterWrap).to.equal(wrapAmount);

    // Owner unwraps tokens from ephemeral ETA back to their ATA
    const unwrapAmount = 30_000_000n;
    const unwrapOffset = randomComputationOffset();

    const unwrapIx = await unwrapEncryptedTokens(
      {
        signer: owner,
        tokenMint: mint.address,
        encryptedTokenAccount: ephemeralEtaAddress,
        userTokenAccount: ownerAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: unwrapAmount,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: unwrapOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, owner, [unwrapIx], {
      label: "unwrapEncryptedTokens (from ephemeral ETA)",
    });
    await awaitComputationFinalization(rpc, unwrapOffset);

    // Verify encrypted balance decreased
    const balanceAfterUnwrap = await decryptEtaBalance(ephemeralEtaAddress, keypair.secretKey);
    expect(balanceAfterUnwrap).to.equal(wrapAmount - unwrapAmount);
  });

  it("cannot create ephemeral ETA if regular ETA does not exist", async () => {
    const owner = await generateKeyPairSigner();

    const payer = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: payer.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    const { mint } = await createMintAndFundAccount(
      rpc,
      sendAndConfirm,
      payer,
      payer.address,
      1_000_000n,
    );

    // Payer tries to create ephemeral ETA for owner without regular ETA existing
    const ephemeralIndex = 1n;
    const initEphemeralIx = await initEphemeralEncryptedTokenAccount({
      signer: payer,
      owner: owner.address,
      tokenMint: mint.address,
      index: ephemeralIndex,
      stateNonce: randomStateNonce(),
    });
    await shouldThrowCustomError(
      () =>  sendTransaction(rpc, sendAndConfirm, payer, [initEphemeralIx], {
        label: "initEphemeralEncryptedTokenAccount (should fail)",
      }),
      3012 // Account not initialized
    );
  });

  it("can close ephemeral ETA and transfer balance", async () => {
    // User A (owner) creates their regular ETA
    const userA = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: userA.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    // User B (payer) will create ephemeral ETA for user A
    const userB = await generateKeyPairSigner();
    await airdrop({
      recipientAddress: userB.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });

    // Create SPL token mint and fund user A
    const splAmount = 100_000_000n;
    const { mint, ata: userAAta } = await createMintAndFundAccount(
      rpc,
      sendAndConfirm,
      userA,
      userA.address,
      splAmount,
    );

    // Generate x25519 keypair for encryption
    const keypair = generateX25519Keypair();

    // User A creates their regular ETA
    const initEtaIx = await initEncryptedTokenAccount({
      signer: userA,
      tokenMint: mint.address,
      userPubkey: keypair.publicKey,
      stateNonce: randomStateNonce(),
    });

    await sendTransaction(rpc, sendAndConfirm, userA, [initEtaIx], {
      label: "initEncryptedTokenAccount (user A)",
    });

    const [regularEtaAddress] = await getEncryptedTokenAccountAddress(mint.address, userA.address, programId);

    // User B creates ephemeral ETA for user A
    const ephemeralIndex = 1n;
    const initEphemeralIx = await initEphemeralEncryptedTokenAccount({
      signer: userB,
      owner: userA.address,
      tokenMint: mint.address,
      index: ephemeralIndex,
      stateNonce: randomStateNonce(),
    });

    // Record user B's balance before creating ephemeral ETA
    const userBBalanceBefore = await rpc.getBalance(userB.address).send();

    await sendTransaction(rpc, sendAndConfirm, userB, [initEphemeralIx], {
      label: "initEphemeralEncryptedTokenAccount (user B creates for user A)",
    });

    // Record user B's balance after creating ephemeral ETA (should be lower due to rent)
    const userBBalanceAfterCreate = await rpc.getBalance(userB.address).send();
    const rentPaid = userBBalanceBefore.value - userBBalanceAfterCreate.value;
    expect(rentPaid > 0n).to.be.true;

    const [ephemeralEtaAddress] = await getEphemeralEncryptedTokenAccountAddress(
      mint.address,
      userA.address,
      ephemeralIndex,
      programId,
    );

    // Initialize per-mint token vault and its ATA
    await initTokenVaultForMint(userA, mint.address);

    // User A wraps tokens into BOTH ETAs
    const wrapAmountRegular = 30_000_000n;
    const wrapAmountEphemeral = 20_000_000n;

    // Wrap into regular ETA
    const wrapRegularOffset = randomComputationOffset();
    const wrapRegularIx = await wrapEncryptedTokens(
      {
        signer: userA,
        tokenMint: mint.address,
        encryptedTokenAccount: regularEtaAddress,
        signerTokenAccount: userAAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: wrapAmountRegular,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: wrapRegularOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, userA, [wrapRegularIx], {
      label: "wrapEncryptedTokens (to regular ETA)",
    });
    await awaitComputationFinalization(rpc, wrapRegularOffset);

    // Wrap into ephemeral ETA
    const wrapEphemeralOffset = randomComputationOffset();
    const wrapEphemeralIx = await wrapEncryptedTokens(
      {
        signer: userA,
        tokenMint: mint.address,
        encryptedTokenAccount: ephemeralEtaAddress,
        signerTokenAccount: userAAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: wrapAmountEphemeral,
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: wrapEphemeralOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, userA, [wrapEphemeralIx], {
      label: "wrapEncryptedTokens (to ephemeral ETA)",
    });
    await awaitComputationFinalization(rpc, wrapEphemeralOffset);

    // Verify balances before closing
    const regularBalanceBefore = await decryptEtaBalance(regularEtaAddress, keypair.secretKey);
    const ephemeralBalanceBefore = await decryptEtaBalance(ephemeralEtaAddress, keypair.secretKey);
    expect(regularBalanceBefore).to.equal(wrapAmountRegular);
    expect(ephemeralBalanceBefore).to.equal(wrapAmountEphemeral);

    // User A closes ephemeral ETA
    const closeOffset = randomComputationOffset();
    const closeIx = await closeEphemeralEncryptedTokenAccount(
      {
        signer: userA,
        tokenMint: mint.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        index: ephemeralIndex,
        rentRecipient: userB.address, // User B (who created it) gets the rent back
      },
      {
        clusterOffset: arciumEnv.arciumClusterOffset,
        computationOffset: closeOffset,
      },
    );

    await sendTransaction(rpc, sendAndConfirm, userA, [closeIx], {
      label: "closeEphemeralEncryptedTokenAccount",
    });
    await awaitComputationFinalization(rpc, closeOffset);

    // Verify regular ETA received the combined balance
    const regularBalanceAfter = await decryptEtaBalance(regularEtaAddress, keypair.secretKey);
    expect(regularBalanceAfter).to.equal(wrapAmountRegular + wrapAmountEphemeral);

    // Verify user B received the rent lamports back
    const userBBalanceAfterClose = await rpc.getBalance(userB.address).send();
    expect(userBBalanceAfterClose.value > userBBalanceAfterCreate.value).to.be.true;

    // Verify ephemeral ETA no longer exists
    const ephemeralEtaAfter = await rpc.getAccountInfo(ephemeralEtaAddress).send();
    expect(ephemeralEtaAfter.value).to.be.null;
  });
});
