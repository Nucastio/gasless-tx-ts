import {
  Serialization,
  toCardanoAddress,
  TokenMap,
  toValue,
  Transaction,
  TransactionOutput,
} from "@meshsdk/core-cst";
import { Gasless } from "../index";
import { TxCBOR } from "../utils";
import cors from "cors";
import express from "express";
import { AxiosError } from "axios";

export async function listen(this: Gasless, port: number = 8080) {
  try {
    if (!this.app || !this.conditions || !this.inAppWallet) {
      throw new Error("Cannot start server - required properties (app, conditions, inAppWallet) are not initialized")
    }

    this.app.use(express.json());

    if (this.conditions.corsSettings) {
      this.app.use(cors({
        origin: this.conditions.corsSettings
      }));
    }

    this.app.post("/", async (request, response): Promise<any> => {
      try {
        const { txCbor } = request.body;

        if (!this.app || !this.conditions || !this.inAppWallet) {
          throw new Error("Cannot start server - required properties (app, conditions, inAppWallet) are not initialized")
        }

        const baseTx = Transaction.fromCbor(TxCBOR(txCbor));

        const sponsorInputMap: Map<
          Serialization.TransactionInput,
          Serialization.TransactionOutput
        > = await this.getSponsoredInputMap(baseTx, this.inAppWallet.addresses.baseAddress?.getProps().paymentPart?.hash);

        const consumedUTXO: {
          lovelace: bigint;
          assets: TokenMap | undefined;
        }[] = this.getConsumedUtxos(sponsorInputMap);

        const producedUTXO: {
          lovelace: bigint;
          assets: TokenMap | undefined;
        }[] = this.getProducedUtxos(baseTx, this.inAppWallet.addresses.baseAddress?.getProps().paymentPart?.hash);

        this.validateFeeDifference(consumedUTXO, producedUTXO, baseTx.body().fee())

        this.validateAssets(consumedUTXO, producedUTXO)

        if (this.conditions?.tokenRequirements) {
          this.validateTokenRequirements(baseTx, this.inAppWallet.addresses.baseAddress?.getProps().paymentPart?.hash)
        }

        if (this.conditions?.whitelist) {
          this.validateWhitelist(baseTx)
        }

        const walletSigned = await this.inAppWallet.signTx(txCbor, true);

        return response.status(200).json({
          data: walletSigned,
          error: null,
          success: true,
        });
      } catch (error) {
        return response.status(500).json({
          data: null,
          error: error,
          success: false,
        });
      }

    });

    this.app.get("/conditions", async (request, response): Promise<any> => {
      if (!this.conditions || !this.inAppWallet) {
        throw new Error("Cannot start server - required properties (app, conditions, inAppWallet) are not initialized")
      }
      return response.status(200).json({
        pubKey: this.inAppWallet.addresses.baseAddress?.getProps().paymentPart?.hash,
        conditions: this.conditions
      });

    });

    this.app.listen(port, () => {
      console.log(`Gasless server is running on port ${port}`);
    });
  } catch (error) {
    console.error(error)
    return {
      error: error instanceof AxiosError
        ? error.response?.data?.error ?? error.code
        : error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
    };
  }
}
