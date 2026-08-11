import {
  Ed25519KeyHashHex,
  Hash28ByteBase16,
  NativeScript,
  ScriptPubkey,
  Serialization,
  Transaction,
  TransactionId,
  TransactionInput,
  buildEnterpriseAddress,
  buildRewardAddress,
  deserializeAddress,
} from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it } from "vitest";
import { Gasless } from "../../src/index.js";
import { FeeBudget, resolvePolicy } from "../../src/policy.js";
import type { PoolConditions, UTxO } from "../../src/types.js";
import {
  POOL_MNEMONIC,
  StubProvider,
  buildTx,
  lovelace,
  makeUtxo,
  poolWallet,
  toTxOut,
  userWallet,
} from "./helpers.js";

const pool = poolWallet();
const user = userWallet();

const inputSetOf = (utxos: UTxO[]) => {
  const set = Serialization.CborSet.fromCore([], TransactionInput.fromCore);
  set.setValues(
    utxos.map(
      (utxo) =>
        new TransactionInput(TransactionId(utxo.input.txHash), BigInt(utxo.input.outputIndex)),
    ),
  );
  return set;
};

/** A pool, a funded user, and a correctly sponsored transaction to tamper with. */
const scenario = async (conditions: PoolConditions = {}) => {
  const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
  const poolUtxo = makeUtxo(pool.address, 20_000_000n, { seed: 2 });
  const poolFatUtxo = makeUtxo(pool.address, 500_000_000n, { seed: 3 });
  const userCollateral = makeUtxo(user.address, 5_000_000n, { seed: 4 });
  const provider = new StubProvider([userUtxo, poolUtxo, poolFatUtxo, userCollateral]);

  const gasless = new Gasless({
    mode: "pool",
    provider,
    wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
    conditions,
  });

  const unsigned = buildTx([userUtxo], [{ address: user.address, amount: lovelace(10_000_000n) }]);
  const sponsored = await gasless.sponsorTx({
    txCbor: unsigned,
    poolId: pool.address,
    utxo: poolUtxo.input,
  });

  return { gasless, provider, sponsored, poolFatUtxo, userCollateral };
};

const rebuild = (sponsored: string, mutate: (body: Serialization.TransactionBody) => void) => {
  const tx = Transaction.fromCbor(sponsored as never);
  const body = tx.body();
  mutate(body);
  return new Transaction(body, tx.witnessSet(), tx.auxiliaryData()).toCbor();
};

describe("collateral", () => {
  it("refuses a transaction backing collateral with pool funds", async () => {
    const { gasless, sponsored, poolFatUtxo } = await scenario();

    // Collateral is forfeited whole on a phase-2 failure, and never appears in
    // the input/output accounting — so this used to sail through unnoticed.
    const tampered = rebuild(sponsored, (body) => body.setCollateral(inputSetOf([poolFatUtxo])));

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "PoolCollateralForbidden",
    });
    await expect(gasless.validateAndSign(tampered)).rejects.toThrow(/500000000 lovelace/);
  });

  it("accepts collateral the requester funds themselves", async () => {
    const { gasless, sponsored, userCollateral } = await scenario();
    const tampered = rebuild(sponsored, (body) => body.setCollateral(inputSetOf([userCollateral])));

    await expect(gasless.validateAndSign(tampered)).resolves.toBeTypeOf("string");
  });

  it("allows pool collateral when the operator opts in", async () => {
    const { gasless, sponsored, poolFatUtxo } = await scenario({
      policy: { allowPoolCollateral: true },
    });
    const tampered = rebuild(sponsored, (body) => body.setCollateral(inputSetOf([poolFatUtxo])));

    await expect(gasless.validateAndSign(tampered)).resolves.toBeTypeOf("string");
  });

  it("refuses to send the unspent remainder of pool collateral elsewhere", async () => {
    // Opting into pool collateral accepts losing `totalCollateral` on failure,
    // not the rest: the remainder goes to collateralReturn, so pointing that at
    // the attacker turns a 5 ADA risk into a 500 ADA one.
    const { gasless, sponsored, poolFatUtxo } = await scenario({
      policy: { allowPoolCollateral: true },
    });

    const tampered = rebuild(sponsored, (body) => {
      body.setCollateral(inputSetOf([poolFatUtxo]));
      body.setTotalCollateral(5_000_000n);
      body.setCollateralReturn(toTxOut(user.address, lovelace(495_000_000n)));
    });

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "PoolCollateralForbidden",
    });
  });

  it("accepts collateral change returning to the pool", async () => {
    const { gasless, sponsored, poolFatUtxo } = await scenario({
      policy: { allowPoolCollateral: true },
    });

    const tampered = rebuild(sponsored, (body) => {
      body.setCollateral(inputSetOf([poolFatUtxo]));
      body.setTotalCollateral(5_000_000n);
      body.setCollateralReturn(toTxOut(pool.address, lovelace(495_000_000n)));
    });

    await expect(gasless.validateAndSign(tampered)).resolves.toBeTypeOf("string");
  });

  it("charges for the witness a collateral input will need", async () => {
    // Collateral inputs carry their own vkey witnesses. Leaving them out of
    // the witness count under-estimates the size, and so the fee, and the node
    // then refuses the transaction the pool just paid to assemble.
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 20_000_000n, { seed: 2 });
    const thirdParty = buildEnterpriseAddress(0, Hash28ByteBase16("ab".repeat(28)))
      .toAddress()
      .toBech32();
    const otherCollateral = makeUtxo(thirdParty, 5_000_000n, { seed: 7 });
    const provider = new StubProvider([userUtxo, poolUtxo, otherCollateral]);

    const gasless = new Gasless({
      mode: "pool",
      provider,
      wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
      conditions: {},
    });

    const plain = buildTx([userUtxo], [{ address: user.address, amount: lovelace(10_000_000n) }]);
    const withCollateral = rebuild(plain, (body) =>
      body.setCollateral(inputSetOf([otherCollateral])),
    );

    const feeOf = async (txCbor: string) =>
      Transaction.fromCbor(
        (await gasless.sponsorTx({
          txCbor,
          poolId: pool.address,
          utxo: poolUtxo.input,
        })) as never,
      )
        .body()
        .fee();

    // The collateral signer is a third distinct key, so its witness must show
    // up in the estimate as extra size.
    expect(await feeOf(withCollateral)).toBeGreaterThan(await feeOf(plain));
  });

  it("bounds how many collateral inputs it will resolve", async () => {
    const { gasless, sponsored, poolFatUtxo, userCollateral } = await scenario({
      policy: { maxCollateralInputs: 1 },
    });
    const tampered = rebuild(sponsored, (body) =>
      body.setCollateral(inputSetOf([userCollateral, poolFatUtxo])),
    );

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "TooManyInputs",
    });
  });
});

