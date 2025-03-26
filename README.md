# Gasless Tx Library

## Installation

To install the library:

```tsx
npm install @nucastio/gasless

```

## Usage


```tsx
import { Gasless } from "@nucastio/gasless";
```

### Initialization

To initialize the Gasless library, you need to provide parameters based on the mode you are using: `"pool"` or `"sponsor"`.

### Pool Mode

For the pool mode, provide the following parameters:

- `mode`: Set to `"pool"`.
- `wallet`: An object containing:
    - `network`: The network to use (0 for testnet, 1 for mainnet).
    - `key`: Wallet credentials, which can be one of the following types:
        - `type: "root"`, `bech32: string` - Root key in Bech32 format.
        - `type: "cli"`, `payment: string`, `stake?: string` - CLI-generated payment and optional stake keys.
        - `type: "mnemonic"`, `words: string[]` - Mnemonic phrase as an array of words.
        - `type: "bip32Bytes"`, `bip32Bytes: Uint8Array` - BIP32 private key bytes.
        - `type: "address"`, `address: string` - Wallet address.
- `conditions`: Pool conditions, which can include:
    - `tokenRequirements?: { unit: string, quantity: number, comparison: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }[]` - Optional array of token requirements specifying asset unit, quantity, and comparison operator.
    - `whitelist?: string[]` - Optional array of whitelisted addresses.
    - `corsSettings?: string[]` - Optional array of allowed origins for CORS.
- `apiKey`: Your Blockfrost API key.

**Example:**

```tsx
const gaslessPool = new Gasless({
  mode: "pool",
  wallet: {
    network: 0,
    key: {
      type: "mnemonic",
      words: ["wood", "bench", "lock", "genuine", "relief", "coral", "guard", "reunion", "follow", "radio", "jewel", "cereal", "actual", "erosion", "recall"],
    },
  },
  conditions: {
    tokenRequirements: [{ unit: "lovelace", quantity: 1000000, comparison: "gte" }],
    whitelist: ["addr_test1qrs5h59fwz22rzj2fsrlcn7lvqq2wch45h7wmm77n6a5et"],
    corsSettings: ["<http://example.com>"],
  },
  apiKey: "your-blockfrost-api-key",
});

```

### Sponsor Mode

For the sponsor mode, provide the following parameters:

- `mode`: Set to `"sponsor"`.
- `apiKey`: Your Blockfrost API key.

**Example:**

```tsx
const gaslessSponsor = new Gasless({
  mode: "sponsor",
  apiKey: "your-blockfrost-api-key",
});

```

### Methods

### Pool Mode

### `listen(port?: number)`

Starts the server to listen for transaction signing requests. The server handles POST requests to sign transactions and GET requests to retrieve pool conditions.

- **Parameters**:
    - `port` (optional): The port number to listen on (default is 8080).
- **Returns**: A `Promise` that resolves to `undefined` when the server starts successfully, or an object `{ error: string }` if an error occurs.

**Example:**

```tsx
await gaslessPool.listen(5050);
// Gasless server is running on port 5050

```

### Sponsor Mode

### `sponsorTx(params: SponsorTxParams)`

Sponsors the transaction fee from the pool.

- **Parameters**:
    - `txCbor: string` - The CBOR-encoded transaction to sponsor.
    - `poolId: string` - The address of the pool providing the sponsorship.
    - `utxo?: { txHash: string, outputIndex: number }` - Optional specific UTxO to use for sponsoring.
- **Returns**:the CBOR-encoded sponsored transaction (`TxCBOR`).

**Example:**

```tsx
const sponsoredTxCbor = await gaslessSponsor.sponsorTx({
  txCbor: "transaction-cbor-hex",
  poolId: "pool-address",
  utxo: { txHash: "tx-hash", outputIndex: 0 },
});
console.log(sponsoredTxCbor);

```

### `validateTx(params: ValidateTxParams)`

Validates a sponsored transaction against the pool's conditions and requests the pool to sign it.

- **Parameters**:
    - `txCbor: string` - The CBOR-encoded transaction to validate.
    - `poolSignServer: string` - The URL of the pool's signing server (e.g., `"<http://pool-server:5050>"`).
- **Returns**: Pool signed transaction CBOR (`TxCBOR`).

**Example:**

```tsx
const validatedTxCbor = await gaslessSponsor.validateTx({
  txCbor: "sponsored-transaction-cbor",
  poolSignServer: "<http://pool-server:5050>",
});
console.log(validatedTxCbor);

```


### Example

```tsx
import { Gasless } from "@nucastio/gasless";

// Initialize a pool
const gaslessPool = new Gasless({
  mode: "pool",
  wallet: {
    network: 0,
    key: {
      type: "mnemonic",
      words: ["wood", "bench", "lock", "genuine", "relief", "coral", "guard", "reunion", "follow", "radio", "jewel", "cereal", "actual", "erosion", "recall"],
    },
  },
  conditions: {
    tokenRequirements: [{ unit: "lovelace", quantity: 1000000, comparison: "gte" }],
  },
  apiKey: "your-blockfrost-api-key",
});

// Start the pool server
gaslessPool.listen(5050).then(() => console.log("Pool server started"));

// Initialize a sponsor client
const gaslessSponsor = new Gasless({
  mode: "sponsor",
  apiKey: "your-blockfrost-api-key",
});

// Sponsor a transaction
async function sponsorTransaction() {
  const txCbor = "your-transaction-cbor"; // Replace with actual CBOR
  const poolAddress = "pool-address"; // Replace with actual pool address
  const sponsoredTx = await gaslessSponsor.sponsorTx({
    txCbor,
    poolId: poolAddress,
  });

  // Validate and sign the transaction
  const validatedTx = await gaslessSponsor.validateTx({
    txCbor: sponsoredTx,
    poolSignServer: "<http://localhost:5050>",
  });

  console.log("Validated Transaction CBOR:", validatedTx);
}

sponsorTransaction().catch(console.error);

```


### Running the Pool Server

You can run the Gasless pool as a standalone server to handle gasless transaction requests. Below is an example of how to set up and start the server:

```tsx
import { GaslessPool } from "@nucastio/gasless";

const pool = new GaslessPool({
  wallet: {
    seedphrase: "your-wallet-seed-phrase".split(" "),
    private_key: "your-private-key",
    cli_key: "your-cli-key",
  },
  conditions: {
    whitelist: ["addr1...", "addr2..."],
  },
});

pool.listen({ port: 5050 });

```

This code initializes a Gasless pool and starts a server on port 5050. Replace `"your-wallet-seed-phrase"`, `"your-private-key"`, and `"your-cli-key"` with your actual wallet credentials.

---
