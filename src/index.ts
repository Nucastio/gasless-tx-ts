import { Transaction } from "@meshsdk/core-cst";
import { GaslessCore } from "./core.js";
import { GaslessError } from "./errors.js";
import { TxCBOR } from "./hex.js";
import { startPoolServer } from "./server.js";
import type { GaslessOptions, ListenOptions, PoolInfo, PoolServer } from "./types.js";
import { PoolWallet } from "./wallet.js";

export { GaslessCore, comparisons, paymentKeyHashOf, utxosToAssets } from "./core.js";
export { GaslessError, ValidationError, isGaslessError } from "./errors.js";
export type { GaslessErrorCode } from "./errors.js";
export {
  calculateFees,
  countNumberOfRequiredWitnesses,
  createDummyTx,
  referenceScriptFee,
} from "./fees.js";
export { BlockfrostProvider } from "./provider.js";
export type { BlockfrostProviderOptions } from "./provider.js";
export { PoolWallet } from "./wallet.js";
export { startPoolServer } from "./server.js";
export type { PoolServerHandlers } from "./server.js";
export * from "./types.js";

/**
 * Cardano gasless transactions.
 *
 * In `sponsor` mode it splices a pool UTxO into a user's transaction so the
 * pool pays the fee. In `pool` mode it also owns the signing key and can run
 * the HTTP server that co-signs transactions meeting the pool's conditions.
 */
export class Gasless extends GaslessCore {
  readonly mode: "pool" | "sponsor";
  readonly wallet?: PoolWallet;

  private server?: PoolServer;

  constructor(options: GaslessOptions) {
    super(options);

    this.mode = options.mode;
    if (options.mode === "pool") {
      this.wallet = new PoolWallet(options.wallet);
    }
  }

  /** Bech32 address of the pool wallet (pool mode only). */
  get address(): string {
    return this.requireWallet().address;
  }

  /** What this pool publishes to sponsors at `GET /conditions`. */
  poolInfo(): PoolInfo {
    const wallet = this.requireWallet();
    return {
      address: wallet.address,
      paymentKeyHash: wallet.paymentKeyHash,
      conditions: this.conditions,
    };
  }

  /**
   * Validate a sponsored transaction against this pool's conditions and add
   * the pool's signature.
   *
   * This is the authoritative check — a sponsor's client-side validation is
   * only a fast-failure convenience and is never trusted here.
   */
  async validateAndSign(txCbor: string): Promise<string> {
    const wallet = this.requireWallet();
    const baseTx = Transaction.fromCbor(TxCBOR(txCbor));
    const resolved = await this.resolveInputs(baseTx);

    await this.validateConditions(baseTx, resolved, {
      address: wallet.address,
      paymentKeyHash: wallet.paymentKeyHash,
    });

    return wallet.signTx(txCbor);
  }

  /**
   * Start the pool signing server.
   *
   * Resolves once the socket is actually listening, and hands back a handle so
   * the server can be shut down — call `close()` when you are done with it.
   */
  async listen(portOrOptions: number | ListenOptions = 8080): Promise<PoolServer> {
    this.requireWallet();

    if (this.server) {
      throw new GaslessError(
        "InvalidInput",
        `Pool server is already listening on port ${this.server.port}.`,
      );
    }

    const options = typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;

    const server = await startPoolServer(
      {
        info: () => this.poolInfo(),
        sign: (txCbor) => this.validateAndSign(txCbor),
        allowedOrigins: this.conditions.corsSettings,
      },
      options,
    );

    this.server = {
      ...server,
      close: async () => {
        await server.close();
        this.server = undefined;
      },
    };

    return this.server;
  }

  private requireWallet(): PoolWallet {
    if (!this.wallet) {
      throw new GaslessError(
        "InvalidMode",
        'This operation requires `mode: "pool"` and a wallet key.',
      );
    }
    return this.wallet;
  }
}
