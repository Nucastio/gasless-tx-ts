
import { Gasless } from "npm:@nucastio/gasless@1.1.0-alpha.0";
import { Lucid, Blockfrost } from "npm:lucid-cardano";

const gaslessPool = new Gasless({
    mode: "pool",
    wallet: {
        key: {
            type: "mnemonic",
            words:
                "wood bench lock genuine relief coral guard reunion follow radio jewel cereal actual erosion recall"
                    .split(" "),
        },
        network: 0, // 0 → Preprod in Lucid; adjust if you change the endpoint
    },
    conditions: {},
    apiKey:
        Deno.env.get("BF_KEY") ??
        "",
});

const server = await gaslessPool.listen(5000);
// ---------------------------------------------------------------------------

// ---- build the user transaction -------------------------------------------
const lucid = await Lucid.new(
    new Blockfrost(
        "https://cardano-preprod.blockfrost.io/api/v0",
        Deno.env.get("BF_KEY") ??
        "",
    ),
    "Preprod",
);

lucid.selectWalletFromSeed(
    "sock more reward august tone polar pilot future phone moon hidden night",
);

const tx = await lucid
    .newTx()
    .payToAddress(
        "addr_test1qrs5h59fwz22rzj2fsrlcn7lvqq2wch45h7wmm77n6a5etmsn92qd9m6uycped2f80k6evsmmmrfsc55jsq93daae0ustcpskv",
        { lovelace: 4_000_000n },
    )
    .complete();
// ---------------------------------------------------------------------------

const sponsoredTx = await gaslessPool.sponsorTx({
    poolId: gaslessPool.inAppWallet!.addresses.baseAddressBech32!,
    changeAddress:
        "addr_test1qrs5h59fwz22rzj2fsrlcn7lvqq2wch45h7wmm77n6a5etmsn92qd9m6uycped2f80k6evsmmmrfsc55jsq93daae0ustcpskv",
    txCbor: tx.toString(),
});

if (!sponsoredTx) {
    throw new Error("sponsorTx returned undefined");
}

const validated = await gaslessPool.validateTx({
    txCbor: sponsoredTx,
    poolSignServer: "http://localhost:5000",
});
// ---------------------------------------------------------------------------

// ---- user signs and submits ------------------------------------------------
const finalTx = await lucid.fromTx(validated).sign().complete();
const txHash = await finalTx.submit();

console.log("submitted TxHash:", txHash);

