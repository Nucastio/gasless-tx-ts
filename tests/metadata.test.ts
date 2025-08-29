import { BigNum, GeneralTransactionMetadata, TransactionInputs, AuxiliaryData, hash_auxiliary_data,
TransactionOutputs, TransactionWitnessSet, Transaction, TransactionBody, TransactionMetadatum } from
"@emurgo/cardano-serialization-lib-asmjs"
import { Gasless } from "@nucastio/gasless"

describe("Metadata transaction processing", () => {
    let gasless: Gasless;

    beforeAll(async () => {
        gasless = new Gasless({
            apiKey: API_KEY,
            mode: "sponsor"
        });
    });

    afterAll(async () => {
       server?.close?.();
    });

    it("should create and sponsor a transaction with metadata", async () => {
        // Arrange
        const inputs = TransactionInputs.new();
        const outputs = TransactionOutputs.new();
        const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.zero());
        const witness = TransactionWitnessSet.new();
        const auxiliary_data = AuxiliaryData.new();
        const metadata = GeneralTransactionMetadata.new();

        const datum = TransactionMetadatum.new_text("Sponsored message Tx for empty wallet!");

        // Act
        metadata.insert(BigNum.zero(), datum);
        auxiliary_data.set_metadata(metadata);
        body.set_auxiliary_data_hash(hash_auxiliary_data(auxiliary_data));

        const newTx = Transaction.new(body, witness, auxiliary_data);

        const sponsorResult = await gasless.sponsorTx({
            poolId: ADDRESS,
            txCbor: newTx.to_hex()
        });

        // Assert
        expect(sponsorResult).toBeDefined();
        expect(newTx.to_hex()).toBeTruthy();
        
        // Verify metadata was properly attached
        const txAuxData = newTx.auxiliary_data();
        expect(txAuxData).toBeDefined();
        
        const txMetadata = txAuxData?.metadata();
        expect(txMetadata).toBeDefined();
        
        const retrievedDatum = txMetadata?.get(BigNum.zero());
        expect(retrievedDatum?.as_text()).toBe("Sponsored message Tx for empty wallet!");

        console.log("Transaction CBOR:", newTx.to_hex());
        console.log("Sponsor result:", sponsorResult);
    }, 30000);
});
