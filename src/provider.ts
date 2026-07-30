import { castProtocol } from "@meshsdk/common";
import { normalizePlutusScript, toScriptRef } from "@meshsdk/core-cst";
import { GaslessError } from "./errors.js";
import type { GaslessProvider, Protocol, UTxO } from "./types.js";

type BlockfrostAmount = { unit: string; quantity: string };

type BlockfrostUTxO = {
  address: string;
  amount: BlockfrostAmount[];
  output_index: number;
  tx_hash?: string;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
};

export interface BlockfrostProviderOptions {
  /**
   * Full API base URL. Derived from the project id prefix when omitted
   * (`mainnet...` / `preprod...` / `preview...`).
   */
  url?: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Retries for 429 / 5xx responses (default 3). */
  maxRetries?: number;
}

const NETWORK_URLS: Record<string, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

const urlForProjectId = (projectId: string): string => {
  for (const [network, url] of Object.entries(NETWORK_URLS)) {
    if (projectId.startsWith(network)) return url;
  }
  throw new GaslessError(
    "InvalidInput",
    `Cannot infer a network from the Blockfrost project id. Pass \`url\` explicitly, or use a key prefixed with one of: ${Object.keys(NETWORK_URLS).join(", ")}.`,
  );
};

/**
 * Minimal Blockfrost client built on `fetch`.
 *
 * Implements only the calls this library needs. If you already depend on
 * `@meshsdk/provider`, pass its provider to `Gasless` instead — any object
 * satisfying {@link GaslessProvider} works.
 */
export class BlockfrostProvider implements GaslessProvider {
  private readonly url: string;
  private readonly projectId: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly scriptRefCache = new Map<string, string | undefined>();

