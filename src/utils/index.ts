import {
  Transaction,
  TransactionInput,
  TransactionId,
  TransactionOutput,
  toCardanoAddress,
  toValue,
  Ed25519KeyHashHex,
  Ed25519PublicKeyHex,
  deserializeAddress,
  Ed25519SignatureHex,
  TransactionWitnessSet,
  VkeyWitness,
  RewardAccount,
  CertificateType,
  PoolId,
  Script,
  TransactionBody,
  Serialization,
  NativeScript,
  RequireSignature,
  RequireTimeAfter,
  RequireTimeBefore,
  RequireAllOf,
  RequireAnyOf,
  RequireNOf,
} from "@meshsdk/core-cst";

export type OpaqueString<T extends string> = string & {
  /** This helps typescript distinguish different opaque string types. */
  __opaqueString: T;
};

const assertLength = (expectedLength: number | undefined, target: string) => {
  if (expectedLength && target.length !== expectedLength) {
    throw new Error(`expected length '${expectedLength}', got ${target.length}`);
  }
};

const assertIsHexString = (target: string, expectedLength?: number): void => {
  assertLength(expectedLength, target);
  // eslint-disable-next-line wrap-regex
  if (target.length > 0 && !/^[\da-f]+$/i.test(target)) {
    throw new Error('expected hex string');
  }
};

const typedHex = <T>(value: string, length?: number): T => {
  assertIsHexString(value, length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return value as any as T;
};

type HexBlob = OpaqueString<'HexBlob'>;
export const HexBlob = (target: string): HexBlob => typedHex(target);

export type TxCBOR = OpaqueString<"TxCbor">;
export const TxCBOR = (tx: string): TxCBOR => HexBlob(tx) as unknown as TxCBOR;


export const calculateFees = (
  minFeeA: number,
  minFeeB: number,
  minFeeRefScriptCostPerByte: number,
  priceMem: number,
  priceStep: number,
  tx: Transaction,
  refScriptSize: number
): bigint => {
  console.log(tx.toCbor().length);
  let fee = minFeeB + (tx.toCbor().length / 2) * minFeeA;
  console.log(minFeeA, minFeeB);
  const tierSize = 25600;
  let currentRefScriptSize = refScriptSize;
  let multiplier = 1.2;
  while (currentRefScriptSize >= tierSize) {
    fee += tierSize * multiplier * minFeeRefScriptCostPerByte;
    currentRefScriptSize -= tierSize;
    multiplier *= multiplier;
  }
  if (currentRefScriptSize > 0) {
    fee += currentRefScriptSize * multiplier * minFeeRefScriptCostPerByte;
  }
  let scriptFee = BigInt(0);
  let priceMemNumerator = priceMem;
  let priceMemDenominator = 1;
  while (priceMemNumerator % 1) {
    priceMemNumerator *= 10;
    priceMemDenominator *= 10;
  }
  let priceStepNumerator = priceStep;
  let priceStepDenominator = 1;
  while (priceStepNumerator % 1) {
    priceStepNumerator *= 10;
    priceStepDenominator *= 10;
  }
  if (tx.witnessSet().redeemers()) {
    for (const redeemer of tx.witnessSet().redeemers()!.values()) {
      scriptFee +=
        (redeemer.exUnits().mem() * BigInt(priceMemNumerator.toString())) /
          BigInt(priceMemDenominator.toString()) +
        BigInt(1);
      scriptFee +=
        (redeemer.exUnits().steps() * BigInt(priceStepNumerator.toString())) /
          BigInt(priceStepDenominator.toString()) +
        BigInt(1);
    }
  }
  return BigInt(fee) + scriptFee;
};

export function countNumberOfRequiredWitnesses(
  txBody: TransactionBody,
  utxoContext: Map<
    Serialization.TransactionInput,
    Serialization.TransactionOutput
  >,
  scriptsProvided: Set<string>
): number {

  // Use a set of payment key hashes to count, since there
  // could be multiple inputs with the same payment keys
  let requiredWitnesses: Set<string> = new Set();

  // Handle vkey witnesses from inputs
  const inputs = txBody.inputs().values();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    // KeyHash credential type is enum 0
    const addressPaymentPart = utxoContext
      .get(input!)
      ?.address()
      .getProps().paymentPart;
    if (addressPaymentPart?.type === 0) {
      requiredWitnesses.add(addressPaymentPart.hash);
    }
  }

  // Handle vkey witnesses from collateral inputs
  const collateralInputs = txBody.collateral()?.values();
  if (collateralInputs) {
    for (let i = 0; i < collateralInputs?.length; i++) {
      const collateralInput = collateralInputs[i];
      const addressPaymentPart = utxoContext
        .get(collateralInput!)
        ?.address()
        .getProps().paymentPart;
      if (addressPaymentPart?.type === 0) {
        requiredWitnesses.add(addressPaymentPart.hash);
      }
    }
  }

  // Handle vkey witnesses from withdrawals
  const withdrawalKeys = txBody.withdrawals()?.keys();
  if (withdrawalKeys) {
    for (let withdrawalKey of withdrawalKeys) {
      requiredWitnesses.add(RewardAccount.toHash(withdrawalKey));
    }
  }

  // Handle vkey witnesses from certs
  const certs = txBody.certs()?.values();
  if (certs) {
    for (let cert of certs) {
      const coreCert = cert.toCore();
      switch (coreCert.__typename) {
        case CertificateType.StakeRegistration: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.StakeDeregistration: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.PoolRegistration: {
          for (let owner of coreCert.poolParameters.owners) {
            requiredWitnesses.add(RewardAccount.toHash(owner));
          }
          requiredWitnesses.add(PoolId.toKeyHash(coreCert.poolParameters.id));
          break;
        }
        case CertificateType.PoolRetirement: {
          requiredWitnesses.add(PoolId.toKeyHash(coreCert.poolId));
          break;
        }
        case CertificateType.StakeDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.MIR:
          // MIR certs don't contain witnesses
          break;
        case CertificateType.GenesisKeyDelegation: {
          requiredWitnesses.add(coreCert.genesisDelegateHash);
          break;
        }
        case CertificateType.Registration: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.Unregistration: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.VoteDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.StakeVoteDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.StakeRegistrationDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.VoteRegistrationDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.StakeVoteRegistrationDelegation: {
          requiredWitnesses.add(coreCert.stakeCredential.hash);
          break;
        }
        case CertificateType.AuthorizeCommitteeHot: {
          requiredWitnesses.add(coreCert.hotCredential.hash);
          break;
        }
        case CertificateType.ResignCommitteeCold: {
          requiredWitnesses.add(coreCert.coldCredential.hash);
          break;
        }
        case CertificateType.RegisterDelegateRepresentative: {
          requiredWitnesses.add(coreCert.dRepCredential.hash);
          break;
        }
        case CertificateType.UnregisterDelegateRepresentative: {
          requiredWitnesses.add(coreCert.dRepCredential.hash);
          break;
        }
        case CertificateType.UpdateDelegateRepresentative: {
          requiredWitnesses.add(coreCert.dRepCredential.hash);
          break;
        }
      }
    }
  }

  // Handle native scripts in provided scripts
  for (const scriptHex of scriptsProvided) {
    const script = Script.fromCbor(HexBlob(scriptHex));
    let nativeScript = script.asNative();
    if (nativeScript) {
      addKeyHashesFromNativeScript(nativeScript, requiredWitnesses);
    }
  }

  // Handle required signers
  const requiredSigners = txBody.requiredSigners()?.values();
  if (requiredSigners) {
    for (let i = 0; i < requiredSigners.length; i++) {
      requiredWitnesses.add(requiredSigners[i]!.toCbor());
    }
  }
  return requiredWitnesses.size;
}

