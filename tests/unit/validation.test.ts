import {
  Hash28ByteBase16,
  Transaction,
  buildBaseAddress,
  buildEnterpriseAddress,
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
    return { tx };
  };

  it("accepts a transaction where the pool pays exactly the fee", async () => {
    const { tx } = await sponsoredTx(200_000n, 4_800_000n);
    await expect(core.validateConditions(tx, poolOf)).resolves.toBeUndefined();
  });

  it("rejects a transaction that takes more from the pool than the fee", async () => {
    const { tx } = await sponsoredTx(200_000n, 3_000_000n);
    await expect(core.validateConditions(tx, poolOf)).rejects.toThrow(ValidationError);
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

    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "PoolOutputMismatch",
    });
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

    expect(core.producedForPool(tx, poolOf)).toHaveLength(0);
    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "FeeMismatch",
    });
  });

  it("credits change to the pool's enterprise address", async () => {
    // Same payment key, no stake credential at all. The pool controls it and
    // no rewards are redirected, so refusing it — as a strict full-address
    // match did — would strand any pool holding funds there.
    const enterprise = buildEnterpriseAddress(0, Hash28ByteBase16(pool.paymentKeyHash))
      .toAddress()
      .toBech32();

    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 5_000_000n, { seed: 2 });
    provider.add(userUtxo).add(poolUtxo);

    const tx = Transaction.fromCbor(
      buildTx(
        [userUtxo, poolUtxo],
        [
          { address: user.address, amount: lovelace(10_000_000n) },
          { address: enterprise, amount: lovelace(4_800_000n) },
        ],
        200_000n,
      ) as never,
    );

    expect(core.producedForPool(tx, poolOf)).toHaveLength(1);
    await expect(core.validateConditions(tx, poolOf)).resolves.toBeUndefined();
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

    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "AssetMismatch",
    });
  });

  it("resolves each input exactly once, however many rules run", async () => {
    core.setConditions({ whitelist: [user.address] });
    const { tx } = await sponsoredTx(200_000n, 4_800_000n);

    provider.calls.fetchUTxOs = 0;
    await core.validateConditions(tx, poolOf);

    // Two inputs, one lookup each: every rule reads the same resolved set
    // rather than refetching, as three separate passes used to.
    expect(provider.calls.fetchUTxOs).toBe(2);
  });

  it("enforces the input cap before it spends any chain lookups", async () => {
    // `maxInputs` exists to bound provider calls, so it has to be checked
    // before the inputs are resolved — otherwise the I/O it guards against has
    // already happened by the time the limit is consulted.
    core.setConditions({ policy: { maxInputs: 1 } });
    const { tx } = await sponsoredTx(200_000n, 4_800_000n);

    provider.calls.fetchUTxOs = 0;
    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "TooManyInputs",
    });
    expect(provider.calls.fetchUTxOs).toBe(0);
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
    return { tx };
  };

  beforeEach(() => {
    provider = new StubProvider();
    core = new GaslessCore({ provider });
  });

  it("accepts a whitelisted input address", async () => {
    core.setConditions({ whitelist: [user.address] });
    const { tx } = await validSponsoredTx();
    await expect(core.validateConditions(tx, poolOf)).resolves.toBeUndefined();
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
    const { tx } = await validSponsoredTx();

    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "AddressNotWhitelisted",
    });
  });

  it("accepts an address holding enough of a required token", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 10, comparison: "gte" }] });
    const { tx } = await validSponsoredTx();
    provider.add(makeUtxo(user.address, 2_000_000n, { seed: 3, assets: { [TOKEN]: 25n } }));

    await expect(core.validateConditions(tx, poolOf)).resolves.toBeUndefined();
  });

  it("rejects an address holding too little of a required token", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 100, comparison: "gte" }] });
    const { tx } = await validSponsoredTx();
    provider.add(makeUtxo(user.address, 2_000_000n, { seed: 3, assets: { [TOKEN]: 5n } }));

    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
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
    const { tx } = await validSponsoredTx();

    await expect(core.validateConditions(tx, poolOf)).resolves.toBeUndefined();
  });

  it("ignores the pool's own holdings when checking requirements", async () => {
    core.setConditions({ tokenRequirements: [{ unit: TOKEN, quantity: 1, comparison: "gte" }] });
    const { tx } = await validSponsoredTx();
    // Only the pool holds the token; the user must qualify on their own.
    provider.add(makeUtxo(pool.address, 2_000_000n, { seed: 4, assets: { [TOKEN]: 500n } }));

    await expect(core.validateConditions(tx, poolOf)).rejects.toMatchObject({
      code: "TokenRequirementNotMet",
    });
  });
});
