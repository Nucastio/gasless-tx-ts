import {
  Transaction,
  TransactionInput,
  TransactionId,
  TransactionOutput,
  toCardanoAddress,
  toValue,
  Ed25519KeyHashHex,
  deserializeAddress,
  Serialization
} from "@meshsdk/core-cst";

import { Gasless, SponsorTxParams } from "../../@types/types";
import { calculateFees, countNumberOfRequiredWitnesses, createDummyTx, HexBlob, TxCBOR } from "../../utils";
import { UTxO, keepRelevant } from "@meshsdk/core";

const DEFAULT_FEE_ASSET = new Map().set("lovelace", "3000000");

function isValidUTxO(utxo: any): utxo is UTxO {
  return utxo && 
         typeof utxo === 'object' &&
         typeof utxo.txHash === 'string' &&
         typeof utxo.outputIndex === 'number';
}


export async function sponsorTx(this: Gasless, {
  txCbor,
  utxo,
  poolId,
}: SponsorTxParams): Promise<TxCBOR> {

  if (!txCbor || typeof txCbor !== 'string') {
    throw new Error('Invalid txCbor');
  }
  if (!poolId || typeof poolId !== 'string') {
    throw new Error('Invalid poolId');
  }
  if (utxo && isValidUTxO(utxo)) {
    throw new Error('Invalid UTxO');
  }

  let sponsorUtxo: UTxO;

  if (utxo) {
    const utxos = await this.blockchainProvider.fetchUTxOs(
      utxo.txHash,
      utxo.outputIndex
    );

    if (utxos.length === 0) {
      throw new Error(`No UTxOs found for ${utxo ? 'provided UTxO' : 'poolId'}. Please ensure the address has sufficient funds.`);
    }

    sponsorUtxo = keepRelevant(DEFAULT_FEE_ASSET, utxos)[0];
  } else {
    const utxos: UTxO[] = await this.blockchainProvider.fetchAddressUTxOs(poolId);

    if (utxos.length === 0) {
      throw new Error(`No UTxOs found for ${utxo ? 'provided UTxO' : 'poolId'}. Please ensure the address has sufficient funds.`);
    }

    sponsorUtxo = keepRelevant(DEFAULT_FEE_ASSET, utxos)[0];
    ;
  }

  const baseTx = Transaction.fromCbor(TxCBOR(txCbor));

  const inputUtxoMap: Map<
    Serialization.TransactionInput,
    Serialization.TransactionOutput
  > = new Map();

  const includedScripts = new Set<string>();

  const txBody = baseTx.body();
  const inputSet = baseTx.body().inputs();

  for (const script of baseTx.witnessSet().nativeScripts()?.values() ??
    []) {
    includedScripts.add(script.toCbor().toString());
  }

  for (const input of inputSet.values()) {
    const [inputInfo] = await this.blockchainProvider.fetchUTxOs(
      input.transactionId(),
      parseInt(input.index().toString())
    );

    if (!inputInfo) {
      throw new Error(`No UTxO found for transaction ${input.transactionId()} index ${input.index()}`);
    }

    const cardanoTxOut = new TransactionOutput(
      toCardanoAddress(inputInfo.output.address),
      toValue(inputInfo.output.amount)
    );

    inputUtxoMap.set(input, cardanoTxOut);

    if (inputInfo.output.scriptRef) {
      includedScripts.add(inputInfo.output.scriptRef.toString());
    }
  }

  const txOutputs = baseTx.body().outputs();

  let sponsorOutput = new TransactionOutput(
    toCardanoAddress(sponsorUtxo.output.address),
    toValue(sponsorUtxo.output.amount)
  );

  const updatedInputs: TransactionInput[] = [...inputSet.values()];
  const updatedOutputs: TransactionOutput[] = [...txOutputs.values()];

  const sponsorInput = new TransactionInput(
    TransactionId(sponsorUtxo.input.txHash),
    BigInt(sponsorUtxo.input.outputIndex)
  );

  updatedInputs.push(sponsorInput);
  updatedOutputs.push(sponsorOutput);

  inputSet.setValues(updatedInputs);
  console.log(inputSet.size());

  txBody.setInputs(inputSet);

  txBody.setOutputs(updatedOutputs);

  const requiredSignersSet: Serialization.CborSet<
    Ed25519KeyHashHex,
    Serialization.Hash<Ed25519KeyHashHex>
  > = txBody.requiredSigners() ??
    Serialization.CborSet.fromCore([], Serialization.Hash.fromCore);

  let signers = [...requiredSignersSet.values()];

  signers.push(
    Serialization.Hash.fromCore(
      Ed25519KeyHashHex(
        deserializeAddress(poolId).asBase()?.getPaymentCredential().hash!
      )
    )
  );

  requiredSignersSet.setValues(signers);

  txBody.setRequiredSigners(requiredSignersSet);
  txBody.setFee(100000n);

  const protocolParams = await this.blockchainProvider.fetchProtocolParameters();

  const referenceScripts = txBody.referenceInputs()?.values() ?? [];

  let totalRefScriptSize = 0;

  for (const script of referenceScripts) {
    const [utxo] = await this.blockchainProvider.fetchUTxOs(
      script.transactionId(),
      parseInt(script.index().toString())
    );

    if (!utxo) throw new Error(`Reference script UTxO not found for ${script.transactionId()} index ${script.index()}`);

    totalRefScriptSize = utxo.output.scriptRef
      ? totalRefScriptSize + utxo.output.scriptRef.length / 2
      : totalRefScriptSize;
  }

  if (sponsorUtxo.output.scriptRef) {
    totalRefScriptSize = totalRefScriptSize + sponsorUtxo.output.scriptRef.length / 2;
  }

  const calculatedFee = calculateFees(
    protocolParams.minFeeA,
    protocolParams.minFeeB,
    protocolParams.minFeeRefScriptCostPerByte,
    protocolParams.priceMem,
    protocolParams.priceStep,
    createDummyTx(baseTx, txBody,
      countNumberOfRequiredWitnesses(txBody, inputUtxoMap, includedScripts)
    ),
    totalRefScriptSize
  );

  txBody.setFee(calculatedFee);

  let adjustedSponsorOutput = new TransactionOutput(
    toCardanoAddress(sponsorUtxo.output.address),
    toValue(
      sponsorUtxo.output.amount.map((a) =>
        a.unit === "lovelace"
          ? { unit: a.unit, quantity: String(BigInt(a.quantity) - calculatedFee) }
          : a
      )
    )
  );

  const finalOutputs: TransactionOutput[] = [...txOutputs.values()];

  finalOutputs.push(adjustedSponsorOutput);

  txBody.setOutputs(finalOutputs);

  const sponsoredTx = new Transaction(
    txBody,
    baseTx.witnessSet(),
    baseTx.auxiliaryData()
  );

  const sponsoredTxCbor = sponsoredTx.toCbor();

  return sponsoredTxCbor;
}