describe("scripts gated on the pool key", () => {
  const poolPolicyScript = () =>
    NativeScript.newScriptPubkey(new ScriptPubkey(Ed25519KeyHashHex(pool.paymentKeyHash)));

  it("refuses to mint under a policy that only the pool's key controls", async () => {
    const { gasless, sponsored } = await scenario({ policy: { allowMint: true } });

    const script = poolPolicyScript();
    const tx = Transaction.fromCbor(sponsored as never);
    const body = tx.body();
    body.setMint(new Map([[`${script.hash()}` as never, 1_000_000n]]) as never);

    const witnessSet = tx.witnessSet();
    witnessSet.setNativeScripts(Serialization.CborSet.fromCore([], NativeScript.fromCore));
    witnessSet.nativeScripts()?.setValues([script]);

    const tampered = new Transaction(body, witnessSet, tx.auxiliaryData()).toCbor();

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
    await expect(gasless.validateAndSign(tampered)).rejects.toThrow(/native script/i);
  });

  it("refuses a pool-key script parked on-chain as a reference script", async () => {
    // Checking only the witness set is not enough: the ledger accepts a script
    // supplied by a `scriptRef` on a reference input, so an attacker can park
    // it on-chain and merely point at it.
    const { gasless, provider, sponsored } = await scenario({ policy: { allowMint: true } });

    const script = poolPolicyScript();
    const refUtxo = makeUtxo(user.address, 2_000_000n, { seed: 9 });
    refUtxo.output.scriptRef = script.toCbor().toString();
    provider.add(refUtxo);

    const tampered = rebuild(sponsored, (body) => {
      body.setReferenceInputs(inputSetOf([refUtxo]));
      body.setMint(new Map([[`${script.hash()}` as never, 1_000_000n]]) as never);
    });

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
  });

  it("permits a native script that does not involve the pool's key", async () => {
    const { gasless, sponsored } = await scenario();

    const script = NativeScript.newScriptPubkey(
      new ScriptPubkey(Ed25519KeyHashHex("ab".repeat(28))),
    );
    const tx = Transaction.fromCbor(sponsored as never);
    const witnessSet = tx.witnessSet();
    witnessSet.setNativeScripts(Serialization.CborSet.fromCore([], NativeScript.fromCore));
    witnessSet.nativeScripts()?.setValues([script]);

    const tampered = new Transaction(tx.body(), witnessSet, tx.auxiliaryData()).toCbor();
    await expect(gasless.validateAndSign(tampered)).resolves.toBeTypeOf("string");
  });
});

