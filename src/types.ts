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

/**
 * Which transaction features this pool is willing to co-sign.
 *
 * Everything defaults to refused. The pool signs a transaction body it did not
 * build, and its signature authorizes more than spending its own UTxO, so
 * anything it cannot reason about is rejected rather than waved through.
 */
export interface SponsorshipPolicy {
  /** Allow minting or burning. Off by default: see `allowPoolKeyScripts`. */
  allowMint?: boolean;
  /** Allow certificates (stake registration, DRep, committee, ...). */
  allowCertificates?: boolean;
  /** Allow reward withdrawals. */
  allowWithdrawals?: boolean;
  /** Allow governance votes and proposals. */
  allowGovernance?: boolean;
  /** Allow treasury donation fields. */
  allowTreasuryOperations?: boolean;
  /**
   * Allow pool UTxOs to back collateral.
   *
   * Off by default. Collateral is forfeited whole when a Plutus script fails,
   * so pool-funded collateral lets an attacker burn pool funds deliberately.
   */
  allowPoolCollateral?: boolean;
  /**
   * Allow native scripts that require the pool's payment key.
   *
   * Off by default: the pool's co-signature would satisfy such a script, for
   * instance a minting policy issued under the pool's identity.
   */
  allowPoolKeyScripts?: boolean;
  /**
   * Allow Plutus script execution (redeemers).
   *
   * On by default — script transactions are ordinary traffic — but turning it
   * off is the simplest way for a payments-only pool to avoid script fees and
   * collateral entirely.
   */
  allowPlutusScripts?: boolean;
  /** Allow reference inputs. On by default. */
  allowReferenceInputs?: boolean;

  /** Reject transactions with more inputs than this (default 50). */
  maxInputs?: number;
  /** Reject transactions with more outputs than this (default 50). */
  maxOutputs?: number;
  /** Reject transactions whose serialized size exceeds this many bytes. */
  maxTxSizeBytes?: number;
  /** Reject transactions whose fee exceeds this many lovelace. */
  maxFeeLovelace?: bigint;

  /** Bech32 addresses this pool refuses to pay out to. */
  blockedAddresses?: string[];
  /**
   * Cap total fees the pool will underwrite in a rolling window.
   *
   * The backstop against an open faucet: without it, anyone who satisfies the
   * conditions can drain the pool one fee at a time. Counted in-process, so it
   * bounds a single pool server rather than a cluster.
   */
  feeBudget?: { windowMs: number; maxLovelace: bigint };
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
  /** Transaction features this pool will co-sign. Restrictive by default. */
  policy?: SponsorshipPolicy;
}

export type WalletCredentials =
  | { type: "root"; bech32: string }
  | { type: "cli"; payment: string; stake?: string }
  | { type: "mnemonic"; words: string[] }
  | { type: "bip32Bytes"; bip32Bytes: Uint8Array };

/** 0 = testnet (preprod/preview), 1 = mainnet. */
export type NetworkId = 0 | 1;

/** Either bring your own provider, or let the library build a Blockfrost one. */
export type ProviderOptions = ({ apiKey: string } | { provider: GaslessProvider }) & {
  /**
   * How long a pool UTxO handed to one sponsorship stays off-limits to the
   * next (default 120000 ms). Prevents concurrent requests from handing the
   * same UTxO to several users, whose transactions would then conflict.
   */
  reservationMs?: number;
};

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
  /**
   * Per-client signing rate limit. Defaults to 30 requests per minute per
   * remote address. Pass `false` to disable — every signature costs the pool a
   * real fee, so only do that behind your own gateway.
   */
  rateLimit?: { windowMs: number; maxRequests: number } | false;
  /**
   * Called before validation, with the parsed request. Return false to refuse.
   * Use it for API keys, per-user quotas, or anything the built-in conditions
   * cannot express.
   */
  authorize?: (request: {
    txCbor: string;
    headers: Record<string, string | string[] | undefined>;
    remoteAddress?: string;
  }) => boolean | Promise<boolean>;
}
