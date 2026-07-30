# @nucastio/gasless

Fee-sponsored ("gasless") transactions for Cardano.

A user builds a transaction with no fee and no ADA to pay one. A **pool** adds one
of its own UTxOs, absorbs the network fee out of its own change, and co-signs —
but only if the transaction meets the rules that pool published. The user signs
their own inputs and submits. They never hold ADA for fees.

```
user builds tx  ──▶  sponsorTx()  ──▶  validateTx()  ──▶  user signs  ──▶  submit
   (fee = 0)         pool UTxO in,      pool server
                     fee deducted       checks + co-signs
```

## Install

```bash
npm install @nucastio/gasless
```

Requires Node 18 or newer. Two runtime dependencies (`@meshsdk/core-cst`,
`@meshsdk/common`) plus `bech32`; no HTTP framework, no HTTP client.

## Quick start

### Run a pool

```ts
import { Gasless } from "@nucastio/gasless";

const pool = new Gasless({
  mode: "pool",
  apiKey: process.env.BLOCKFROST_PROJECT_ID!,
  wallet: {
    network: 0, // 0 = testnet, 1 = mainnet
    key: { type: "mnemonic", words: process.env.POOL_MNEMONIC!.split(" ") },
  },
  conditions: {
    tokenRequirements: [{ unit: "lovelace", quantity: 1_000_000, comparison: "gte" }],
  },
});

const server = await pool.listen(5050);
console.log(`pool ${pool.address} listening on ${server.url}`);

// later
await server.close();
```

### Sponsor a transaction

```ts
import { Gasless } from "@nucastio/gasless";

const sponsor = new Gasless({ mode: "sponsor", apiKey: process.env.BLOCKFROST_PROJECT_ID! });

const sponsoredTx = await sponsor.sponsorTx({
  txCbor: unsignedTxFromYourBuilder,
  poolId: "addr_test1...", // the pool's address
});

const coSignedTx = await sponsor.validateTx({
  txCbor: sponsoredTx,
  poolSignServer: "http://localhost:5050",
});

// The user adds their own signature and submits.
const finalTx = await userWallet.signTx(coSignedTx, true);
await sponsor.provider.submitTx(finalTx);
```

In a browser, import from `@nucastio/gasless/client` instead — same
`sponsorTx` / `validateTx`, with the signing key and HTTP server left out.

```ts
import { GaslessClient } from "@nucastio/gasless/client";
```

## API

### `new Gasless(options)`

| Option       | Mode      | Meaning                                                        |
| ------------ | --------- | -------------------------------------------------------------- |
| `mode`       | both      | `"pool"` or `"sponsor"`                                          |
| `apiKey`     | both\*    | Blockfrost project id; the network comes from its prefix         |
| `provider`   | both\*    | Any object satisfying `GaslessProvider` — use instead of `apiKey` |
| `wallet`     | pool      | `{ network, key, accountIndex?, keyIndex? }`                     |
| `conditions` | pool      | Rules a transaction must meet (see below)                        |

\* Supply exactly one of `apiKey` or `provider`.

Wallet keys accept `{ type: "mnemonic", words }`, `{ type: "root", bech32 }`,
`{ type: "cli", payment, stake? }`, or `{ type: "bip32Bytes", bip32Bytes }`.
Derivation is `m/1852'/1815'/account'/0/index`, identical to MeshSDK's
`MeshWallet`, so an existing pool keeps its address.

### Pool conditions

```ts
{
  // At least one non-pool input address must satisfy at least one requirement.
  tokenRequirements: [{ unit: "lovelace", quantity: 1_000_000, comparison: "gte" }],
  // At least one input must come from a listed address.
  whitelist: ["addr_test1..."],
  // Browser origins allowed to call the pool server.
  corsSettings: ["https://app.example.com"],
}
```

