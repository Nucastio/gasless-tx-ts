import {
  CertificateType,
  Ed25519PublicKeyHex,
  Ed25519SignatureHex,
  NativeScript,
  PoolId,
  RequireAllOf,
  RequireAnyOf,
  RequireNOf,
  RequireSignature,
  RequireTimeAfter,
  RequireTimeBefore,
  RewardAccount,
  Serialization,
  Transaction,
  type TransactionBody,
  TransactionWitnessSet,
  VkeyWitness,
} from "@meshsdk/core-cst";
import { HexBlob } from "./hex.js";

/**
 * Stable key for a transaction input.
 *
 * The witness map is keyed by value, not by object identity: `inputs()` may
 * hand back freshly deserialized objects on each call, and an identity-keyed
 * lookup would silently miss every input and under-count the witnesses.
 */
export const utxoKey = (input: Serialization.TransactionInput): string =>
  `${input.transactionId()}#${input.index()}`;

/** Reference-script fee tier width, in bytes (Conway ledger constant). */
const REF_SCRIPT_TIER_SIZE = 25_600;
/** Price growth per reference-script tier (Conway ledger constant). */
const REF_SCRIPT_TIER_MULTIPLIER = 1.2;

/** Convert a decimal price such as 0.0577 into an exact rational. */
const toRational = (value: number): { numerator: bigint; denominator: bigint } => {
  let numerator = value;
  let denominator = 1;
  // Protocol prices have at most a handful of decimals; the bound stops a
  // pathological float from looping forever.
  for (let i = 0; numerator % 1 !== 0 && i < 20; i++) {
    numerator *= 10;
    denominator *= 10;
  }
  return { numerator: BigInt(Math.round(numerator)), denominator: BigInt(denominator) };
};

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

export interface FeeParameters {
  minFeeA: number;
  minFeeB: number;
  minFeeRefScriptCostPerByte: number;
  priceMem: number;
  priceStep: number;
}

/**
 * Reference-script fee: the first {@link REF_SCRIPT_TIER_SIZE} bytes cost the
 * base price, and each subsequent tier costs 1.2x the previous one.
 */
export const referenceScriptFee = (sizeBytes: number, costPerByte: number): number => {
  let fee = 0;
  let remaining = sizeBytes;
  let price = costPerByte;

  while (remaining > REF_SCRIPT_TIER_SIZE) {
    fee += REF_SCRIPT_TIER_SIZE * price;
    remaining -= REF_SCRIPT_TIER_SIZE;
    price *= REF_SCRIPT_TIER_MULTIPLIER;
  }

  return fee + remaining * price;
};

/**
 * Minimum fee for a fully-witnessed transaction:
 * `minFeeA * size + minFeeB + referenceScriptFee + executionUnitFee`.
 */
export const calculateFees = (
  params: FeeParameters,
  tx: Transaction,
  refScriptSize = 0,
): bigint => {
  const sizeBytes = tx.toCbor().length / 2;
  const baseFee =
    params.minFeeB +
    sizeBytes * params.minFeeA +
    referenceScriptFee(refScriptSize, params.minFeeRefScriptCostPerByte);

  const mem = toRational(params.priceMem);
  const step = toRational(params.priceStep);

  let scriptFee = 0n;
  const redeemers = tx.witnessSet().redeemers();
  if (redeemers) {
    for (const redeemer of redeemers.values()) {
      scriptFee += ceilDiv(redeemer.exUnits().mem() * mem.numerator, mem.denominator);
      scriptFee += ceilDiv(redeemer.exUnits().steps() * step.numerator, step.denominator);
    }
  }

  return BigInt(Math.ceil(baseFee)) + scriptFee;
};

/**
 * Count distinct vkey witnesses the ledger will require, so fee estimation can
 * pad the transaction with the right number of placeholder signatures.
 */
