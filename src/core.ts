import {
  type Address,
  Ed25519KeyHashHex,
  Serialization,
  type TokenMap,
  Transaction,
  TransactionId,
  TransactionInput,
  TransactionOutput,
  deserializeAddress,
  toCardanoAddress,
  toValue,
} from "@meshsdk/core-cst";
import { GaslessError, ValidationError } from "./errors.js";
import { calculateFees, countNumberOfRequiredWitnesses, createDummyTx, utxoKey } from "./fees.js";
import { TxCBOR } from "./hex.js";
import { assertBodyPolicy, assertNoPoolKeyScripts, resolvePolicy } from "./policy.js";
import { resolveProvider } from "./provider.js";
import type {
  Asset,
  ComparisonOperator,
  GaslessProvider,
  PoolConditions,
  PoolInfo,
  SponsorTxParams,
  UTxO,
  ValidateTxParams,
} from "./types.js";

/** Lovelace the sponsoring UTxO must carry before it is considered usable. */
const MIN_SPONSOR_LOVELACE = 3_000_000n;
/** Ledger constant: every output's min-ADA includes this byte overhead. */
const MIN_UTXO_OVERHEAD_BYTES = 160n;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a UTxO handed to one sponsorship stays off-limits to the next.
 *
 * Long enough for the caller to get the transaction signed and submitted,
 * short enough that an abandoned attempt frees the funds again.
 */
const DEFAULT_RESERVATION_MS = 120_000;

export const comparisons: Record<ComparisonOperator, (a: bigint, b: bigint) => boolean> = {
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gte: (a, b) => a >= b,
  lte: (a, b) => a <= b,
};

/** A resolved transaction input: the reference plus the output it spends. */
export interface ResolvedInput {
  input: Serialization.TransactionInput;
  utxo: UTxO;
  output: Serialization.TransactionOutput;
}

/** Lovelace and native assets moving in or out of the pool. */
export interface PoolValue {
  lovelace: bigint;
  assets: TokenMap | undefined;
}

const lovelaceOf = (amount: Asset[]): bigint =>
  amount.reduce(
    (total, asset) => (asset.unit === "lovelace" ? total + BigInt(asset.quantity) : total),
    0n,
  );

const sumLovelace = (values: PoolValue[]): bigint =>
  values.reduce((total, value) => total + value.lovelace, 0n);

/** Aggregate every asset held across a set of UTxOs into unit -> quantity. */
export const utxosToAssets = (utxos: UTxO[]): Record<string, bigint> => {
  const totals: Record<string, bigint> = {};
  for (const utxo of utxos) {
    for (const asset of utxo.output.amount) {
      totals[asset.unit] = (totals[asset.unit] ?? 0n) + BigInt(asset.quantity);
    }
  }
  return totals;
};

/** Payment credential of a bech32 address, whether base or enterprise. */
export const paymentKeyHashOf = (address: string): string => {
  let parsed: Address;
  try {
    parsed = deserializeAddress(address);
  } catch (error) {
    throw new GaslessError("InvalidInput", `Not a valid Cardano address: ${address}`, error);
  }

  const hash = parsed.getProps().paymentPart?.hash;
  if (!hash) {
    throw new GaslessError(
      "InvalidInput",
      `Address ${address} has no payment credential and cannot sponsor transactions.`,
    );
  }
  return hash;
};

/**
 * Shared engine for both modes.
 *
 * Holds everything that works purely off a provider and a transaction: fee
 * splicing (`sponsorTx`), pool-side rule checks, and the client half of the
 * signing round trip. Wallet and HTTP server live in `index.ts` / `server.ts`
 * so the browser entry can reuse this file without pulling in Node builtins.
 */
export class GaslessCore {
  readonly provider: GaslessProvider;
  conditions: PoolConditions;

  /**
   * UTxOs handed to an in-flight sponsorship, keyed by `txHash#index` with the
   * timestamp they free up again. Without this, concurrent requests all pick
   * the same largest UTxO and every transaction but one dies on submission.
   *
   * In-process only: it serialises one pool server, not a cluster.
   */
  private readonly reservations = new Map<string, number>();
  private readonly reservationMs: number;

