import { Transaction } from "@meshsdk/core-cst";
import { describe, expect, it } from "vitest";
import {
  calculateFees,
  countNumberOfRequiredWitnesses,
  createDummyTx,
  referenceScriptFee,
} from "../../src/fees.js";
import {
  PROTOCOL_PARAMETERS,
  buildTx,
  lovelace,
  makeUtxo,
  poolWallet,
  toTxOut,
} from "./helpers.js";

const feeParams = {
  minFeeA: PROTOCOL_PARAMETERS.minFeeA,
  minFeeB: PROTOCOL_PARAMETERS.minFeeB,
  minFeeRefScriptCostPerByte: PROTOCOL_PARAMETERS.minFeeRefScriptCostPerByte,
  priceMem: PROTOCOL_PARAMETERS.priceMem,
  priceStep: PROTOCOL_PARAMETERS.priceStep,
};

describe("referenceScriptFee", () => {
  it("charges nothing when there are no reference scripts", () => {
    expect(referenceScriptFee(0, 15)).toBe(0);
  });

  it("charges the base price inside the first tier", () => {
    expect(referenceScriptFee(1000, 15)).toBe(15_000);
    expect(referenceScriptFee(25_600, 15)).toBe(384_000);
  });

  it("raises the price by 1.2x per tier, not by squaring the multiplier", () => {
    // One full tier at 15, then 400 bytes at 15 * 1.2.
    expect(referenceScriptFee(26_000, 15)).toBeCloseTo(25_600 * 15 + 400 * 18, 6);

    // Three tiers: 15, 18, 21.6, then the remainder at 25.92.
    const threeTiers = 25_600 * 15 + 25_600 * 18 + 25_600 * 21.6;
    expect(referenceScriptFee(3 * 25_600 + 100, 15)).toBeCloseTo(threeTiers + 100 * 25.92, 6);
  });

  it("grows monotonically across tier boundaries", () => {
    let previous = 0;
    for (let size = 0; size <= 120_000; size += 3_137) {
      const fee = referenceScriptFee(size, 15);
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
  });
});

describe("calculateFees", () => {
  const wallet = poolWallet();
  const tx = Transaction.fromCbor(
    buildTx(
      [makeUtxo(wallet.address, 10_000_000n)],
      [{ address: wallet.address, amount: lovelace(9_000_000n) }],
    ) as never,
  );

  it("charges minFeeB plus minFeeA per byte", () => {
    const sizeBytes = tx.toCbor().length / 2;
    expect(calculateFees(feeParams, tx)).toBe(
      BigInt(Math.ceil(feeParams.minFeeB + sizeBytes * feeParams.minFeeA)),
    );
  });

  it("returns a whole number of lovelace for fractional prices", () => {
    // A non-integer total used to make `BigInt()` throw outright.
    const fee = calculateFees({ ...feeParams, minFeeRefScriptCostPerByte: 15.7 }, tx, 1_234);
    expect(typeof fee).toBe("bigint");
    expect(fee).toBeGreaterThan(0n);
  });

  it("adds the reference script fee on top of the size fee", () => {
    const withoutRefScripts = calculateFees(feeParams, tx, 0);
    const withRefScripts = calculateFees(feeParams, tx, 5_000);
    expect(withRefScripts - withoutRefScripts).toBe(BigInt(5_000 * 15));
  });
});

describe("createDummyTx", () => {
  const wallet = poolWallet();
  const baseTx = Transaction.fromCbor(
    buildTx(
      [makeUtxo(wallet.address, 10_000_000n)],
      [{ address: wallet.address, amount: lovelace(9_000_000n) }],
    ) as never,
  );

  it("produces placeholder witnesses of the correct length past ten signers", () => {
    // Indices used to be stringified in decimal, so signer 10 got a 128-char
    // "public key" and the size estimate drifted.
    const dummy = createDummyTx(baseTx, baseTx.body(), 12);
    const vkeys = dummy.witnessSet().vkeys()?.values() ?? [];

    expect(vkeys).toHaveLength(12);
    for (const witness of vkeys) {
      expect(witness.vkey()).toHaveLength(64);
      expect(witness.signature()).toHaveLength(128);
    }
  });

  it("grows the serialized size with each extra witness", () => {
    const one = createDummyTx(baseTx, baseTx.body(), 1).toCbor().length;
    const twelve = createDummyTx(baseTx, baseTx.body(), 12).toCbor().length;
    expect(twelve).toBeGreaterThan(one);
  });
});

describe("countNumberOfRequiredWitnesses", () => {
  const wallet = poolWallet();

  it("counts one witness per distinct payment key, not per input", () => {
    const utxos = [
      makeUtxo(wallet.address, 5_000_000n, { seed: 1, index: 0 }),
      makeUtxo(wallet.address, 5_000_000n, { seed: 1, index: 1 }),
    ];
    const tx = Transaction.fromCbor(
      buildTx(utxos, [{ address: wallet.address, amount: lovelace(9_000_000n) }]) as never,
    );

    const context = new Map(
      utxos.map((utxo) => [
        `${utxo.input.txHash}#${utxo.input.outputIndex}`,
        toTxOut(utxo.output.address, utxo.output.amount),
      ]),
    );

    expect(countNumberOfRequiredWitnesses(tx.body(), context, [])).toBe(1);
  });

  it("keys inputs by value, so a re-deserialized body still resolves them", () => {
    const utxo = makeUtxo(wallet.address, 5_000_000n);
    const tx = Transaction.fromCbor(
      buildTx([utxo], [{ address: wallet.address, amount: lovelace(4_000_000n) }]) as never,
    );
    const context = new Map([
      [
        `${utxo.input.txHash}#${utxo.input.outputIndex}`,
        toTxOut(utxo.output.address, utxo.output.amount),
      ],
    ]);

    // A separate deserialization yields different input objects; identity-keyed
    // lookups used to miss them and under-count the required witnesses.
    const reparsed = Transaction.fromCbor(tx.toCbor());
    expect(countNumberOfRequiredWitnesses(reparsed.body(), context, [])).toBe(1);
  });

  it("counts nothing when no input resolves to a key-hash address", () => {
    const tx = Transaction.fromCbor(
      buildTx(
        [makeUtxo(wallet.address, 5_000_000n)],
        [{ address: wallet.address, amount: lovelace(4_000_000n) }],
      ) as never,
    );
    expect(countNumberOfRequiredWitnesses(tx.body(), new Map(), [])).toBe(0);
  });
});
