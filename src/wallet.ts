import { mnemonicToEntropy } from "@meshsdk/common";
import {
  type Address,
  Bip32PrivateKey,
  Ed25519KeyHashHex,
  Ed25519PublicKeyHex,
  Ed25519SignatureHex,
  Hash28ByteBase16,
  Serialization,
  type StricaPrivateKey,
  Transaction,
  VkeyWitness,
  buildBaseAddress,
  buildBip32PrivateKey,
  buildKeys,
  deserializeTxHash,
  resolveTxHash,
} from "@meshsdk/core-cst";
import { bech32 } from "bech32";
import { GaslessError } from "./errors.js";
import { TxCBOR } from "./hex.js";
import type { NetworkId, WalletCredentials } from "./types.js";

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const keyHashOf = (key: StricaPrivateKey): Hash28ByteBase16 =>
  Hash28ByteBase16.fromEd25519KeyHashHex(
    Ed25519KeyHashHex(key.toPublicKey().hash().toString("hex")),
  );

/** Bech32 `xprv...` / `root_xsk...` string to the raw BIP32 key hex. */
const rootKeyToEntropy = (bech32Key: string): string => {
  let bytes: Uint8Array;
  try {
    const decoded = bech32.decode(bech32Key, 1023);
    bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  } catch (error) {
    throw new GaslessError(
      "InvalidInput",
      "Root key must be a bech32-encoded BIP32 private key.",
      error,
    );
  }
  return toHex(Bip32PrivateKey.fromBytes(bytes).bytes());
};

const toEntropy = (key: WalletCredentials): string | [string, string] => {
  switch (key.type) {
    case "mnemonic": {
      if (!Array.isArray(key.words) || key.words.length === 0) {
        throw new GaslessError("InvalidInput", "Mnemonic must be an array of words.");
      }
      return toHex(buildBip32PrivateKey(mnemonicToEntropy(key.words.join(" "))).bytes());
    }
    case "root":
      return rootKeyToEntropy(key.bech32);
    case "cli":
      // cardano-cli signing keys are CBOR byte strings; strip the 0x5820 tag.
      return [
        key.payment.startsWith("5820") ? key.payment.slice(4) : key.payment,
        (key.stake ?? "f0".repeat(32)).startsWith("5820")
          ? (key.stake ?? "").slice(4)
          : (key.stake ?? "f0".repeat(32)),
      ];
    case "bip32Bytes":
      return toHex(Bip32PrivateKey.fromBytes(key.bip32Bytes).bytes());
    default: {
      const exhaustive: never = key;
      throw new GaslessError(
        "InvalidInput",
        `Unsupported wallet key type: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
};

/**
 * The pool's signing key.
 *
 * Deliberately minimal: a pool only ever needs its own address and the ability
 * to add one vkey witness. Key derivation matches MeshSDK's `MeshWallet`
 * (`m/1852'/1815'/account'/0/index`), so an existing pool wallet keeps the same
 * address after upgrading.
 */
export class PoolWallet {
  readonly networkId: NetworkId;
  readonly address: string;
  readonly paymentKeyHash: string;

  private readonly paymentKey: StricaPrivateKey;
  private readonly cardanoAddress: Address;

  constructor(options: {
    network: NetworkId;
    key: WalletCredentials;
    accountIndex?: number;
    keyIndex?: number;
  }) {
    this.networkId = options.network;

    const { paymentKey, stakeKey } = buildKeys(
      toEntropy(options.key),
      options.accountIndex ?? 0,
      options.keyIndex ?? 0,
    );

    this.paymentKey = paymentKey;
    this.cardanoAddress = buildBaseAddress(
      options.network,
      keyHashOf(paymentKey),
      keyHashOf(stakeKey),
    ).toAddress();

    this.address = this.cardanoAddress.toBech32();
    this.paymentKeyHash = this.cardanoAddress.getProps().paymentPart?.hash ?? "";
  }

  /** Signature over a transaction, without the rest of the witness set. */
  signatureFor(txCbor: string): VkeyWitness {
    const txHash = deserializeTxHash(resolveTxHash(TxCBOR(txCbor)));
    return new VkeyWitness(
      Ed25519PublicKeyHex(this.paymentKey.toPublicKey().toBytes().toString("hex")),
      Ed25519SignatureHex(this.paymentKey.sign(Buffer.from(txHash, "hex")).toString("hex")),
    );
  }

  /**
   * Add the pool's witness to a transaction, keeping any witnesses already
   * present (the user still has to sign their own inputs).
   */
  signTx(txCbor: string): string {
    const tx = Transaction.fromCbor(TxCBOR(txCbor));
    const witnessSet = tx.witnessSet();
    const existing = witnessSet.vkeys()?.values() ?? [];

    witnessSet.setVkeys(
      Serialization.CborSet.fromCore(
        [...existing, this.signatureFor(txCbor)].map((witness) => witness.toCore()),
        VkeyWitness.fromCore,
      ),
    );

    return new Transaction(tx.body(), witnessSet, tx.auxiliaryData()).toCbor();
  }
}