  constructor(
    options: ({ apiKey: string } | { provider: GaslessProvider }) & {
      conditions?: PoolConditions;
      /** How long a selected UTxO stays reserved (default 120000 ms). */
      reservationMs?: number;
    },
  ) {
    this.provider = resolveProvider(options);
    this.conditions = options.conditions ?? {};
    this.reservationMs = options.reservationMs ?? DEFAULT_RESERVATION_MS;
  }

  /** Free a reserved UTxO early, once its transaction has been submitted or abandoned. */
  releaseUtxo(utxo: { txHash: string; outputIndex: number }): void {
    this.reservations.delete(`${utxo.txHash}#${utxo.outputIndex}`);
  }

  private reserve(utxo: UTxO): void {
    this.reservations.set(
      `${utxo.input.txHash}#${utxo.input.outputIndex}`,
      Date.now() + this.reservationMs,
    );
  }

  private isReserved(utxo: UTxO): boolean {
    const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
    const until = this.reservations.get(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.reservations.delete(key);
      return false;
    }
    return true;
  }

  setConditions(conditions: PoolConditions): void {
    this.conditions = conditions ?? {};
  }

  /**
   * Fetch every input of a transaction exactly once, in parallel.
   *
   * All validators run off this single map. Resolving per-validator, as the
   * previous implementation did, refetched the same UTxOs up to three times
   * and serialized every request.
   */
  async resolveInputs(baseTx: Transaction): Promise<ResolvedInput[]> {
    return this.resolveInputSet(baseTx.body().inputs().values());
  }

  /**
   * Resolve the transaction's collateral inputs.
   *
   * Collateral is a separate input set that the value accounting never sees:
   * it is consumed only when a Plutus script fails, and then it is forfeited
   * whole. Pool funds must never back it.
   */
  async resolveCollateral(baseTx: Transaction): Promise<ResolvedInput[]> {
    return this.resolveInputSet(baseTx.body().collateral()?.values() ?? []);
  }

  private async resolveInputSet(
    inputs: readonly Serialization.TransactionInput[],
  ): Promise<ResolvedInput[]> {
    return Promise.all(
      inputs.map(async (input) => {
        const txHash = input.transactionId();
        const index = Number(input.index());
        const [utxo] = await this.provider.fetchUTxOs(txHash, index);

        if (!utxo) {
          throw new GaslessError(
            "UtxoNotFound",
            `No UTxO found for transaction ${txHash} index ${index}.`,
          );
        }

        return {
          input,
          utxo,
          output: new TransactionOutput(
            toCardanoAddress(utxo.output.address),
            toValue(utxo.output.amount),
          ),
        };
      }),
    );
  }

  /**
   * Value the pool puts into the transaction.
   *
   * Matched on the payment credential: the pool's key controls those funds
   * regardless of which stake credential is attached to the address.
   */
  consumedByPool(resolved: ResolvedInput[], poolPaymentKeyHash: string): PoolValue[] {
    return resolved
      .filter(({ output }) => output.address().getProps().paymentPart?.hash === poolPaymentKeyHash)
      .map(({ output }) => ({
        lovelace: output.amount().coin(),
        assets: output.amount().multiasset(),
      }));
  }

  /**
   * Value returned to the pool.
   *
   * Compared against the pool's full address, not just its payment credential:
   * an output that reuses the payment key with a different stake credential
   * would still be spendable by the pool but silently redirects its staking
   * rewards, so it does not count as a return.
   */
  producedForPool(baseTx: Transaction, poolAddress: string): PoolValue[] {
    return baseTx
      .body()
      .outputs()
      .filter((output) => output.address().toBech32() === poolAddress)
      .map((output) => ({
        lovelace: output.amount().coin(),
        assets: output.amount().multiasset(),
      }));
  }

  /**
   * The pool must never lose more lovelace than the network fee.
   *
   * Deliberately an upper bound rather than an equality. A transaction that
   * also pays the pool — a service fee, a purchase — leaves the pool net
   * positive, which is safe; demanding exact equality rejected those outright.
   * Anything the pool loses beyond the fee is value leaving the pool, and that
   * is what this refuses.
   */
  validateFeeDifference(consumed: PoolValue[], produced: PoolValue[], fee: bigint): void {
    const spent = sumLovelace(consumed);
    const returned = sumLovelace(produced);
    const netPaidByPool = spent - returned;

    if (netPaidByPool > fee) {
      throw new ValidationError(
        "FeeMismatch",
        `Pool would lose ${netPaidByPool} lovelace but the transaction fee is only ${fee} (consumed ${spent}, returned ${returned}).`,
      );
    }
  }

