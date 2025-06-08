import { Gasless } from "@nucastio/gasless";
import {
  MeshWallet,
  MeshTxBuilder,
} from "@meshsdk/core";

describe("End-to-End", () => {
  let gaslessPool: Gasless;
  let server: any;

  beforeAll(async () => {
    gaslessPool = new Gasless({
      mode: "pool",
      wallet: {
        key: {
          type: "mnemonic",
          words: "wood bench lock genuine relief coral guard reunion follow radio jewel cereal actual erosion recall"!.split(" "),
        },
        network: 0,
      },
      conditions: {},
      apiKey: "preprodJS4XP8SQVx5WWpsfMU7dfaOdCy9TTloQ"!,
    });

    // Wait until server is fully started
    await gaslessPool.listen(5000);
  });

  afterAll(async () => {
    // Close server gracefully if needed
    server?.close?.();
  });

  it("creates, sponsors, and validates a transaction", async () => {
    const userWallet = new MeshWallet({
      networkId: 0,
      fetcher: gaslessPool.blockchainProvider,
      submitter: gaslessPool.blockchainProvider,
      key: {
        type: "mnemonic",
        words: "sock more reward august tone polar pilot future phone moon hidden night"!.split(" "),
      },
    });

    const txBuilder = new MeshTxBuilder({
      fetcher: gaslessPool.blockchainProvider,
      verbose: true,
      isHydra: true,
    });

    const utxos = await userWallet.getUtxos();

    const unsignedTx = await txBuilder
      .txOut(
        "addr_test1qrs5h59fwz22rzj2fsrlcn7lvqq2wch45h7wmm77n6a5etmsn92qd9m6uycped2f80k6evsmmmrfsc55jsq93daae0ustcpskv",
        [{ unit: "lovelace", quantity: "1000000" }]
      )
      .setFee("0")
      .changeAddress(userWallet.addresses.baseAddress?.toBech32()!)
      .readOnlyTxInReference("ab78e8acf6a9ba6ce0d38e7d2d1cb4f9fb0597f5feacaf6dcbd96ed4d69cd8c0", 0)
      .selectUtxosFrom(utxos, undefined, undefined, false)
      .complete();

    const sponsoredTx = await gaslessPool.sponsorTx({
      poolId: gaslessPool.inAppWallet?.addresses.baseAddressBech32!,
      changeAddress:"",
      txCbor: unsignedTx,
    });

    expect(sponsoredTx).toBeDefined();

    const validated = await gaslessPool.validateTx({
      txCbor: sponsoredTx,
      poolSignServer: "http://localhost:5000",
    });

    console.log(validated)

    expect(validated).toBeDefined();
  }, 60000);
});
