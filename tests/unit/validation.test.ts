import {
  Hash28ByteBase16,
  Transaction,
  buildBaseAddress,
  deserializeAddress,
} from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it } from "vitest";
import { GaslessCore } from "../../src/core.js";
import { ValidationError } from "../../src/errors.js";
import { StubProvider, buildTx, lovelace, makeUtxo, poolWallet, userWallet } from "./helpers.js";

const pool = poolWallet();
const user = userWallet();
const poolOf = { address: pool.address, paymentKeyHash: pool.paymentKeyHash };

const TOKEN = "d9312da562da182b02322fd8acb536f37eb9d29fbf5e0f7c5d67d5b1746573746f6b656e";

describe("pool value accounting", () => {
  let provider: StubProvider;
  let core: GaslessCore;

  beforeEach(() => {
    provider = new StubProvider();
    core = new GaslessCore({ provider });
  });

  /** A sponsored transaction: pool input in, pool change out, fee in between. */
  const sponsoredTx = async (fee: bigint, poolChange: bigint, poolIn = 5_000_000n) => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, poolIn, { seed: 2 });
    provider.add(userUtxo).add(poolUtxo);

    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo, poolUtxo],
        [
          { address: user.address, amount: lovelace(10_000_000n) },
          { address: pool.address, amount: lovelace(poolChange) },
        ],
        fee,
      ) as never,
    );
    return { tx, resolved: await core.resolveInputs(tx) };
  };

  it("accepts a transaction where the pool pays exactly the fee", async () => {
    const { tx, resolved } = await sponsoredTx(200_000n, 4_800_000n);
    await expect(core.validateConditions(tx, resolved, poolOf)).resolves.toBeUndefined();
  });

  it("rejects a transaction that takes more from the pool than the fee", async () => {
    const { tx, resolved } = await sponsoredTx(200_000n, 3_000_000n);
    await expect(core.validateConditions(tx, resolved, poolOf)).rejects.toThrow(ValidationError);
  });

  it("rejects a transaction with no pool input at all", async () => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    provider.add(userUtxo);
    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo],
        [{ address: user.address, amount: lovelace(9_800_000n) }],
        200_000n,
      ) as never,
    );

    await expect(
      core.validateConditions(tx, await core.resolveInputs(tx), poolOf),
    ).rejects.toMatchObject({ code: "PoolOutputMismatch" });
  });

  it("does not credit change sent to the pool key under a foreign stake credential", async () => {
    // Same payment key as the pool, but the user's stake key. The pool could
    // still spend it, yet its staking rewards would silently move elsewhere —
    // matching on the payment credential alone would wave this through.
    const hijacked = buildBaseAddress(
      0,
      Hash28ByteBase16(pool.paymentKeyHash),
      Hash28ByteBase16(deserializeAddress(user.address).getProps().delegationPart?.hash ?? ""),
    )
      .toAddress()
      .toBech32();

    expect(hijacked).not.toBe(pool.address);

    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 5_000_000n, { seed: 2 });
    provider.add(userUtxo).add(poolUtxo);

    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo, poolUtxo],
        [
          { address: user.address, amount: lovelace(10_000_000n) },
          { address: hijacked, amount: lovelace(4_800_000n) },
        ],
        200_000n,
      ) as never,
    );

    expect(core.producedForPool(tx, pool.address)).toHaveLength(0);
    await expect(
      core.validateConditions(tx, await core.resolveInputs(tx), poolOf),
    ).rejects.toMatchObject({ code: "FeeMismatch" });
  });

  it("rejects a transaction that walks off with the pool's native assets", async () => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 5_000_000n, { seed: 2, assets: { [TOKEN]: 42n } });
    provider.add(userUtxo).add(poolUtxo);

    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo, poolUtxo],
        [
          { address: user.address, amount: lovelace(10_000_000n) },
          { address: pool.address, amount: lovelace(4_800_000n) },
        ],
        200_000n,
      ) as never,
    );

    await expect(
      core.validateConditions(tx, await core.resolveInputs(tx), poolOf),
    ).rejects.toMatchObject({ code: "AssetMismatch" });
  });

  it("resolves each input exactly once, however many rules run", async () => {
    core.setConditions({ whitelist: [user.address] });
    const { tx, resolved } = await sponsoredTx(200_000n, 4_800_000n);

    const before = provider.calls.fetchUTxOs;
    await core.validateConditions(tx, resolved, poolOf);
    // Rules read the already-resolved inputs; only address lookups may follow.
    expect(provider.calls.fetchUTxOs).toBe(before);
  });
});

