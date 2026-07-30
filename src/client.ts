import { GaslessCore } from "./core.js";
import type { GaslessProvider, PoolConditions } from "./types.js";

export { GaslessCore, comparisons, paymentKeyHashOf, utxosToAssets } from "./core.js";
export { GaslessError, ValidationError, isGaslessError } from "./errors.js";
export type { GaslessErrorCode } from "./errors.js";
export {
  calculateFees,
  countNumberOfRequiredWitnesses,
  createDummyTx,
  referenceScriptFee,
} from "./fees.js";
export { BlockfrostProvider } from "./provider.js";
export type { BlockfrostProviderOptions } from "./provider.js";
export * from "./types.js";

/**
 * Browser-safe half of the library: sponsor a transaction and run it past a
 * pool server.
 *
 * Everything that needs a Node runtime — the signing key and the HTTP server —
 * is deliberately absent, so this entry pulls in no Node builtins. Import
 * `Gasless` from the package root to run a pool.
 */
export class GaslessClient extends GaslessCore {}

export type GaslessClientOptions = ({ apiKey: string } | { provider: GaslessProvider }) & {
  conditions?: PoolConditions;
};
