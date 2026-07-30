import { describe, expect, it, vi } from "vitest";
import { BlockfrostProvider } from "../../src/provider.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const utxoPayload = (index: number) => ({
  address: "addr_test1vqeux7xwusdju9dvsj8h7mca9aup2k649xvpz9d3l0j4fzs5plnwl",
  amount: [{ unit: "lovelace", quantity: "5000000" }],
  output_index: index,
});

describe("BlockfrostProvider", () => {
  it("picks the network from the project id prefix", () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => json([]));
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    void provider.fetchAddressUTxOs("addr_test1abc");
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("cardano-preprod.blockfrost.io");
  });

  it("refuses a project id it cannot map to a network", () => {
    expect(() => new BlockfrostProvider("mystery-key")).toThrow(/network/i);
  });

  it("accepts an explicit url for a self-hosted backend", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => json([]));
    const provider = new BlockfrostProvider("mystery-key", {
      url: "https://blockfrost.internal/api/v0",
      fetch: fetchFn as never,
    });

    await provider.fetchAddressUTxOs("addr_test1abc");
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("https://blockfrost.internal/api/v0/");
  });

  it("sends the project id as a header, never in the url", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => json([]));
    const provider = new BlockfrostProvider("preprodSECRET", { fetch: fetchFn as never });

    await provider.fetchAddressUTxOs("addr_test1abc");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("SECRET");
    expect((init as RequestInit).headers).toMatchObject({ project_id: "preprodSECRET" });
  });

  it("filters transaction outputs by index", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ outputs: [utxoPayload(0), utxoPayload(1)] }),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    const utxos = await provider.fetchUTxOs("ab".repeat(32), 1);
    expect(utxos).toHaveLength(1);
    expect(utxos[0]?.input.outputIndex).toBe(1);
  });

  it("walks every page of address UTxOs", async () => {
    const pages = [[utxoPayload(0)], [utxoPayload(1)], []];
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json(pages.shift() ?? []),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    expect(await provider.fetchAddressUTxOs("addr_test1abc")).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("treats an unknown address as empty rather than an error", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ message: "Not found" }, 404),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    expect(await provider.fetchAddressUTxOs("addr_test1unused")).toEqual([]);
  });

  it("retries a rate-limited request and then succeeds", async () => {
    const responses = [
      json({ message: "limit" }, 429, { "retry-after": "0" }),
      json({ outputs: [] }),
    ];
    const fetchFn = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => responses.shift() ?? json({ outputs: [] }),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    await provider.fetchUTxOs("ab".repeat(32));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and reports the status", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ message: "boom" }, 500),
    );
    const provider = new BlockfrostProvider("preprodABC", {
      fetch: fetchFn as never,
      maxRetries: 1,
    });

    await expect(provider.fetchUTxOs("ab".repeat(32))).rejects.toMatchObject({
      code: "ProviderError",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a client error", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ message: "bad key" }, 403),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    await expect(provider.fetchUTxOs("ab".repeat(32))).rejects.toThrow(/403/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps the Conway reference-script price that Mesh's provider drops", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({
        epoch: 100,
        min_fee_a: 44,
        min_fee_b: 155381,
        min_fee_ref_script_cost_per_byte: 44,
        price_mem: 0.0577,
        price_step: 0.0000721,
        coins_per_utxo_word: 4310,
      }),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    const params = await provider.fetchProtocolParameters();
    expect(params.minFeeRefScriptCostPerByte).toBe(44);
    expect(params.minFeeA).toBe(44);
  });

  it("submits raw CBOR bytes and returns the transaction hash", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(`"${"cd".repeat(32)}"`, { status: 200 }),
    );
    const provider = new BlockfrostProvider("preprodABC", { fetch: fetchFn as never });

    expect(await provider.submitTx("00ff")).toBe("cd".repeat(32));
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/cbor");
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from([0x00, 0xff]));
  });
});
