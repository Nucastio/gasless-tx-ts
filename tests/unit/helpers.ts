import {
  Serialization,
  Transaction,
  TransactionBody,
  TransactionId,
  TransactionInput,
  TransactionOutput,
  TransactionWitnessSet,
  toCardanoAddress,
  toValue,
} from "@meshsdk/core-cst";
import type { Asset, GaslessProvider, Protocol, UTxO } from "../../src/types.js";
import { PoolWallet } from "../../src/wallet.js";

/** Preprod parameters as of the Conway era; fixed so fee assertions are stable. */
export const PROTOCOL_PARAMETERS: Protocol = {
  epoch: 100,
  minFeeA: 44,
  minFeeB: 155381,
  maxBlockSize: 90112,
  maxTxSize: 16384,
  maxBlockHeaderSize: 1100,
  keyDeposit: 2000000,
  poolDeposit: 500000000,
  decentralisation: 0,
  minPoolCost: "170000000",
  priceMem: 0.0577,
  priceStep: 0.0000721,
  maxTxExMem: "14000000",
  maxTxExSteps: "10000000000",
  maxBlockExMem: "62000000",
  maxBlockExSteps: "20000000000",
  maxValSize: 5000,
  collateralPercent: 150,
  maxCollateralInputs: 3,
  coinsPerUtxoSize: 4310,
  minFeeRefScriptCostPerByte: 15,
};

export const POOL_MNEMONIC =
  "wood bench lock genuine relief coral guard reunion follow radio jewel cereal actual erosion recall".split(
    " ",
  );

export const USER_MNEMONIC =
  "sock more reward august tone polar pilot future phone moon hidden night".split(" ");

export const poolWallet = (): PoolWallet =>
  new PoolWallet({ network: 0, key: { type: "mnemonic", words: POOL_MNEMONIC } });

export const userWallet = (): PoolWallet =>
  new PoolWallet({ network: 0, key: { type: "mnemonic", words: USER_MNEMONIC } });

const txHashFor = (seed: number): string => seed.toString(16).padStart(2, "0").repeat(32);

export const makeUtxo = (
  address: string,
  lovelace: bigint,
  options: { seed?: number; index?: number; assets?: Record<string, bigint> } = {},
): UTxO => ({
  input: { txHash: txHashFor(options.seed ?? 1), outputIndex: options.index ?? 0 },
  output: {
    address,
    amount: [
      { unit: "lovelace", quantity: lovelace.toString() },
      ...Object.entries(options.assets ?? {}).map(([unit, quantity]) => ({
        unit,
        quantity: quantity.toString(),
      })),
    ],
  },
});

/**
 * An in-memory chain.
 *
 * Every UTxO the tests reference is registered up front, so nothing touches the
 * network and the counters let a test assert how many lookups actually happened.
 */
export class StubProvider implements GaslessProvider {
  readonly calls = { fetchUTxOs: 0, fetchAddressUTxOs: 0, fetchProtocolParameters: 0, submitTx: 0 };
  readonly submitted: string[] = [];

  private readonly utxos = new Map<string, UTxO>();

  constructor(utxos: UTxO[] = []) {
    for (const utxo of utxos) this.add(utxo);
  }

  add(utxo: UTxO): this {
    this.utxos.set(`${utxo.input.txHash}#${utxo.input.outputIndex}`, utxo);
    return this;
  }

  async fetchUTxOs(hash: string, index?: number): Promise<UTxO[]> {
    this.calls.fetchUTxOs++;
    return [...this.utxos.values()].filter(
      (utxo) =>
        utxo.input.txHash === hash && (index === undefined || utxo.input.outputIndex === index),
    );
  }

  async fetchAddressUTxOs(address: string): Promise<UTxO[]> {
    this.calls.fetchAddressUTxOs++;
    return [...this.utxos.values()].filter((utxo) => utxo.output.address === address);
  }

  async fetchProtocolParameters(): Promise<Protocol> {
    this.calls.fetchProtocolParameters++;
    return PROTOCOL_PARAMETERS;
  }

  async submitTx(tx: string): Promise<string> {
    this.calls.submitTx++;
    this.submitted.push(tx);
    return txHashFor(255);
  }
}

export const toTxOut = (address: string, amount: Asset[]): TransactionOutput =>
  new TransactionOutput(toCardanoAddress(address), toValue(amount));

/**
 * Build an unsigned transaction by hand.
 *
 * Deliberately not built with a transaction builder: the tests exercise this
 * library's own serialization round trip, and a builder would hide it.
 * Fee starts at zero, which is exactly what a gasless user submits.
 */
export const buildTx = (
  inputs: UTxO[],
  outputs: { address: string; amount: Asset[] }[],
  fee = 0n,
): string => {
  const inputSet = Serialization.CborSet.fromCore([], TransactionInput.fromCore);
  inputSet.setValues(
    inputs.map(
      (utxo) =>
        new TransactionInput(TransactionId(utxo.input.txHash), BigInt(utxo.input.outputIndex)),
    ),
  );

  const body = new TransactionBody(
    inputSet,
    outputs.map((output) => toTxOut(output.address, output.amount)),
    fee,
  );

  return new Transaction(body, new TransactionWitnessSet()).toCbor();
};

export const lovelace = (quantity: bigint): Asset[] => [
  { unit: "lovelace", quantity: quantity.toString() },
];