  /** Every native asset the pool puts in must come back out untouched. */
  validateAssets(consumed: PoolValue[], produced: PoolValue[]): void {
    const consumedAssets = new Map<string, bigint>();
    for (const { assets } of consumed) {
      for (const [assetId, quantity] of assets?.entries() ?? []) {
        consumedAssets.set(
          assetId.toString(),
          (consumedAssets.get(assetId.toString()) ?? 0n) + quantity,
        );
      }
    }

    const producedAssets = new Map<string, bigint>();
    for (const { assets } of produced) {
      for (const [assetId, quantity] of assets?.entries() ?? []) {
        producedAssets.set(
          assetId.toString(),
          (producedAssets.get(assetId.toString()) ?? 0n) + quantity,
        );
      }
    }

    for (const [assetId, quantity] of consumedAssets) {
      const returned = producedAssets.get(assetId) ?? 0n;
      if (returned !== quantity) {
        throw new ValidationError(
          "AssetMismatch",
          `Pool asset ${assetId} would change from ${quantity} to ${returned}; sponsors must not move native assets.`,
        );
      }
    }
  }

  /**
   * At least one non-pool input address must satisfy at least one requirement.
   *
   * A requirement the address cannot meet is not fatal on its own — another
   * requirement or another address may still qualify the transaction.
   */
  async validateTokenRequirements(
    resolved: ResolvedInput[],
    poolPaymentKeyHash: string,
  ): Promise<void> {
    const requirements = this.conditions.tokenRequirements;
    if (!requirements?.length) {
      throw new ValidationError(
        "MissingConditions",
        "No token requirements configured for this pool.",
      );
    }

    const userAddresses = new Set(
      resolved
        .filter(
          ({ output }) => output.address().getProps().paymentPart?.hash !== poolPaymentKeyHash,
        )
        .map(({ utxo }) => utxo.output.address),
    );

    const failures: string[] = [];

    for (const address of userAddresses) {
      const holdings = utxosToAssets(await this.provider.fetchAddressUTxOs(address));

      for (const { unit, comparison, quantity } of requirements) {
        const held = holdings[unit] ?? 0n;
        if (comparisons[comparison](held, BigInt(quantity))) return;
        failures.push(`${address} holds ${held} of ${unit}, needs ${comparison} ${quantity}`);
      }
    }

    throw new ValidationError(
      "TokenRequirementNotMet",
      failures.length > 0
        ? `No input address meets the pool's token requirements (${failures.join("; ")}).`
        : "The transaction has no non-pool inputs to check token requirements against.",
    );
  }

  /** At least one input must come from a whitelisted address. */
  async validateWhitelist(resolved: ResolvedInput[]): Promise<void> {
    const whitelist = this.conditions.whitelist;
    if (!whitelist?.length) {
      throw new ValidationError("MissingConditions", "No whitelist configured for this pool.");
    }

    const allowed = new Set(whitelist);
    if (resolved.some(({ utxo }) => allowed.has(utxo.output.address))) return;

    throw new ValidationError(
      "AddressNotWhitelisted",
      "No input address is on the pool's whitelist.",
    );
  }