describe("pool conditions", () => {
  let provider: StubProvider;
  let core: GaslessCore;

  const validSponsoredTx = async () => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 5_000_000n, { seed: 2 });
    provider.add(userUtxo).add(poolUtxo);

    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo, poolUtxo],
        [
          { address: user.address, amount: lovelace(10_000_000n) },
          { address: pool.address, amount: lovelace(4_800_000n) },
        ],
        200_000n,
      ) as never,
    );
    return { tx, resolved: await core.resolveInputs(tx) };
  };

  beforeEach(() => {
    provider = new StubProvider();
    core = new GaslessCore({ provider });
  });

  it("accepts a whitelisted input address", async () => {
    core.setConditions({ whitelist: [user.address] });
    const { tx, resolved } = await validSponsoredTx();
    await expect(core.validateConditions(tx, resolved, poolOf)).resolves.toBeUndefined();
  });

  /**
   * The regression that matters most: these checks used to be invoked without
   * `await`, so a rejected whitelist became an unhandled promise rejection and
   * the pool signed anyway.
   */
  it("rejects an input address that is not whitelisted", async () => {
    core.setConditions({
      whitelist: ["addr_test1vqeux7xwusdju9dvsj8h7mca9aup2k649xvpz9d3l0j4fzs5plnwl"],
    });
    const { tx, resolved } = await validSponsoredTx();

    await expect(core.validateConditions(tx, resolved, poolOf)).rejects.toMatchObject({
      code: "AddressNotWhitelisted",
    });
  });

  it("accepts an address holding enough of a required token", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 10, comparison: "gte" }] });
    const { tx, resolved } = await validSponsoredTx();
    provider.add(makeUtxo(user.address, 2_000_000n, { seed: 3, assets: { [TOKEN]: 25n } }));

    await expect(core.validateConditions(tx, resolved, poolOf)).resolves.toBeUndefined();
  });

  it("rejects an address holding too little of a required token", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 100, comparison: "gte" }] });
    const { tx, resolved } = await validSponsoredTx();
    provider.add(makeUtxo(user.address, 2_000_000n, { seed: 3, assets: { [TOKEN]: 5n } }));

    await expect(core.validateConditions(tx, resolved, poolOf)).rejects.toMatchObject({
      code: "TokenRequirementNotMet",
    });
  });

  it("passes when any one of several requirements is met", async () => {
    core.setConditions({
      tokenRequirements: [
        { unit: TOKEN, quantity: 1_000, comparison: "gte" },
        { unit: "lovelace", quantity: 1_000_000, comparison: "gte" },
      ],
    });
    const { tx, resolved } = await validSponsoredTx();

    await expect(core.validateConditions(tx, resolved, poolOf)).resolves.toBeUndefined();
  });

  it("ignores the pool's own holdings when checking requirements", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 1, comparison: "gte" }] });
    const { tx, resolved } = await validSponsoredTx();
    // Only the pool holds the token; the user must qualify on their own.
    provider.add(makeUtxo(pool.address, 2_000_000n, { seed: 4, assets: { [TOKEN]: 500n } }));

    await expect(core.validateConditions(tx, resolved, poolOf)).rejects.toMatchObject({
      code: "TokenRequirementNotMet",
    });
  });
});
