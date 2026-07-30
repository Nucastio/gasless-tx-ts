/**
 * Machine-readable error codes. These are part of the public API: the pool
 * server returns them verbatim so callers can branch on `code` instead of
 * pattern-matching English error messages.
 */
export type GaslessErrorCode =
  // input / configuration
  | "InvalidInput"
  | "InvalidMode"
  | "MissingConditions"
  // chain lookups
  | "UtxoNotFound"
  | "InsufficientPoolFunds"
  | "ProviderError"
  // validation of a sponsored transaction
  | "FeeMismatch"
  | "AssetMismatch"
  | "PoolOutputMismatch"
  | "MissingRequiredAsset"
  | "TokenRequirementNotMet"
  | "AddressNotWhitelisted"
  // signing server round trip
  | "SigningServerError";

export class GaslessError extends Error {
  constructor(
    readonly code: GaslessErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }

  toJSON(): { code: GaslessErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * Raised when a transaction breaks a pool rule (fee, assets, whitelist, token
 * requirements). Distinct from other failures because it means "the request was
 * understood and refused" — the server maps it to HTTP 400.
 */
export class ValidationError extends GaslessError {}

export const isGaslessError = (error: unknown): error is GaslessError =>
  error instanceof GaslessError;