`comparison` is one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte`. Omitted conditions
are not enforced; `conditions: {}` sponsors any well-formed transaction.

### Methods

| Method                                        | Mode    | Returns                                    |
| --------------------------------------------- | ------- | ------------------------------------------ |
| `sponsorTx({ txCbor, poolId, utxo? })`        | both    | sponsored transaction CBOR                 |
| `validateTx({ txCbor, poolSignServer })`      | both    | pool-co-signed transaction CBOR            |
| `listen(port \| options)`                     | pool    | `{ port, url, close() }`                   |
| `validateAndSign(txCbor)`                     | pool    | co-signed CBOR (what the server calls)     |
| `poolInfo()`                                  | pool    | `{ address, paymentKeyHash, conditions }`  |
| `setConditions(conditions)`                   | pool    | updates the rules in place                 |

### Pool server routes

- `GET /conditions` → `{ address, paymentKeyHash, conditions }`
- `POST /` with `{ txCbor }` → `{ data, error, success }`

Rejections carry a machine-readable code, so callers can branch without parsing
prose:

```json
{ "data": null, "success": false, "error": { "code": "AddressNotWhitelisted", "message": "..." } }
```

Codes: `InvalidInput`, `InvalidMode`, `MissingConditions`, `UtxoNotFound`,
`InsufficientPoolFunds`, `ProviderError`, `FeeMismatch`, `AssetMismatch`,
`PoolOutputMismatch`, `MissingRequiredAsset`, `TokenRequirementNotMet`,
`AddressNotWhitelisted`, `SigningServerError`.

### Bring your own provider

The library needs four calls, so any MeshSDK provider works as-is, as does
anything you write yourself:

```ts
import { KoiosProvider } from "@meshsdk/provider";

const pool = new Gasless({ mode: "pool", provider: new KoiosProvider("preprod"), wallet: { ... } });
```

```ts
interface GaslessProvider {
  fetchUTxOs(hash: string, index?: number): Promise<UTxO[]>;
  fetchAddressUTxOs(address: string, asset?: string): Promise<UTxO[]>;
  fetchProtocolParameters(epoch?: number): Promise<Protocol>;
  submitTx(tx: string): Promise<string>;
}
```

## What the pool is protected against

The pool server re-runs every check before it signs; a sponsor's client-side
validation is only a fast-failure convenience and is never trusted.

- **The pool never loses more than the network fee.** Its inputs minus its
  outputs are compared against the declared fee, so change cannot be skimmed.
- **Native assets are never moved.** Every token the pool contributes must come
  back to the pool in the same quantity.
- **Change must return to the pool's own address**, not merely to its payment
  key under someone else's stake credential.
- **The pool's signature is mandatory.** Sponsoring adds the pool's key hash to
  the transaction's required signers, so a stripped signature invalidates it.

## Why `libsodium-wrappers-sumo` is a dependency

The library never imports it. `@meshsdk/core-cst` reaches it through
`@cardano-sdk/crypto`, and the `0.7.16` release ships a broken ESM entry point —
it imports a file that is not published — so any native Node ESM `import` of
`@meshsdk/core-cst` dies with `ERR_MODULE_NOT_FOUND ... libsodium-sumo.mjs`.

Pinning `0.7.15` here makes the resolver settle on the last working release for
everyone downstream, so a plain `npm install` works in ESM out of the box.
Remove the pin once the upstream ESM build is fixed.

## Development

```bash
pnpm install
pnpm test        # offline unit + server tests
pnpm typecheck
pnpm lint
pnpm build
```

Live preprod tests are opt-in and need a funded pool wallet:

```bash
BLOCKFROST_PROJECT_ID=preprod... POOL_MNEMONIC="word word ..." pnpm test:integration
```

## Security

Versions up to `1.0.5` committed a working Blockfrost preprod project id and
wallet mnemonics to this repository, and they remain in the public git history.
**Rotate that Blockfrost key and move any funds off those wallets.** Never put a
pool mnemonic in source; read it from the environment or a secret manager.

The pool wallet's key signs transactions on demand for anyone who satisfies its
conditions. Keep conditions as narrow as your use case allows, and fund the pool
with only what you are prepared to spend on fees.

## Migrating from 1.x

See [CHANGELOG.md](CHANGELOG.md) for the full list. The short version:

- `listen()` now resolves to `{ port, url, close() }` once the socket is
  actually listening, instead of resolving early and leaking the server.
- Error responses are `{ code, message }` objects rather than `{}`.
- `conditions` is optional, and the pool publishes `address` alongside
  `paymentKeyHash` at `GET /conditions`.
- `@meshsdk/core`, `axios`, `express`, and `cors` are no longer dependencies.

## License

ISC