  constructor(projectId: string, options: BlockfrostProviderOptions = {}) {
    if (!projectId || typeof projectId !== "string") {
      throw new GaslessError("InvalidInput", "A Blockfrost project id is required.");
    }
    this.projectId = projectId;
    this.url = (options.url ?? urlForProjectId(projectId)).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;

    if (typeof this.fetchFn !== "function") {
      throw new GaslessError(
        "InvalidInput",
        "No global `fetch` available. Use Node 18+ or pass a `fetch` implementation.",
      );
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async request<T>(path: string, init: RequestInit, attempt = 0): Promise<T> {
    const response = await this.fetchFn(`${this.url}/${path.replace(/^\/+/, "")}`, {
      ...init,
      headers: { project_id: this.projectId, ...(init.headers ?? {}) },
    });

    if (response.ok) {
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // `tx/submit` answers with a bare quoted hash, some endpoints with text.
        return text.replace(/^"|"$/g, "") as T;
      }
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < this.maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.request<T>(path, init, attempt + 1);
    }

    throw new GaslessError(
      "ProviderError",
      `Blockfrost ${init.method ?? "GET"} ${path} failed with ${response.status}: ${await response.text()}`,
    );
  }

  async fetchUTxOs(hash: string, index?: number): Promise<UTxO[]> {
    const data = await this.get<{ outputs: BlockfrostUTxO[] }>(`txs/${hash}/utxos`);
    const outputs =
      index === undefined ? data.outputs : data.outputs.filter((o) => o.output_index === index);
    return Promise.all(outputs.map((output) => this.toUTxO(output, hash)));
  }

  async fetchAddressUTxOs(address: string, asset?: string): Promise<UTxO[]> {
    const suffix = asset ? `/${asset}` : "";
    const collected: UTxO[] = [];

    for (let page = 1; ; page++) {
      let batch: BlockfrostUTxO[];
      try {
        batch = await this.get<BlockfrostUTxO[]>(
          `addresses/${address}/utxos${suffix}?page=${page}`,
        );
      } catch (error) {
        // Blockfrost 404s an address it has never seen; that is an empty set.
        if (error instanceof GaslessError && /failed with 404/.test(error.message)) break;
        throw error;
      }
      if (batch.length === 0) break;
      collected.push(
        ...(await Promise.all(batch.map((utxo) => this.toUTxO(utxo, utxo.tx_hash ?? "")))),
      );
    }

    return collected;
  }

  async fetchProtocolParameters(epoch?: number): Promise<Protocol> {
    const data = await this.get<Record<string, unknown>>(
      `epochs/${epoch === undefined || Number.isNaN(epoch) ? "latest" : epoch}/parameters`,
    );

    return castProtocol({
      coinsPerUtxoSize: data.coins_per_utxo_word as number,
      collateralPercent: data.collateral_percent as number,
      decentralisation: data.decentralisation_param as number,
      epoch: data.epoch as number,
      keyDeposit: data.key_deposit as number,
      maxBlockExMem: data.max_block_ex_mem as number,
      maxBlockExSteps: data.max_block_ex_steps as number,
      maxBlockHeaderSize: data.max_block_header_size as number,
      maxBlockSize: data.max_block_size as number,
      maxCollateralInputs: data.max_collateral_inputs as number,
      maxTxExMem: data.max_tx_ex_mem as number,
      maxTxExSteps: data.max_tx_ex_steps as number,
      maxTxSize: data.max_tx_size as number,
      maxValSize: data.max_val_size as number,
      minFeeA: data.min_fee_a as number,
      minFeeB: data.min_fee_b as number,
      minPoolCost: data.min_pool_cost as number,
      poolDeposit: data.pool_deposit as number,
      priceMem: data.price_mem as number,
      priceStep: data.price_step as number,
      // Mesh's own Blockfrost provider drops this Conway-era field, which makes
      // reference-script fees fall back to a stale default.
      minFeeRefScriptCostPerByte: data.min_fee_ref_script_cost_per_byte as number,
    });
  }

  async submitTx(tx: string): Promise<string> {
    return this.request<string>("tx/submit", {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: Buffer.from(tx, "hex"),
    });
  }

  private async toUTxO(utxo: BlockfrostUTxO, txHash: string): Promise<UTxO> {
    const scriptHash = utxo.reference_script_hash ?? undefined;
    return {
      input: { outputIndex: utxo.output_index, txHash },
      output: {
        address: utxo.address,
        amount: utxo.amount,
        dataHash: utxo.data_hash ?? undefined,
        plutusData: utxo.inline_datum ?? undefined,
        scriptRef: scriptHash ? await this.resolveScriptRef(scriptHash) : undefined,
        scriptHash,
      },
    };
  }

  private async resolveScriptRef(scriptHash: string): Promise<string | undefined> {
    const cached = this.scriptRefCache.get(scriptHash);
    if (cached !== undefined || this.scriptRefCache.has(scriptHash)) return cached;

    const info = await this.get<{ type: string }>(`scripts/${scriptHash}`);
    let resolved: string | undefined;

    if (info.type.startsWith("plutus")) {
      const { cbor } = await this.get<{ cbor: string }>(`scripts/${scriptHash}/cbor`);
      resolved = toScriptRef({
        version: info.type.replace("plutus", ""),
        code: normalizePlutusScript(cbor, "DoubleCBOR"),
        // biome-ignore lint/suspicious/noExplicitAny: mesh types the version as a narrow union
      } as any)
        .toCbor()
        .toString();
    } else {
      const { json } = await this.get<{ json: unknown }>(`scripts/${scriptHash}/json`);
      // biome-ignore lint/suspicious/noExplicitAny: native script JSON is provider-shaped
      resolved = toScriptRef(json as any)
        .toCbor()
        .toString();
    }

    this.scriptRefCache.set(scriptHash, resolved);
    return resolved;
  }
}

/** Build the provider a caller asked for, whether by API key or by injection. */
export const resolveProvider = (
  options: { apiKey: string } | { provider: GaslessProvider },
): GaslessProvider => {
  if ("provider" in options && options.provider) return options.provider;
  if ("apiKey" in options && options.apiKey) return new BlockfrostProvider(options.apiKey);
  throw new GaslessError("InvalidInput", "Provide either `apiKey` or `provider`.");
};
