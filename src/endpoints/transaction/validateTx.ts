import {
  Hash28ByteBase16,
  Serialization,
  toCardanoAddress,
  TokenMap,
  toValue,
  Transaction,
  TransactionOutput,
} from "@meshsdk/core-cst";
import { TxCBOR, ValidationError } from "../../utils";
import { Gasless, GaslessClient, PoolConditions, ValidateTxParams } from "../../@types/types";
import axios from "axios";

export async function validateTx(
  this: Gasless | GaslessClient,
  { txCbor, poolSignServer }: ValidateTxParams
): Promise<TxCBOR> {
  const baseTx = Transaction.fromCbor(TxCBOR(txCbor));

  const { data: poolDetails } = await axios.get<{
    conditions: PoolConditions,
    pubKey: string
  }>(`${poolSignServer}/conditions`);

  const sponsorInputMap: Map<
    Serialization.TransactionInput,
    Serialization.TransactionOutput
  > = await (this as Gasless).getSponsoredInputMap(baseTx, poolDetails.pubKey as unknown as Hash28ByteBase16);

  console.log(sponsorInputMap)

  const consumedUTXO: {
    lovelace: bigint;
    assets: TokenMap | undefined;
  }[] = this.getConsumedUtxos(sponsorInputMap);

  const producedUTXO: {
    lovelace: bigint;
    assets: TokenMap | undefined;
  }[] = this.getProducedUtxos(baseTx, poolDetails.pubKey as unknown as Hash28ByteBase16);

  this.validateFeeDifference(consumedUTXO, producedUTXO, baseTx.body().fee())

  this.validateAssets(consumedUTXO, producedUTXO)

  this.setConditions(poolDetails.conditions)

  if (!poolDetails) {
    throw new ValidationError('Signing server error');
  }

  if (poolDetails.conditions?.tokenRequirements) {
    this.validateTokenRequirements(baseTx, poolDetails.pubKey as unknown as Hash28ByteBase16)
  }

  if (poolDetails.conditions?.whitelist) {
    this.validateWhitelist(baseTx)
  }

  const { data: response } = await axios.post<{
    data: string;
    error: string | undefined;
    success: boolean;
  }>(poolSignServer, { txCbor });

  if (!response.success || response.error) {
    throw new ValidationError('Signing server error', response.error);
  }

  return TxCBOR(response.data);
}

