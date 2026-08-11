import { Transaction } from "@meshsdk/core-cst";
import { afterEach, describe, expect, it } from "vitest";
import { Gasless } from "../../src/index.js";
import type { PoolServer } from "../../src/types.js";
import {
  POOL_MNEMONIC,
  StubProvider,
  buildTx,
  lovelace,
  makeUtxo,
  poolWallet,
  userWallet,
} from "./helpers.js";

const pool = poolWallet();
const user = userWallet();

const sponsorInputOf = (txCbor: string) => {
  const inputs = Transaction.fromCbor(txCbor as never)
    .body()
    .inputs()
    .values();
  const last = inputs[inputs.length - 1];
  return `${last?.transactionId()}#${last?.index()}`;
};

describe("pool UTxO reservation", () => {
  const threePoolUtxos = () => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const provider = new StubProvider([
      userUtxo,
      makeUtxo(pool.address, 20_000_000n, { seed: 2 }),
      makeUtxo(pool.address, 19_000_000n, { seed: 3 }),
      makeUtxo(pool.address, 18_000_000n, { seed: 4 }),
    ]);

    const gasless = new Gasless({
      mode: "pool",
      provider,
      wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
      conditions: {},
    });

    const unsigned = buildTx(
      [userUtxo],
      [{ address: user.address, amount: lovelace(10_000_000n) }],
    );
    return { gasless, unsigned };
  };

  it("gives concurrent requests different pool UTxOs", async () => {
    const { gasless, unsigned } = threePoolUtxos();

    const sponsored = await Promise.all([
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
    ]);

    // Every request used to take the largest UTxO, so all three transactions
    // double-spent it and only one could ever land.
    const used = new Set(sponsored.map(sponsorInputOf));
    expect(used.size).toBe(3);
  });

  it("reports a clear error once every UTxO is spoken for", async () => {
    const { gasless, unsigned } = threePoolUtxos();

    await Promise.all([
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
      gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address }),
    ]);

    await expect(gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address })).rejects.toThrow(
      /reserved by an in-flight sponsorship/i,
    );
  });

  it("frees a UTxO when the caller releases it", async () => {
    const { gasless, unsigned } = threePoolUtxos();

    const first = await gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address });
    const [txHash, index] = sponsorInputOf(first).split("#");
    gasless.releaseUtxo({ txHash: txHash as string, outputIndex: Number(index) });

    // With the largest UTxO free again, the next request picks it back up.
    const second = await gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address });
    expect(sponsorInputOf(second)).toBe(sponsorInputOf(first));
  });

  it("lets reservations lapse so an abandoned attempt does not strand funds", async () => {
    const userUtxo = makeUtxo(user.address, 10_000_000n, { seed: 1 });
    const provider = new StubProvider([userUtxo, makeUtxo(pool.address, 20_000_000n, { seed: 2 })]);

    const gasless = new Gasless({
      mode: "pool",
      provider,
      wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
      conditions: {},
      reservationMs: 0,
    });

    const unsigned = buildTx(
      [userUtxo],
      [{ address: user.address, amount: lovelace(10_000_000n) }],
    );
    await gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address });

    await expect(gasless.sponsorTx({ txCbor: unsigned, poolId: pool.address })).resolves.toBeTypeOf(
      "string",
    );
  });
});

describe("server request controls", () => {
  let server: PoolServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const newPool = () =>
    new Gasless({
      mode: "pool",
      provider: new StubProvider(),
      wallet: { network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } },
      conditions: {},
    });

  const post = (url: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txCbor: "00" }),
    });

  it("rate limits sponsorship requests out of the box", async () => {
    const gasless = newPool();
    server = await gasless.listen({ port: 0, rateLimit: { windowMs: 60_000, maxRequests: 2 } });

    expect((await post(server.url)).status).not.toBe(429);
    expect((await post(server.url)).status).not.toBe(429);

    const limited = await post(server.url);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ success: false });
  });

  it("never rate limits the conditions endpoint", async () => {
    const gasless = newPool();
    server = await gasless.listen({ port: 0, rateLimit: { windowMs: 60_000, maxRequests: 1 } });

    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${server.url}/conditions`)).status).toBe(200);
    }
  });

  it("refuses a request the authorize hook rejects", async () => {
    const gasless = newPool();
    server = await gasless.listen({
      port: 0,
      authorize: ({ headers }) => headers["x-api-key"] === "letmein",
    });

    expect((await post(server.url)).status).toBe(403);

    const permitted = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "letmein" },
      body: JSON.stringify({ txCbor: "00" }),
    });
    // Authorized, so it reaches validation and fails there instead.
    expect(permitted.status).not.toBe(403);
  });
});