export function addKeyHashesFromNativeScript(
  script: NativeScript,
  keyHashes: Set<String>
) {
  const scriptCore = script.toCore();
  switch (scriptCore.kind) {
    case RequireSignature: {
      keyHashes.add(scriptCore.keyHash);
      break;
    }
    case RequireTimeAfter: {
      break;
    }
    case RequireTimeBefore: {
      break;
    }
    case RequireAllOf: {
      for (const innerScript of scriptCore.scripts) {
        addKeyHashesFromNativeScript(
          NativeScript.fromCore(innerScript),
          keyHashes
        );
      }
      break;
    }
    case RequireAnyOf: {
      for (const innerScript of scriptCore.scripts) {
        addKeyHashesFromNativeScript(
          NativeScript.fromCore(innerScript),
          keyHashes
        );
      }
      break;
    }
    case RequireNOf: {
      for (const innerScript of scriptCore.scripts) {
        addKeyHashesFromNativeScript(
          NativeScript.fromCore(innerScript),
          keyHashes
        );
      }
      break;
    }
  }
  return keyHashes;
}

export const createDummyTx = (baseTx: Transaction, txBody: TransactionBody, numberOfRequiredWitnesses: number): Transaction => {
  let dummyWitnessSet = TransactionWitnessSet.fromCbor(
    HexBlob(baseTx.witnessSet().toCbor())
  );
  const dummyVkeyWitnesses: [Ed25519PublicKeyHex, Ed25519SignatureHex][] = [];
  for (let i = 0; i < numberOfRequiredWitnesses; i++) {
    dummyVkeyWitnesses.push([
      Ed25519PublicKeyHex(String(i).repeat(64)),
      Ed25519SignatureHex(String(i).repeat(128)),
    ]);
  }
  dummyWitnessSet.setVkeys(
    Serialization.CborSet.fromCore(dummyVkeyWitnesses, VkeyWitness.fromCore)
  );

  return new Transaction(
    txBody,
    dummyWitnessSet,
    baseTx.auxiliaryData()
  );
};

export class ValidationError extends Error {
  constructor(public code: string, message?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const comparisons: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
  eq: (a, b) => a === b,
  gte: (a, b) => a >= b,
  lte: (a, b) => a <= b,
};