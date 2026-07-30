import { Transaction, TransactionWitnessSet } from "@meshsdk/core-cst";
import { describe, expect, it } from "vitest";
import { PoolWallet } from "../../src/wallet.js";
import { POOL_MNEMONIC, buildTx, lovelace, makeUtxo, poolWallet } from "./helpers.js";

/**
 * Addresses captured from MeshSDK's `MeshWallet` for the same mnemonic.
 *
 * This library derives keys itself rather than depending on `@meshsdk/core`;
 * these fixtures are the contract that an existing pool keeps its address.
 */
const MESH_ADDRESSES = {
  testnet:
    "addr_test1qqe7et9t7fyuwsvkxtsvauhdanmekqgj3nzuhhva7c3aqryfwv32hch4m0mfkshdul73fstpx89l7h0z73t328p06g4snrcxhg",
  mainnet:
    "addr1qye7et9t7fyuwsvkxtsvauhdanmekqgj3nzuhhva7c3aqryfwv32hch4m0mfkshdul73fstpx89l7h0z73t328p06g4ss49xmh",
  paymentKeyHash: "33ecacabf249c7419632e0cef2edecf79b01128cc5cbdd9df623d00c",
  cliTestnet:
    "addr_test1qpdwryatu622vp6nrcs0shvrtzk7nfr55n69438pt6tzmgdg500utfac3r6wvsygpnvt57a5ht0edjs0n6ejlwvuytns3zrvm5",
};

describe("PoolWallet key derivation", () => {
  it("matches MeshWallet on testnet", () => {
    const wallet = new PoolWallet({
      network: 0,
      key: { type: "mnemonic", words: POOL_MNEMONIC },
    });
    expect(wallet.address).toBe(MESH_ADDRESSES.testnet);
    expect(wallet.paymentKeyHash).toBe(MESH_ADDRESSES.paymentKeyHash);
  });

  it("matches MeshWallet on mainnet", () => {
    const wallet = new PoolWallet({
      network: 1,
      key: { type: "mnemonic", words: POOL_MNEMONIC },
    });
    expect(wallet.address).toBe(MESH_ADDRESSES.mainnet);
  });

  it("matches MeshWallet for a cardano-cli signing key", () => {
    const wallet = new PoolWallet({
      network: 0,
      key: { type: "cli", payment: `5820${"11".repeat(32)}` },
    });
    expect(wallet.address).toBe(MESH_ADDRESSES.cliTestnet);
  });

  it("treats a cli key as the same wallet with or without the CBOR tag", () => {
    const tagged = new PoolWallet({
      network: 0,
      key: { type: "cli", payment: `5820${"11".repeat(32)}` },
    });
    const bare = new PoolWallet({ network: 0, key: { type: "cli", payment: "11".repeat(32) } });
    expect(bare.address).toBe(tagged.address);
  });

  it("derives a different address per account index", () => {
    const first = new PoolWallet({ network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } });
    const second = new PoolWallet({
      network: 0,
      key: { type: "mnemonic", words: POOL_MNEMONIC },
      accountIndex: 1,
    });
    expect(second.address).not.toBe(first.address);
  });

  it("rejects an empty mnemonic instead of deriving a surprise wallet", () => {
    expect(() => new PoolWallet({ network: 0, key: { type: "mnemonic", words: [] } })).toThrow(
      /mnemonic/i,
    );
  });

  it("rejects a root key that is not bech32", () => {
    expect(() => new PoolWallet({ network: 0, key: { type: "root", bech32: "nonsense" } })).toThrow(
      /bech32/i,
    );
  });
});

describe("PoolWallet signing", () => {
  const wallet = poolWallet();
  const txCbor = buildTx(
    [makeUtxo(wallet.address, 10_000_000n)],
    [{ address: wallet.address, amount: lovelace(9_000_000n) }],
    200_000n,
  );

  it("adds exactly one witness and leaves the body untouched", () => {
    const signed = Transaction.fromCbor(wallet.signTx(txCbor) as never);
    const original = Transaction.fromCbor(txCbor as never);

    expect(signed.witnessSet().vkeys()?.values()).toHaveLength(1);
    expect(signed.body().toCbor()).toBe(original.body().toCbor());
  });

  it("keeps witnesses that are already present", () => {
    const once = wallet.signTx(txCbor);
    const other = new PoolWallet({
      network: 0,
      key: { type: "cli", payment: `5820${"22".repeat(32)}` },
    });

    const twice = Transaction.fromCbor(other.signTx(once) as never);
    expect(twice.witnessSet().vkeys()?.values()).toHaveLength(2);
  });

  it("signs the transaction body, so an unrelated body gets a different signature", () => {
    const otherCbor = buildTx(
      [makeUtxo(wallet.address, 10_000_000n)],
      [{ address: wallet.address, amount: lovelace(8_000_000n) }],
      200_000n,
    );

    expect(wallet.signatureFor(txCbor).signature()).not.toBe(
      wallet.signatureFor(otherCbor).signature(),
    );
  });

  it("produces a signature that is stable for the same transaction", () => {
    expect(wallet.signatureFor(txCbor).signature()).toBe(wallet.signatureFor(txCbor).signature());
  });

  it("ignores an existing witness set when computing the signature", () => {
    // The signature covers the body hash only; a witness set present or absent
    // must not change it, or a second signer would invalidate the first.
    const withWitnesses = new Transaction(
      Transaction.fromCbor(txCbor as never).body(),
      TransactionWitnessSet.fromCbor(
        Transaction.fromCbor(wallet.signTx(txCbor) as never)
          .witnessSet()
          .toCbor(),
      ),
    ).toCbor();

    expect(wallet.signatureFor(withWitnesses).signature()).toBe(
      wallet.signatureFor(txCbor).signature(),
    );
  });
});
