import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { 
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID
} from "@solana/spl-token";

// POC #5: Missing signer seeds in CPI (withdraw fails)

describe("POC #5 - Missing Signer Seeds in CPI", () => {
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

    const oracle = anchor.web3.Keypair.generate();
    await program.methods
      .createOracle(new anchor.BN(1_000_000))
      .accounts({ oracle: oracle.publicKey, signer: admin.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin, oracle])
      .rpc();

    const marketId = new anchor.BN(4);
    [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const vaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, admin, supplyMint, marketPDA, true);
    vault = vaultAccount.address;
    await mintTo(provider.connection, admin, supplyMint, vault, admin.publicKey, 1_000_000);

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

    const attackerTokenAccountInfo = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, attacker.publicKey);
    const attackerTokenAccount = attackerTokenAccountInfo.address;
    await mintTo(provider.connection, admin, supplyMint, attackerTokenAccount, admin.publicKey, 1000);

    const [userSupplyPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_supply"), attacker.publicKey.toBuffer(), marketPDA.toBuffer()],
      program.programId
    );

    await program.methods
      .supply(new anchor.BN(500))
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
  });

  it("Withdraw fails due to missing PDA signer seeds", async () => {
    const [userSupplyPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_supply"), attacker.publicKey.toBuffer(), marketPDA.toBuffer()],
      program.programId
    );

    const attackerTokenAccountInfo = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, attacker.publicKey);
    const attackerTokenAccount = attackerTokenAccountInfo.address;

    try {
      await program.methods
        .withdraw(new anchor.BN(100))
        .accounts({
          market: marketPDA,
          userSupplyAccount: userSupplyPDA,
          userTokenAccount: attackerTokenAccount,
          vault,
          user: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([attacker])
        .rpc();
      throw new Error("Expected withdraw to fail");
    } catch (e) {
      // Expected: Missing CpiContext signer seeds
    }
  });
});