export function countNumberOfRequiredWitnesses(
  txBody: TransactionBody,
  utxoContext: Map<string, Serialization.TransactionOutput>,
  scriptsProvided: Iterable<string>,
): number {
  // Keyed by payment key hash: several inputs may share one key.
  const requiredWitnesses = new Set<string>();

  const addKeyHashInputs = (inputs: readonly Serialization.TransactionInput[] | undefined) => {
    for (const input of inputs ?? []) {
      const paymentPart = utxoContext.get(utxoKey(input))?.address().getProps().paymentPart;
      // Credential type 0 is a key hash; type 1 is a script and needs no vkey.
      if (paymentPart?.type === 0) requiredWitnesses.add(paymentPart.hash);
    }
  };

  addKeyHashInputs(txBody.inputs().values());
  addKeyHashInputs(txBody.collateral()?.values());

  for (const withdrawalKey of txBody.withdrawals()?.keys() ?? []) {
    requiredWitnesses.add(RewardAccount.toHash(withdrawalKey));
  }

  for (const cert of txBody.certs()?.values() ?? []) {
    const core = cert.toCore();
    switch (core.__typename) {
      case CertificateType.StakeRegistration:
      case CertificateType.StakeDeregistration:
      case CertificateType.StakeDelegation:
      case CertificateType.Registration:
      case CertificateType.Unregistration:
      case CertificateType.VoteDelegation:
      case CertificateType.StakeVoteDelegation:
      case CertificateType.StakeRegistrationDelegation:
      case CertificateType.VoteRegistrationDelegation:
      case CertificateType.StakeVoteRegistrationDelegation:
        requiredWitnesses.add(core.stakeCredential.hash);
        break;
      case CertificateType.PoolRegistration:
        for (const owner of core.poolParameters.owners) {
          requiredWitnesses.add(RewardAccount.toHash(owner));
        }
        requiredWitnesses.add(PoolId.toKeyHash(core.poolParameters.id));
        break;
      case CertificateType.PoolRetirement:
        requiredWitnesses.add(PoolId.toKeyHash(core.poolId));
        break;
      case CertificateType.GenesisKeyDelegation:
        requiredWitnesses.add(core.genesisDelegateHash);
        break;
      case CertificateType.AuthorizeCommitteeHot:
        requiredWitnesses.add(core.hotCredential.hash);
        break;
      case CertificateType.ResignCommitteeCold:
        requiredWitnesses.add(core.coldCredential.hash);
        break;
      case CertificateType.RegisterDelegateRepresentative:
      case CertificateType.UnregisterDelegateRepresentative:
      case CertificateType.UpdateDelegateRepresentative:
        requiredWitnesses.add(core.dRepCredential.hash);
        break;
      // MIR certificates carry no witnesses.
      default:
        break;
    }
  }

  for (const scriptHex of scriptsProvided) {
    try {
      addKeyHashesFromNativeScript(NativeScript.fromCbor(HexBlob(scriptHex)), requiredWitnesses);
    } catch {
      // Plutus scripts are witnessed by redeemers, not vkeys.
    }
  }

  for (const signer of txBody.requiredSigners()?.values() ?? []) {
    // `toCore()` yields the bare key hash; `toCbor()` would prefix it and
    // defeat de-duplication against the hashes collected above.
    requiredWitnesses.add(signer.toCore());
  }

  return requiredWitnesses.size;
}

export function addKeyHashesFromNativeScript(
  script: NativeScript,
  keyHashes: Set<string>,
): Set<string> {
  const core = script.toCore();
  switch (core.kind) {
    case RequireSignature:
      keyHashes.add(core.keyHash);
      break;
    case RequireAllOf:
    case RequireAnyOf:
    case RequireNOf:
      for (const inner of core.scripts) {
        addKeyHashesFromNativeScript(NativeScript.fromCore(inner), keyHashes);
      }
      break;
    case RequireTimeAfter:
    case RequireTimeBefore:
      break;
    default:
      break;
  }
  return keyHashes;
}

/**
 * A transaction padded with placeholder signatures, used purely to measure the
 * serialized size the ledger will charge for.
 */
export const createDummyTx = (
  baseTx: Transaction,
  txBody: TransactionBody,
  numberOfRequiredWitnesses: number,
): Transaction => {
  const witnessSet = TransactionWitnessSet.fromCbor(HexBlob(baseTx.witnessSet().toCbor()));

  const dummyVkeyWitnesses: [Ed25519PublicKeyHex, Ed25519SignatureHex][] = [];
  for (let i = 0; i < numberOfRequiredWitnesses; i++) {
    // Must stay valid hex of the exact expected length: a decimal index above 9
    // would double the character count and skew the size estimate.
    const filler = (i % 16).toString(16);
    dummyVkeyWitnesses.push([
      Ed25519PublicKeyHex(filler.repeat(64)),
      Ed25519SignatureHex(filler.repeat(128)),
    ]);
  }

  witnessSet.setVkeys(Serialization.CborSet.fromCore(dummyVkeyWitnesses, VkeyWitness.fromCore));

  return new Transaction(txBody, witnessSet, baseTx.auxiliaryData());
};
