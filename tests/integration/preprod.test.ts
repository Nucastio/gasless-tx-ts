import { Transaction } from "@meshsdk/core-cst";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Gasless } from "../../src/index.js";
import type { PoolServer } from "../../src/types.js";

/**
 * Live preprod round trip.
 *
 * Skipped unless both variables are set, so `pnpm test` stays offline and no
 * credentials live in this repository:
 *
 *   BLOCKFROST_PROJECT_ID=preprod...  POOL_MNEMONIC="word word ..."  pnpm test:integration
 *
 * The pool wallet needs at least one UTxO holding 3 ADA or more.
 */
const projectId = process.env.BLOCKFROST_PROJECT_ID;
const poolMnemonic = process.env.POOL_MNEMONIC;
const configured = Boolean(projectId && poolMnemonic);

describe.skipIf(!configured)("preprod round trip", () => {
  let pool: Gasless;
  let server: PoolServer;

  beforeAll(async () => {
    pool = new Gasless({
      mode: "pool",
      apiKey: projectId as string,
      wallet: {
        network: 0,
        key: { type: "mnemonic", words: (poolMnemonic as string).split(/\s+/) },
      },
      conditions: {},
    });
    server = await pool.listen({ port: 0 });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("publishes its address and conditions", async () => {
    const info = (await (await fetch(`${server.url}/conditions`)).json()) as { address: string };
    expect(info.address).toBe(pool.address);
  });

  it("sponsors and co-signs a real transaction against live chain data", async () => {
    const utxos = await pool.provider.fetchAddressUTxOs(pool.address);
    expect(utxos.length, `fund ${pool.address} on preprod before running this`).toBeGreaterThan(0);

    const funded = utxos.find(
      (utxo) =>
        BigInt(utxo.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0") >=
        5_000_000n,
    );
    expect(funded, "pool needs a UTxO of at least 5 ADA").toBeDefined();

    // The pool sponsors a transaction that only moves its own funds, so the
    // test needs no second funded wallet and submits nothing.
    const unsignedTx = new Transaction(
      Transaction.fromCbor(
        (await pool.sponsorTx({
          txCbor: buildEmptyTx(),
          poolId: pool.address,
          utxo: funded?.input,
        })) as never,
      ).body(),
      Transaction.fromCbor(buildEmptyTx() as never).witnessSet(),
    ).toCbor();

    const signed = await pool.validateAndSign(unsignedTx);
    expect(
      Transaction.fromCbor(signed as never)
        .witnessSet()
        .vkeys()
        ?.values(),
    ).toHaveLength(1);
  });
});

/** A transaction with no inputs and no outputs — the pool supplies both. */
const buildEmptyTx = (): string => "84a300a0018002000ff5f6";
