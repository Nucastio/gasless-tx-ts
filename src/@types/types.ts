import { BlockfrostProvider, MeshWallet } from "@meshsdk/core";
import { Hash28ByteBase16, Serialization, TokenMap, Transaction } from "@meshsdk/core-cst";
import { TxCBOR } from "utils";
import express from "express"

export type WalletCredentials =
  | {
    type: "root";
    bech32: string;
  }
  | {
    type: "cli";
    payment: string;
    stake?: string;
  }
  | {
    type: "mnemonic";
    words: string[];
  }
  | {
    type: "bip32Bytes";
    bip32Bytes: Uint8Array;
  }
  | {
    type: "address";
    address: string;
  };

export type ComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export interface TokenRequirement {
  unit: string;                 
  quantity: number; 
  comparison: ComparisonOperator;
}

export interface PoolConditions {
  tokenRequirements?: TokenRequirement[];
  whitelist?: string[];
  corsSettings?: string[];
}

type PoolParams = {
  mode: "pool";
  wallet: { network: 0 | 1; key: WalletCredentials };
  apiKey: string;
  conditions: PoolConditions;
};

type SponsorParams = {
  mode: "sponsor";
  apiKey: string;
};

export type ConstructorParams = PoolParams | SponsorParams;

// export interface ConstructorParams {
//   wallet: { network: 0 | 1; key: WalletCredentials };
//   conditions: PoolConditions;
//   apiKey: string;
// }

export interface SponsorTxParams {
  txCbor: string;
  poolId: string;
  utxo?: {
    txHash: string;
    outputIndex: number;
  };
}

export interface ValidateTxParams {
  txCbor: string;
  poolSignServer: string;
}

export declare interface ITransaction {
  sponsorTx: (this: Gasless,
    { txCbor, poolId, utxo }: SponsorTxParams) => Promise<TxCBOR>;
  validateTx: (
    this: Gasless,
    { txCbor, poolSignServer }: ValidateTxParams
  ) => Promise<TxCBOR>;
}

export type CUTxO = {
  lovelace: bigint;
  assets: TokenMap | undefined;
};

export declare class Gasless {
  conditions?: PoolConditions;
  app?: express.Application;
  inAppWallet?: MeshWallet;
  blockchainProvider: BlockfrostProvider;

  sponsorTx: ITransaction["sponsorTx"];
  validateTx: ITransaction["validateTx"];

  constructor(props: ConstructorParams);

  listen: (port?: number) => Promise<{
    error: string;
  } | undefined>;

  setConditions: (newConditions: PoolConditions) => void;
  
  getSponsoredInputMap: (
    this: Gasless,
    baseTx: Transaction,
    sponsoredPoolHash?: Hash28ByteBase16
  ) => Promise<
    Map<
      Serialization.TransactionInput,
      Serialization.TransactionOutput
    >
  >;

  getProducedUtxos: (baseTx: Transaction, sponsoredPoolHash?: Hash28ByteBase16) => CUTxO[]

  getConsumedUtxos: (sponsorInputMap: Map<
    Serialization.TransactionInput,
    Serialization.TransactionOutput
  >) => CUTxO[]

  validateFeeDifference: (consumed: CUTxO[], produced: CUTxO[], fee: bigint) => void
  validateAssets: (consumed: CUTxO[], produced: CUTxO[], sponsoredPoolHash?: Hash28ByteBase16) => void
  validateTokenRequirements: (baseTx: Transaction, sponsoredPoolHash?: Hash28ByteBase16) => Promise<void>;
  validateWhitelist: (baseTx: Transaction) => Promise<void>;
}