  /**
   * Run every configured rule against an already-resolved transaction.
   *
   * Each check is awaited: an unawaited rejection here previously meant the
   * pool signed transactions that had failed validation.
   */
  async validateConditions(
    baseTx: Transaction,
    resolved: ResolvedInput[],
    pool: { address: string; paymentKeyHash: string },
  ): Promise<void> {
    const policy = resolvePolicy(this.conditions.policy);

    // Refuse unsupported features before touching the arithmetic: the pool
    // must never reason about a body it does not fully understand.
    assertBodyPolicy(baseTx, policy);
    assertNoPoolKeyScripts(baseTx, pool.paymentKeyHash, policy);
    await this.validateCollateral(baseTx, pool.paymentKeyHash, policy.allowPoolCollateral);

    const consumed = this.consumedByPool(resolved, pool.paymentKeyHash);
    const produced = this.producedForPool(baseTx, pool.address);

    if (consumed.length === 0) {
      throw new ValidationError(
        "PoolOutputMismatch",
        "The transaction spends no pool UTxO, so there is nothing for the pool to sponsor.",
      );
    }

    this.validateFeeDifference(consumed, produced, baseTx.body().fee());
    this.validateAssets(consumed, produced);

    if (this.conditions.tokenRequirements?.length) {
      await this.validateTokenRequirements(resolved, pool.paymentKeyHash);
    }
    if (this.conditions.whitelist?.length) {
      await this.validateWhitelist(resolved);
    }
  }

  /**
   * Refuse collateral drawn from pool funds.
   *
   * A failing Plutus script forfeits the whole collateral to the network, so an
   * attacker who can name a pool UTxO as collateral can burn it deliberately —
   * and none of it shows up in the input/output accounting.
   */
  async validateCollateral(
    baseTx: Transaction,
    poolPaymentKeyHash: string,
    allowPoolCollateral: boolean,
  ): Promise<void> {
    if (allowPoolCollateral) return;
    if ((baseTx.body().collateral()?.values().length ?? 0) === 0) return;

    const collateral = await this.resolveCollateral(baseTx);
    const atRisk = collateral.filter(
      ({ output }) => output.address().getProps().paymentPart?.hash === poolPaymentKeyHash,
    );

    if (atRisk.length > 0) {
      const lovelace = atRisk.reduce((total, { output }) => total + output.amount().coin(), 0n);
      throw new ValidationError(
        "PoolCollateralForbidden",
        `The transaction puts ${lovelace} lovelace of pool funds up as collateral. A failing script would forfeit it entirely; collateral must come from the requester.`,
      );
    }
  }

  /**
   * Add a pool UTxO to a transaction and charge the whole network fee to it.
   *
   * The pool's own output is reduced by the fee, so the user's outputs are
   * untouched and the user pays nothing.
   */
  async sponsorTx({ txCbor, poolId, utxo }: SponsorTxParams): Promise<string> {
    if (!poolId || typeof poolId !== "string") {
      throw new GaslessError("InvalidInput", "`poolId` must be a bech32 pool address.");
    }
    const poolPaymentKeyHash = paymentKeyHashOf(poolId);
    const baseTx = Transaction.fromCbor(TxCBOR(txCbor));
    const sponsorUtxo = await this.selectSponsorUtxo(poolId, poolPaymentKeyHash, utxo);

    const txBody = baseTx.body();
    const originalOutputs = txBody.outputs();
    const resolved = await this.resolveInputs(baseTx);

    const inputContext = new Map<string, Serialization.TransactionOutput>(
      resolved.map(({ input, output }) => [utxoKey(input), output]),
    );
    const includedScripts = new Set<string>();
    for (const script of baseTx.witnessSet().nativeScripts()?.values() ?? []) {
      includedScripts.add(script.toCbor().toString());
    }
    for (const { utxo: resolvedUtxo } of resolved) {
      if (resolvedUtxo.output.scriptRef) includedScripts.add(resolvedUtxo.output.scriptRef);
    }

    const sponsorInput = new TransactionInput(
      TransactionId(sponsorUtxo.input.txHash),
      BigInt(sponsorUtxo.input.outputIndex),
    );
    const sponsorAddress = toCardanoAddress(sponsorUtxo.output.address);

    const inputSet = txBody.inputs();
    inputSet.setValues([...inputSet.values(), sponsorInput]);
    txBody.setInputs(inputSet);
    inputContext.set(
      utxoKey(sponsorInput),
      new TransactionOutput(sponsorAddress, toValue(sponsorUtxo.output.amount)),
    );

    // The ledger must reject any submission that lacks the pool's signature,
    // otherwise a user could strip it and spend the pool UTxO themselves.
    const requiredSigners =
      txBody.requiredSigners() ?? Serialization.CborSet.fromCore([], Serialization.Hash.fromCore);
    requiredSigners.setValues([
      ...requiredSigners.values(),
      Serialization.Hash.fromCore(Ed25519KeyHashHex(poolPaymentKeyHash)),
    ]);
    txBody.setRequiredSigners(requiredSigners);

    const params = await this.provider.fetchProtocolParameters();
    const refScriptSize = await this.totalReferenceScriptSize(baseTx, sponsorUtxo);
    const witnessCount = countNumberOfRequiredWitnesses(txBody, inputContext, includedScripts);

    const buildSponsorOutput = (fee: bigint): TransactionOutput =>
      new TransactionOutput(
        sponsorAddress,
        toValue(
          sponsorUtxo.output.amount.map((asset) =>
            asset.unit === "lovelace"
              ? { ...asset, quantity: (BigInt(asset.quantity) - fee).toString() }
              : asset,
          ),
        ),
      );

    // Two passes: the fee changes the sponsor output's encoded size, which in
    // turn changes the fee. The second pass settles it.
    let fee = 0n;
    for (let pass = 0; pass < 2; pass++) {
      txBody.setOutputs([...originalOutputs, buildSponsorOutput(fee)]);
      txBody.setFee(fee);
      fee = calculateFees(params, createDummyTx(baseTx, txBody, witnessCount), refScriptSize);
    }

    const sponsorOutput = buildSponsorOutput(fee);
    this.assertSponsorOutputViable(sponsorUtxo, sponsorOutput, fee, params.coinsPerUtxoSize);

    txBody.setOutputs([...originalOutputs, sponsorOutput]);
    txBody.setFee(fee);

    return new Transaction(txBody, baseTx.witnessSet(), baseTx.auxiliaryData()).toCbor();
  }

