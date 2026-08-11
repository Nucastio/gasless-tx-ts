import type { Transaction } from "@meshsdk/core-cst";
import { ValidationError } from "./errors.js";
import { addKeyHashesFromNativeScript } from "./fees.js";
import type { SponsorshipPolicy } from "./types.js";

/**
 * Defaults: sponsor plain payments and nothing else.
 *
 * A fee sponsor signs a transaction body it did not build. Value accounting
 * alone is not enough, because the pool's signature authorizes far more than
 * spending its own UTxO — it satisfies any native script gated on the pool's
 * key, and it validates collateral drawn from pool funds. So the pool refuses
 * outright anything it does not understand, and an operator opts in per
 * feature. New ledger eras then default to "refuse" instead of silently
 * widening what the pool will sign.
 */
export const DEFAULT_POLICY = {
  allowMint: false,
  allowCertificates: false,
  allowWithdrawals: false,
  allowGovernance: false,
  allowTreasuryOperations: false,
  allowPoolCollateral: false,
  allowPoolKeyScripts: false,
  // Scripts and reference inputs are ordinary traffic and cost the pool nothing
  // beyond the fee it already accounts for, so these stay on.
  allowPlutusScripts: true,
  allowReferenceInputs: true,
  maxInputs: 50,
  maxOutputs: 50,
} satisfies SponsorshipPolicy;

export const resolvePolicy = (policy: SponsorshipPolicy | undefined) => ({
  ...DEFAULT_POLICY,
  ...policy,
});

export type ResolvedPolicy = ReturnType<typeof resolvePolicy>;

const refuse = (field: string, why: string, flag: keyof SponsorshipPolicy): never => {
  throw new ValidationError(
    "UnsupportedTransactionField",
    `This pool does not sponsor transactions with ${field}: ${why} Set \`conditions.policy.${flag} = true\` to allow it.`,
  );
};

/**
 * Reject transaction body fields the pool has not opted into.
 *
 * Runs before any value accounting, so an attacker never gets as far as the
 * arithmetic with a field the pool cannot reason about.
 */
export const assertBodyPolicy = (baseTx: Transaction, policy: ResolvedPolicy): void => {
  const body = baseTx.body();

  const inputCount = body.inputs().values().length;
  if (inputCount > policy.maxInputs) {
    throw new ValidationError(
      "TooManyInputs",
      `Transaction has ${inputCount} inputs, above this pool's limit of ${policy.maxInputs}. Each input costs the pool a chain lookup.`,
    );
  }

  const outputCount = body.outputs().length;
  if (outputCount > policy.maxOutputs) {
    throw new ValidationError(
      "TooManyInputs",
      `Transaction has ${outputCount} outputs, above this pool's limit of ${policy.maxOutputs}.`,
    );
  }

  if (policy.maxTxSizeBytes !== undefined) {
    const sizeBytes = baseTx.toCbor().length / 2;
    if (sizeBytes > policy.maxTxSizeBytes) {
      throw new ValidationError(
        "TooManyInputs",
        `Transaction is ${sizeBytes} bytes, above this pool's limit of ${policy.maxTxSizeBytes}. Larger transactions cost proportionally more fee.`,
      );
    }
  }

  if (policy.maxFeeLovelace !== undefined && body.fee() > policy.maxFeeLovelace) {
    throw new ValidationError(
      "FeeTooHigh",
      `Transaction fee ${body.fee()} exceeds this pool's per-transaction cap of ${policy.maxFeeLovelace} lovelace.`,
    );
  }

  if (policy.blockedAddresses?.length) {
    const blocked = new Set(policy.blockedAddresses);
    for (const output of body.outputs()) {
      const address = output.address().toBech32();
      if (blocked.has(address)) {
        throw new ValidationError(
          "AddressNotWhitelisted",
          `This pool does not sponsor payments to ${address}.`,
        );
      }
    }
  }

  if (!policy.allowPlutusScripts && (baseTx.witnessSet().redeemers()?.values().length ?? 0) > 0) {
    refuse(
      "Plutus script execution",
      "this pool sponsors plain payments only.",
      "allowPlutusScripts",
    );
  }

  if (!policy.allowReferenceInputs && (body.referenceInputs()?.values().length ?? 0) > 0) {
    refuse("reference inputs", "this pool sponsors plain payments only.", "allowReferenceInputs");
  }

  if (!policy.allowMint && (body.mint()?.size ?? 0) > 0) {
    refuse(
      "a mint or burn",
      "the pool's signature can satisfy a minting policy that is gated on the pool's own key, letting anyone issue tokens under it.",
      "allowMint",
    );
  }

  if (!policy.allowCertificates && (body.certs()?.values().length ?? 0) > 0) {
    refuse(
      "certificates",
      "certificates move deposits and can bind credentials the pool controls.",
      "allowCertificates",
    );
  }

  if (!policy.allowWithdrawals && (body.withdrawals()?.size ?? 0) > 0) {
    refuse(
      "reward withdrawals",
      "withdrawals move staking rewards into the transaction balance.",
      "allowWithdrawals",
    );
  }

  if (
    !policy.allowGovernance &&
    (body.votingProcedures() !== undefined || (body.proposalProcedures()?.values().length ?? 0) > 0)
  ) {
    refuse(
      "governance actions",
      "proposals carry deposits and votes would be cast under the pool's credential.",
      "allowGovernance",
    );
  }

  if (
    !policy.allowTreasuryOperations &&
    (body.donation() !== undefined || body.currentTreasuryValue() !== undefined)
  ) {
    refuse(
      "treasury donations",
      "a donation moves value out of the transaction balance.",
      "allowTreasuryOperations",
    );
  }
};

