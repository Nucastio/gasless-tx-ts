import { Gasless } from "@nucastio/gasless";
import {
    MeshWallet,
    MeshTxBuilder,
} from "@meshsdk/core";

const users = [MNEMONICS]

describe("Concurrent transaction processing", () => {
    let gaslessPool: Gasless;
    let server: any;

    beforeAll(async () => {
        gaslessPool = new Gasless({
            mode: "pool",
            wallet: {
                key: {
                    type: "mnemonic",
                    words: POOLMNEMONIC!.split(" "),
                },
                network: 1,
            },
            conditions: {},
            apiKey: BL!,
        });

        // Wait until server is fully started
        await gaslessPool.listen(5000);
    });

    afterAll(async () => {
        // Close server gracefully if needed
        server?.close?.();
    });

    it("should process concurrent transactions from multiple", async () => {
        const poolUTxOs = await gaslessPool.blockchainProvider.fetchAddressUTxOs(gaslessPool.inAppWallet?.addresses.baseAddressBech32!)

        const submitted: string[] = [];

        for (const user of users) {
            const userWallet = new MeshWallet({
                networkId: 1,
                fetcher: gaslessPool.blockchainProvider,
                submitter: gaslessPool.blockchainProvider,
                key: {
                    type: "mnemonic",
                    words: user!.split(" "),
                },
            });

            const txBuilder = new MeshTxBuilder({
                fetcher: gaslessPool.blockchainProvider,
                verbose: true,
                isHydra: true,
            });

            const utxos = await userWallet.getUtxos();

            console.log(utxos)

            const unsignedTx = await txBuilder
                .txIn(utxos[0].input.txHash, utxos[0].input.outputIndex)
                .txOut(
                    "addr1q8nm27pd82dr827x2m53kn9rtydmjuv7mzufwv5t2w9fssrwtpetyc9z3kgy6xm86dx59wsc7hah7f5k55fm5nqzrats07cl76",
                    [{ unit: "lovelace", quantity: "2000000" }]
                )
                .setFee("0")
                .changeAddress(userWallet.addresses.baseAddress?.toBech32()!)
                .complete();

            const utxo = poolUTxOs.pop()

            const sponsoredTx = await gaslessPool.sponsorTx({
                poolId: gaslessPool.inAppWallet?.addresses.baseAddressBech32!,
                txCbor: unsignedTx,
                utxo: {
                    txHash: utxo?.input.txHash!,
                    outputIndex: utxo?.input.outputIndex!
                }
            });

            const validated = await gaslessPool.validateTx({
                txCbor: sponsoredTx,
                poolSignServer: "http://localhost:5000",
            });

            const userSignedTx = await userWallet.signTx(validated, true);

            const txHash = await gaslessPool.blockchainProvider.submitTx(userSignedTx);

            submitted.push(txHash);
        }

        console.log("\nSubmitted Transactions:");
        submitted.forEach((txHash, index) => {
            console.log(`  ${index + 1}. ${txHash}`);
        });

    }, 60000);
});