  /**
   * Check a sponsored transaction against the pool's published rules, then ask
   * the pool server to sign it.
   *
   * Validating client-side is a courtesy that fails fast with a useful error;
   * the pool server re-runs every check before it signs.
   */
  async validateTx({
    txCbor,
    poolSignServer,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: ValidateTxParams): Promise<string> {
    if (!poolSignServer || typeof poolSignServer !== "string") {
      throw new GaslessError(
        "InvalidInput",
        "`poolSignServer` must be the pool server's base URL.",
      );
    }

    const baseUrl = poolSignServer.replace(/\/+$/, "");
    const baseTx = Transaction.fromCbor(TxCBOR(txCbor));

    const poolInfo = await this.requestJson<PoolInfo>(
      `${baseUrl}/conditions`,
      { method: "GET" },
      timeoutMs,
    );
    if (!poolInfo?.address || !poolInfo?.paymentKeyHash) {
      throw new GaslessError(
        "SigningServerError",
        "Pool server did not return its address; is it running this version of the library?",
      );
    }

    this.setConditions(poolInfo.conditions ?? {});
    const resolved = await this.resolveInputs(baseTx);
    await this.validateConditions(baseTx, resolved, poolInfo);

    const response = await this.requestJson<{
      data?: string;
      error?: { message?: string } | string;
    }>(
      baseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txCbor }),
      },
      timeoutMs,
    );

    if (!response?.data) {
      const detail =
        typeof response?.error === "string" ? response.error : response?.error?.message;
      throw new GaslessError(
        "SigningServerError",
        detail ?? "Pool server refused to sign the transaction.",
      );
    }

    return response.data;
  }

  private async requestJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as T) : (undefined as T);

      if (!response.ok) {
        const detail =
          (parsed as { error?: { message?: string } } | undefined)?.error?.message ?? text;
        throw new GaslessError(
          "SigningServerError",
          `Pool server responded ${response.status}: ${detail}`,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof GaslessError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GaslessError(
          "SigningServerError",
          `Pool server did not respond within ${timeoutMs}ms.`,
        );
      }
      throw new GaslessError("SigningServerError", `Could not reach pool server at ${url}.`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async selectSponsorUtxo(
    poolId: string,
    poolPaymentKeyHash: string,
    pinned: SponsorTxParams["utxo"],
  ): Promise<UTxO> {
    if (pinned) {
      if (typeof pinned.txHash !== "string" || !Number.isInteger(pinned.outputIndex)) {
        throw new GaslessError(
          "InvalidInput",
          "`utxo` needs a `txHash` string and integer `outputIndex`.",
        );
      }

      const [utxo] = await this.provider.fetchUTxOs(pinned.txHash, pinned.outputIndex);
      if (!utxo) {
        throw new GaslessError(
          "UtxoNotFound",
          `Pool UTxO ${pinned.txHash}#${pinned.outputIndex} does not exist or is already spent.`,
        );
      }
      if (paymentKeyHashOf(utxo.output.address) !== poolPaymentKeyHash) {
        throw new GaslessError(
          "InvalidInput",
          `Pool UTxO ${pinned.txHash}#${pinned.outputIndex} belongs to ${utxo.output.address}, not to ${poolId}.`,
        );
      }
      if (lovelaceOf(utxo.output.amount) < MIN_SPONSOR_LOVELACE) {
        throw new GaslessError(
          "InsufficientPoolFunds",
          `Pool UTxO ${pinned.txHash}#${pinned.outputIndex} holds ${lovelaceOf(utxo.output.amount)} lovelace, below the ${MIN_SPONSOR_LOVELACE} needed to sponsor a transaction.`,
        );
      }
      this.reserve(utxo);
      return utxo;
    }

    const utxos = await this.provider.fetchAddressUTxOs(poolId);
    const funded = utxos.filter((entry) => lovelaceOf(entry.output.amount) >= MIN_SPONSOR_LOVELACE);
    // Largest first: one UTxO must cover the whole fee, and the biggest is the
    // most likely to also clear min-ADA once the fee is deducted.
    const candidate = funded
      .filter((entry) => !this.isReserved(entry))
      .sort((a, b) => Number(lovelaceOf(b.output.amount) - lovelaceOf(a.output.amount)))[0];

    if (!candidate) {
      throw new GaslessError(
        "InsufficientPoolFunds",
        funded.length > 0
          ? `Every funded UTxO at ${poolId} is reserved by an in-flight sponsorship. Retry shortly, or split the pool into more UTxOs to raise concurrency.`
          : `No UTxO at ${poolId} holds the ${MIN_SPONSOR_LOVELACE} lovelace needed to sponsor a transaction.`,
      );
    }

    this.reserve(candidate);
    return candidate;
  }

  private assertSponsorOutputViable(
    sponsorUtxo: UTxO,
    sponsorOutput: TransactionOutput,
    fee: bigint,
    coinsPerUtxoSize: number,
  ): void {
    const available = lovelaceOf(sponsorUtxo.output.amount);
    if (available <= fee) {
      throw new GaslessError(
        "InsufficientPoolFunds",
        `Sponsoring UTxO holds ${available} lovelace but the fee is ${fee}.`,
      );
    }

    const outputBytes = BigInt(sponsorOutput.toCbor().length / 2);
    const minAda = (MIN_UTXO_OVERHEAD_BYTES + outputBytes) * BigInt(coinsPerUtxoSize);
    const remaining = available - fee;

    if (remaining < minAda) {
      throw new GaslessError(
        "InsufficientPoolFunds",
        `Sponsoring UTxO would be left with ${remaining} lovelace after the ${fee} fee, below the ${minAda} min-ADA for its own output. Use a larger pool UTxO.`,
      );
    }
  }

  private async totalReferenceScriptSize(baseTx: Transaction, sponsorUtxo: UTxO): Promise<number> {
    const references = baseTx.body().referenceInputs()?.values() ?? [];

    const sizes = await Promise.all(
      references.map(async (reference) => {
        const txHash = reference.transactionId();
        const index = Number(reference.index());
        const [utxo] = await this.provider.fetchUTxOs(txHash, index);

        if (!utxo) {
          throw new GaslessError(
            "UtxoNotFound",
            `Reference input ${txHash}#${index} does not exist.`,
          );
        }
        return utxo.output.scriptRef ? utxo.output.scriptRef.length / 2 : 0;
      }),
    );

    const sponsorRefSize = sponsorUtxo.output.scriptRef
      ? sponsorUtxo.output.scriptRef.length / 2
      : 0;
    return sizes.reduce((total, size) => total + size, sponsorRefSize);
  }
}