/**
 * Rolling-window ledger of fees the pool has underwritten.
 *
 * Deliberately in-process and dependency-free: it bounds one pool server. A
 * cluster needs a shared store, which is what the `authorize` hook is for.
 */
export class FeeBudget {
  private readonly charges: { at: number; lovelace: bigint }[] = [];

  constructor(private readonly limit: { windowMs: number; maxLovelace: bigint }) {}

  /** Record a fee, or throw if it would breach the window's cap. */
  charge(fee: bigint, now = Date.now()): void {
    this.prune(now);

    const spent = this.charges.reduce((total, charge) => total + charge.lovelace, 0n);
    if (spent + fee > this.limit.maxLovelace) {
      throw new ValidationError(
        "FeeTooHigh",
        `This pool has underwritten ${spent} lovelace in the last ${this.limit.windowMs}ms and its budget is ${this.limit.maxLovelace}; sponsoring another ${fee} would exceed it.`,
      );
    }

    this.charges.push({ at: now, lovelace: fee });
  }

  spent(now = Date.now()): bigint {
    this.prune(now);
    return this.charges.reduce((total, charge) => total + charge.lovelace, 0n);
  }

  private prune(now: number): void {
    const cutoff = now - this.limit.windowMs;
    while (this.charges.length > 0 && (this.charges[0]?.at ?? 0) <= cutoff) {
      this.charges.shift();
    }
  }
}

/**
 * Reject native scripts that the pool's own signature would satisfy.
 *
 * A script such as `RequireSignature(poolPaymentKeyHash)` hashes to a policy id
 * or an address that only the pool's key can unlock. Co-signing the transaction
 * authorizes it, so an attacker could mint under a "pool-issued" policy or
 * unlock script-controlled funds. Value accounting cannot see any of this.
 */
export const assertNoPoolKeyScripts = (
  baseTx: Transaction,
  poolPaymentKeyHash: string,
  policy: ResolvedPolicy,
): void => {
  if (policy.allowPoolKeyScripts) return;

  for (const script of baseTx.witnessSet().nativeScripts()?.values() ?? []) {
    const keyHashes = addKeyHashesFromNativeScript(script, new Set<string>());
    if (keyHashes.has(poolPaymentKeyHash)) {
      throw new ValidationError(
        "UnsupportedTransactionField",
        "The transaction carries a native script requiring the pool's payment key. Co-signing would authorize that script — for example a minting policy issued under the pool's identity.",
      );
    }
  }
};
