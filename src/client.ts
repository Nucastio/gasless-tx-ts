import type {
  WalletCredentials,
  PoolConditions,
  ConstructorParams,
  ITransaction,
  CUTxO,
  GaslessClient
} from "./@types/types";

import { sponsorTx } from "endpoints/transaction/sponsorTx";
import { validateTx } from "endpoints/transaction/validateTx";
import { BlockfrostProvider } from "@meshsdk/core";
import { Hash28ByteBase16, Serialization, toCardanoAddress, TokenMap, toValue, Transaction, TransactionOutput } from "@meshsdk/core-cst";
import { comparisons, ValidationError } from "utils";

export class Gasless implements GaslessClient {
  conditions?: PoolConditions;

  blockchainProvider: BlockfrostProvider;
  sponsorTx: ITransaction["sponsorTx"];
  validateTx: ITransaction["validateTx"];

  constructor(props: ConstructorParams) {
    this.blockchainProvider = new BlockfrostProvider(props.apiKey);

    this.validateTx = validateTx.bind(this);
    this.sponsorTx = sponsorTx.bind(this);
  }

  setConditions(newConditions: PoolConditions){
    this.conditions = newConditions;
  }

  async getSponsoredInputMap(this: GaslessClient, baseTx: Transaction, sponsoredPoolHash?: Hash28ByteBase16) {
    const sponsorInputMap: Map<
      Serialization.TransactionInput,
      Serialization.TransactionOutput
    > = new Map();

    const inputSet = baseTx.body().inputs();

    for (const input of inputSet.values()) {
      const [inputInfo] = await this.blockchainProvider.fetchUTxOs(
        input.transactionId(),
        parseInt(input.index().toString())
      );

      if (!inputInfo) {
        throw new Error(`No UTxO found for transaction ${input.transactionId()} index ${input.index()}`);
      }

      const address = toCardanoAddress(inputInfo.output.address);

      if (
        address.getProps().paymentPart?.hash ===
        sponsoredPoolHash
      ) {
        const cardanoTxOut = new TransactionOutput(
          address,
          toValue(inputInfo.output.amount)
        );
        sponsorInputMap.set(input, cardanoTxOut);
      }
    }

    return sponsorInputMap
  }

  getConsumedUtxos(sponsorInputMap: Map<
    Serialization.TransactionInput,
    Serialization.TransactionOutput
  >): CUTxO[] {
    return [...sponsorInputMap.values()].reduce(
      (acc, utxo) =>
        acc.concat({
          assets: utxo.amount().multiasset(),
          lovelace: utxo.amount().coin(),
        }),
      [] as {
        lovelace: bigint;
        assets: TokenMap | undefined;
      }[]
    )
  }

  getProducedUtxos(baseTx: Transaction, sponsoredPoolHash?: Hash28ByteBase16): CUTxO[] {
    return baseTx.body().outputs()
      .filter(utxo =>
        utxo.address().getProps().paymentPart?.hash ===
        sponsoredPoolHash
      )
      .map(output => ({
        assets: output.amount().multiasset(),
        lovelace: output.amount().coin(),
      }));
  }

  validateFeeDifference(consumed: CUTxO[], produced: CUTxO[], fee: bigint) {
    const diff = consumed.reduce(
      (acc, utxo) => acc + utxo.lovelace,
      0n - produced.reduce((acc, utxo) => acc + utxo.lovelace, 0n)
    );

    console.log(consumed.reduce(
      (acc, utxo) => acc + utxo.lovelace,
      0n
    ),  produced.reduce((acc, utxo) => acc + utxo.lovelace, 0n))

    if (diff !== fee) {
      throw new ValidationError('FeeMismatch', `Fee difference ${diff} does not match expected fee ${fee}`);
    }
  }

  validateAssets(consumed: CUTxO[], produced: CUTxO[]) {
    for (const { assets } of consumed) {
      if (assets) {
        for (const [key, value] of assets.entries()) {
          if (!produced.some((utxo) => utxo.assets?.get(key) === value)) {
            throw new ValidationError('AssetMismatch', `Missing asset ${key.toString()} in produced UTxOs`);
          }
        }
      }
    }
  }

  async validateTokenRequirements(this: GaslessClient, baseTx: Transaction, sponsoredPoolHash?: Hash28ByteBase16) {

    if (!this.conditions?.tokenRequirements) {
      throw new ValidationError("NoTokenRequirements", "No token requirements specified in pool conditions")
    }
    const inputSet = baseTx.body().inputs();

    let assetMatchFound = false;

    for (const input of inputSet.values()) {
      const [inputInfo] = await this.blockchainProvider.fetchUTxOs(
        input.transactionId(),
        parseInt(input.index().toString())
      );

      if (!inputInfo) {
        throw new Error(`No UTxO found for transaction ${input.transactionId()} index ${input.index()}`);
      }

      const inputAddress = toCardanoAddress(inputInfo.output.address);
      const isSponsorWallet =
        inputAddress.getProps().paymentPart?.hash ===
        sponsoredPoolHash;

      if (isSponsorWallet) continue;

      const addressAssets = await this.blockchainProvider.fetchAddressAssets(inputInfo.output.address);
      const hasValidAsset = this.conditions.tokenRequirements.some(({ unit, comparison, quantity }) => {
        const value = addressAssets[unit];
        if (!value) return false;

        const passes = comparisons[comparison]?.(parseInt(value), quantity);
        if (!passes) {
          throw new ValidationError(
            "Asset value check failed",
            `Expected ${comparison} ${quantity} of ${unit}, but found ${value}`
          );
        }
        return true;
      });

      if (hasValidAsset) {
        assetMatchFound = true;
      }
    }

    if (!assetMatchFound) {
      throw new ValidationError("MissingRequiredAsset", `No input address holds any of the required assets`);
    }
  }

  async validateWhitelist(this: GaslessClient, baseTx: Transaction) {

    if (!this.conditions?.whitelist) {
      throw new ValidationError("NoWhitelist", "No whitelist specified in pool conditions")
    }
    const inputSet = baseTx.body().inputs();

    let addressMatchFound = false;

    for (const input of inputSet.values()) {
      const [inputInfo] = await this.blockchainProvider.fetchUTxOs(
        input.transactionId(),
        parseInt(input.index().toString())
      );

      if (!inputInfo) {
        throw new Error(`No UTxO found for transaction ${input.transactionId()} index ${input.index()}`);
      }

      if (this.conditions.whitelist.includes(inputInfo.output.address)) {
        addressMatchFound = true
      }
    }

    if (!addressMatchFound) {
      throw new ValidationError("AddressNotWhitelisted", `Address is not in the whitelist`);
    }
  }
}
