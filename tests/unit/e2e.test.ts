import { Transaction } from "@meshsdk/core-cst";
import { afterEach, describe, expect, it } from "vitest";
import { GaslessClient } from "../../src/client.js";
import { Gasless } from "../../src/index.js";
import type { PoolServer } from "../../src/types.js";
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

const newPool = (provider: StubProvider, conditions = {}) =>
  new Gasless({
    mode: "pool",
    provider,
    wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
    conditions,
  });

describe("sponsor -> validate -> sign, end to end", () => {
  let server: PoolServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const scenario = async (conditions = {}) => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const poolUtxo = makeUtxo(pool.address, 20_000_000n, { seed: 2 });
    const provider = new StubProvider([userUtxo, poolUtxo]);

    const gaslessPool = newPool(provider, conditions);
    const sponsor = new GaslessClient({ provider });

    const unsignedTx = buildTx(
      [userUtxo],
      [
        { address: pool.address, amount: lovelace(1_000_000n) },
        { address: user.address, amount: lovelace(9_000_000n) },
      ],
    );

    return { provider, gaslessPool, sponsor, unsignedTx };
  };

  it("sponsors a transaction so the user pays nothing", async () => {
    const { gaslessPool, unsignedTx } = await scenario();

    const sponsoredCbor = await gaslessPool.sponsorTx({
      txCbor: unsignedTx,
      poolId: pool.address,
      utxo: { txHash: "02".repeat(32), outputIndex: 0 },
    });

    const before = Transaction.fromCbor(unsignedTx as never);
    const after = Transaction.fromCbor(sponsoredCbor as never);

    expect(after.body().fee()).toBeGreaterThan(0n);
    expect(after.body().inputs().values()).toHaveLength(before.body().inputs().values().length + 1);

    // Every original output survives untouched: the fee comes out of the pool.
    for (const [index, output] of before.body().outputs().entries()) {
      expect(after.body().outputs()[index]?.toCbor()).toBe(output.toCbor());
    }

    const poolChange = after
      .body()
      .outputs()
      .find((output, index) => index >= before.body().outputs().length);
    expect(poolChange?.amount().coin()).toBe(20_000_000n - after.body().fee());
  });

  it("requires the pool signature so the transaction cannot be submitted without it", async () => {
    const { gaslessPool, unsignedTx } = await scenario();
    const sponsored = await gaslessPool.sponsorTx({ txCbor: unsignedTx, poolId: pool.address });
    const signers =
      Transaction.fromCbor(sponsored as never)
        .body()
        .requiredSigners()
        ?.values() ?? [];

    expect(signers.map((signer) => signer.toCore())).toContain(pool.paymentKeyHash);
  });

  it("runs the whole round trip through a live pool server", async () => {
    const { gaslessPool, sponsor, unsignedTx } = await scenario({ whitelist: [user.address] });
    server = await gaslessPool.listen({ port: 0 });

    const sponsored = await gaslessPool.sponsorTx({ txCbor: unsignedTx, poolId: pool.address });
    const signed = await sponsor.validateTx({ txCbor: sponsored, poolSignServer: server.url });

    const witnesses =
      Transaction.fromCbor(signed as never)
        .witnessSet()
        .vkeys()
        ?.values() ?? [];
    expect(witnesses).toHaveLength(1);
    // The body must be untouched by signing, or the user's own signature breaks.
    expect(
      Transaction.fromCbor(signed as never)
        .body()
        .toCbor(),
    ).toBe(
      Transaction.fromCbor(sponsored as never)
        .body()
        .toCbor(),
    );
  });

  it("refuses to sign a transaction that fails the pool's conditions", async () => {
    const { gaslessPool, sponsor, unsignedTx } = await scenario({
      whitelist: ["addr_test1vqeux7xwusdju9dvsj8h7mca9aup2k649xvpz9d3l0j4fzs5plnwl"],
    });
    server = await gaslessPool.listen({ port: 0 });

    const sponsored = await gaslessPool.sponsorTx({ txCbor: unsignedTx, poolId: pool.address });

    await expect(
      sponsor.validateTx({ txCbor: sponsored, poolSignServer: server.url }),
    ).rejects.toThrow(/whitelist/i);

    // And the server refuses too, even when a client skips its own checks.
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txCbor: sponsored }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "AddressNotWhitelisted" },
    });
  });

  it("refuses to sign when the pool's change output has been skimmed", async () => {
    const { gaslessPool, unsignedTx } = await scenario();

    const sponsored = Transaction.fromCbor(
      (await gaslessPool.sponsorTx({ txCbor: unsignedTx, poolId: pool.address })) as never,
    );

    // Skim 5 ADA off the pool's change and pocket it. The user pays the pool
    // 1 ADA in this transaction, so the pool ends up 4 ADA down on top of the
    // fee — exactly the leak the check exists to catch.
    const body = sponsored.body();
    const outputs = body.outputs();
    const changeIndex = outputs.length - 1;
    const change = outputs[changeIndex];
    if (!change) throw new Error("expected a pool change output");

    outputs[changeIndex] = toTxOut(pool.address, lovelace(change.amount().coin() - 5_000_000n));
    body.setOutputs(outputs);

    const tampered = new Transaction(
      body,
      sponsored.witnessSet(),
      sponsored.auxiliaryData(),
    ).toCbor();

    await expect(gaslessPool.validateAndSign(tampered)).rejects.toMatchObject({
      code: "FeeMismatch",
    });
  });
});

describe("pool server lifecycle", () => {
  it("resolves only once it is listening, and closes cleanly", async () => {
    const gaslessPool = newPool(new StubProvider());
    const server = await gaslessPool.listen({ port: 0 });

    expect(server.port).toBeGreaterThan(0);
    const info = await (await fetch(`${server.url}/conditions`)).json();
    expect(info).toMatchObject({ address: pool.address, paymentKeyHash: pool.paymentKeyHash });

    await server.close();
    await expect(fetch(`${server.url}/conditions`)).rejects.toThrow();
  });

  it("reports a clear error instead of hanging when the port is taken", async () => {
    const first = newPool(new StubProvider());
    const server = await first.listen({ port: 0 });

    const second = newPool(new StubProvider());
    await expect(second.listen({ port: server.port })).rejects.toThrow(/could not start/i);

    await server.close();
  });

  it("rejects a malformed request body", async () => {
    const gaslessPool = newPool(new StubProvider());
    const server = await gaslessPool.listen({ port: 0 });

    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "InvalidInput" } });

    await server.close();
  });

  it("refuses to run a server in sponsor mode", async () => {
    const sponsor = new Gasless({ mode: "sponsor", provider: new StubProvider() });
    await expect(sponsor.listen({ port: 0 })).rejects.toMatchObject({ code: "InvalidMode" });
  });
});