describe("body fields the pool has not opted into", () => {
  it("refuses a mint by default", async () => {
    const { gasless, sponsored } = await scenario();
    const tampered = rebuild(sponsored, (body) =>
      body.setMint(new Map([[`${"cd".repeat(28)}` as never, 5n]]) as never),
    );

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
  });

  it("refuses a withdrawal by default", async () => {
    const { gasless, sponsored } = await scenario();
    const rewardAccount = buildRewardAddress(
      0,
      Hash28ByteBase16(deserializeAddress(pool.address).getProps().delegationPart?.hash ?? ""),
    )
      .toAddress()
      .toBech32();

    const tampered = rebuild(sponsored, (body) =>
      body.setWithdrawals(new Map([[rewardAccount as never, 1_000n]])),
    );

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
  });

  it("refuses a treasury donation by default", async () => {
    const { gasless, sponsored } = await scenario();
    const tampered = rebuild(sponsored, (body) => body.setDonation(1_000_000n));

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
  });

  it("refuses a protocol parameter update by default", async () => {
    const { gasless, sponsored } = await scenario();
    const tampered = rebuild(sponsored, (body) =>
      body.setUpdate(
        Serialization.Update.fromCore({
          epoch: 999 as never,
          proposedProtocolParameterUpdates: new Map(),
        }),
      ),
    );

    await expect(gasless.validateAndSign(tampered)).rejects.toMatchObject({
      code: "UnsupportedTransactionField",
    });
  });

  it("names the flag that would allow the feature", async () => {
    const { gasless, sponsored } = await scenario();
    const tampered = rebuild(sponsored, (body) =>
      body.setMint(new Map([[`${"cd".repeat(28)}` as never, 5n]]) as never),
    );

    await expect(gasless.validateAndSign(tampered)).rejects.toThrow(/policy\.allowMint/);
  });

  it("still sponsors an ordinary payment", async () => {
    const { gasless, sponsored } = await scenario();
    await expect(gasless.validateAndSign(sponsored)).resolves.toBeTypeOf("string");
  });
});

describe("size and cost limits", () => {
  it("refuses a transaction with more inputs than the pool allows", async () => {
    const { gasless, sponsored } = await scenario({ policy: { maxInputs: 1 } });

    await expect(gasless.validateAndSign(sponsored)).rejects.toMatchObject({
      code: "TooManyInputs",
    });
  });

  it("refuses a fee above the per-transaction cap", async () => {
    const { gasless, sponsored } = await scenario({ policy: { maxFeeLovelace: 1n } });

    await expect(gasless.validateAndSign(sponsored)).rejects.toMatchObject({ code: "FeeTooHigh" });
  });

  it("refuses payments to a blocked address", async () => {
    const { gasless, sponsored } = await scenario({
      policy: { blockedAddresses: [user.address] },
    });

    await expect(gasless.validateAndSign(sponsored)).rejects.toMatchObject({
      code: "AddressNotWhitelisted",
    });
  });
});

describe("FeeBudget", () => {
  let budget: FeeBudget;

  beforeEach(() => {
    budget = new FeeBudget({ windowMs: 1_000, maxLovelace: 1_000_000n });
  });

  it("allows spending up to the cap", () => {
    budget.charge(600_000n, 0);
    budget.charge(400_000n, 100);
    expect(budget.spent(200)).toBe(1_000_000n);
  });

  it("refuses the charge that would breach the cap", () => {
    budget.charge(900_000n, 0);
    expect(() => budget.charge(200_000n, 100)).toThrow(/budget/i);
    // The refused charge must not be recorded.
    expect(budget.spent(100)).toBe(900_000n);
  });

  it("frees budget once the window rolls past", () => {
    budget.charge(1_000_000n, 0);
    expect(() => budget.charge(1n, 500)).toThrow();
    expect(() => budget.charge(1_000_000n, 1_001)).not.toThrow();
  });

  it("stops the pool signing once its budget is exhausted", async () => {
    const { gasless, sponsored } = await scenario({
      policy: { feeBudget: { windowMs: 60_000, maxLovelace: 1n } },
    });

    await expect(gasless.validateAndSign(sponsored)).rejects.toMatchObject({ code: "FeeTooHigh" });
  });
});

describe("resolvePolicy", () => {
  it("refuses everything unusual by default", () => {
    const policy = resolvePolicy(undefined);
    expect(policy.allowMint).toBe(false);
    expect(policy.allowCertificates).toBe(false);
    expect(policy.allowWithdrawals).toBe(false);
    expect(policy.allowGovernance).toBe(false);
    expect(policy.allowPoolCollateral).toBe(false);
    expect(policy.allowPoolKeyScripts).toBe(false);
  });

  it("leaves ordinary script traffic enabled", () => {
    const policy = resolvePolicy(undefined);
    expect(policy.allowPlutusScripts).toBe(true);
    expect(policy.allowReferenceInputs).toBe(true);
  });

  it("lets an operator override a single flag without losing the rest", () => {
    const policy = resolvePolicy({ allowMint: true });
    expect(policy.allowMint).toBe(true);
    expect(policy.allowCertificates).toBe(false);
    expect(policy.maxInputs).toBe(50);
  });
});
