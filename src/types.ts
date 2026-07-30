import type { Asset, Protocol, UTxO } from "@meshsdk/common";

export type { Asset, Protocol, UTxO };

/**
 * The slice of a chain data provider this library actually uses.
 *
 * Any MeshSDK provider (`BlockfrostProvider`, `KoiosProvider`, `MaestroProvider`,
 * ...) structurally satisfies this, and so does the bundled {@link BlockfrostProvider}.
 */
export interface GaslessProvider {
  fetchUTxOs(hash: string, index?: number): Promise<UTxO[]>;
  fetchAddressUTxOs(address: string, asset?: string): Promise<UTxO[]>;
  fetchProtocolParameters(epoch?: number): Promise<Protocol>;
  submitTx(tx: string): Promise<string>;
}

export type ComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export interface TokenRequirement {
  /** Asset unit: `lovelace`, or `<policyId><assetNameHex>`. */
  unit: string;
  quantity: number;
  comparison: ComparisonOperator;
}

export interface PoolConditions {
  /**
   * At least one non-pool input address must satisfy at least one requirement.
   */
  tokenRequirements?: TokenRequirement[];
  /** Bech32 addresses; at least one non-pool input must come from this list. */
  whitelist?: string[];
  /** Allowed browser origins for the pool server. Omit to disable CORS. */
  corsSettings?: string[];
}

export type WalletCredentials =
  | { type: "root"; bech32: string }
  | { type: "cli"; payment: string; stake?: string }
  | { type: "mnemonic"; words: string[] }
  | { type: "bip32Bytes"; bip32Bytes: Uint8Array };

/** 0 = testnet (preprod/preview), 1 = mainnet. */
export type NetworkId = 0 | 1;

/** Either bring your own provider, or let the library build a Blockfrost one. */
export type ProviderOptions = { apiKey: string } | { provider: GaslessProvider };

export type PoolOptions = ProviderOptions & {
  mode: "pool";
  wallet: {
    network: NetworkId;
    key: WalletCredentials;
    /** BIP32 account index (default 0). */
    accountIndex?: number;
    /** BIP32 key index (default 0). */
    keyIndex?: number;
  };
  conditions?: PoolConditions;
};

export type SponsorOptions = ProviderOptions & {
  mode: "sponsor";
};

export type GaslessOptions = PoolOptions | SponsorOptions;

export interface SponsorTxParams {
  /** Hex-encoded CBOR of the user's unsigned transaction. */
  txCbor: string;
  /** Bech32 address of the pool paying the fee. */
  poolId: string;
  /** Pin a specific pool UTxO instead of letting the library choose. */
  utxo?: { txHash: string; outputIndex: number };
}

export interface ValidateTxParams {
  /** Hex-encoded CBOR of a transaction returned by `sponsorTx`. */
  txCbor: string;
  /** Base URL of the pool signing server, e.g. `http://localhost:5050`. */
  poolSignServer: string;
  /** Abort the round trip after this many ms (default 30000). */
  timeoutMs?: number;
}

/** Response body of `GET /conditions` on the pool server. */
export interface PoolInfo {
  /** Bech32 base address of the pool wallet. */
  address: string;
  /** Payment key hash of the pool wallet (hex). */
  paymentKeyHash: string;
  conditions: PoolConditions;
}

export interface PoolServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /** Maximum accepted request body in bytes (default 256 KiB). */
  maxBodyBytes?: number;
}
