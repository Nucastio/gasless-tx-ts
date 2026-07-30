import { GaslessError } from "./errors.js";

/** Nominal string type, so a raw `string` cannot slip into a hex-only slot. */
export type OpaqueString<T extends string> = string & { readonly __opaqueString: T };

export type HexBlob = OpaqueString<"HexBlob">;
export type TxCBOR = OpaqueString<"TxCbor">;

const HEX_PATTERN = /^[\da-f]*$/i;

const assertHex = (value: string, label: string): void => {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new GaslessError("InvalidInput", `${label} must be a hex string.`);
  }
  if (value.length % 2 !== 0) {
    throw new GaslessError("InvalidInput", `${label} must have an even number of hex digits.`);
  }
};

export const HexBlob = (value: string): HexBlob => {
  assertHex(value, "Value");
  return value as HexBlob;
};

export const TxCBOR = (value: string): TxCBOR => {
  assertHex(value, "Transaction CBOR");
  if (value.length === 0) {
    throw new GaslessError("InvalidInput", "Transaction CBOR must not be empty.");
  }
  return value as TxCBOR;
};
