# Changelog

## 2.0.0

A correctness and maintenance release. The concepts are unchanged — pool mode,
sponsor mode, `sponsorTx` / `validateTx` / `listen` — but several signatures
changed, and a security bug in 1.x means upgrading is strongly recommended.

### Security

- **Pool funds could be burned as collateral.** Validation read only `inputs`,
  `outputs` and `fee`, so a pool UTxO named in the `collateral` set was
  invisible to the value accounting. An attacker submitted an otherwise valid
  sponsored transaction carrying a deliberately failing Plutus script, and the
  forfeited collateral came out of the pool. Collateral is now resolved and any
  pool-funded collateral is refused (`allowPoolCollateral` to opt in).
- **The pool's signature could authorize a minting policy.** A native script
  `RequireSignature(poolPaymentKeyHash)` hashes to a policy id that only the
  pool's key controls, and co-signing satisfied it — so anyone could mint tokens
  under the pool's identity. Native scripts requiring the pool's key are now
  refused (`allowPoolKeyScripts` to opt in).
- **Unknown transaction fields are refused rather than ignored.** The pool signs
  a whole body while checking a few fields, so mint, certificates, withdrawals,
  governance and treasury fields are now rejected unless the operator opts in
  via `conditions.policy`. Future ledger eras default to refusal.
- **The signing endpoint was an open faucet.** It is now rate limited by default
  (30 requests/minute per remote address), accepts an `authorize` hook, and
  supports `maxFeeLovelace` plus a rolling `feeBudget`.
- **The pool signed transactions that failed its own conditions.**
  `validateTokenRequirements` and `validateWhitelist` are async but were called
  without `await`, so a rejection became an unhandled promise rejection while
  execution fell straight through to signing. Any transaction reaching the pool
  server was co-signed regardless of the whitelist or token requirements. All
  checks are now awaited, and the regression is covered by tests.
- **Change could be redirected to a foreign stake credential.** Outputs
  returning value to the pool were matched on the payment credential alone, so
  an output reusing the pool's payment key with an attacker's stake credential
  counted as returned value while silently redirecting the pool's staking
  rewards. Returns are now matched on the pool's full address.
- Committed credentials removed. A working Blockfrost preprod project id and
  wallet mnemonics were present in `tests/` and `README.md` up to 1.0.5 and
  remain in the public git history — **rotate that key and move those funds.**
- Error responses no longer echo internal errors to callers. Rule violations
  return a typed 400; anything else returns a generic 500.

### Fixed

- Reference-script fees used `multiplier *= multiplier`, squaring the tier
  multiplier instead of raising it by 1.2 per 25,600-byte tier, and charged the
  first tier at 1.2x instead of the base rate. Both are now per the Conway
  ledger rules.
- A fractional fee total made `BigInt(fee)` throw outright; totals are now
  rounded up to whole lovelace.
- Placeholder signatures for fee estimation used the decimal signer index, so
  the tenth and later witnesses were twice the correct length and skewed the
  size estimate.
- The witness-count map was keyed by object identity, which silently missed
  every input whenever the transaction body was re-deserialized. It is now keyed
  by `txHash#index`.
- Required signers were de-duplicated against their CBOR encoding rather than
  their key hash, so a signer already implied by an input was counted twice.
- The fee was estimated once, before the sponsor's change output was resized to
  absorb it; the estimate is now iterated so the final size is charged for.
- `listen()` resolved before the socket was listening, never returned the
  server, and offered no way to close it. It now resolves on `listening`,
  rejects on `error`, and returns `{ port, url, close() }`.
- Selecting a sponsoring UTxO could yield `undefined` and fail deep inside
  transaction assembly. Selection now picks the largest eligible UTxO and
  reports `InsufficientPoolFunds` when there is none.
- Sponsoring now refuses to leave the pool's change output below its min-ADA
  instead of producing a transaction the node rejects.
- A pinned `utxo` is verified to belong to `poolId`.
- Reference-script sizes were fetched, then discarded for reference inputs whose
  UTxO was missing; a missing reference input is now an error.
- `validateTx` checked whether the pool server responded *after* using the
  response, and had no request timeout.
- Debug `console.log` calls removed from the library.

### Changed

- Concurrent `sponsorTx` calls no longer hand the same pool UTxO to several
  users. A selected UTxO is reserved in-process for `reservationMs` (default
  120s) and can be freed early with `releaseUtxo()`; previously every request
  took the largest UTxO and all but one transaction died on submission.
- `validateFeeDifference` now requires the pool's net loss to be **at most** the
  fee, rather than exactly the fee. Transactions that also pay the pool — a
  service fee, a purchase — are legitimate and were previously rejected.
- `listen(port?)` returns `Promise<PoolServer>`; it also accepts
  `{ port, hostname, maxBodyBytes }`.
- `GET /conditions` returns `{ address, paymentKeyHash, conditions }`. The 1.x
  field `pubKey` is now `paymentKeyHash`, and `address` is new and required.
- Errors are `GaslessError` / `ValidationError` with a typed `code`.
- `conditions` is optional in pool mode.
- The constructor accepts `provider` (any `GaslessProvider`) as an alternative
  to `apiKey`.
- Package is now ESM-first with a CommonJS build alongside; entry points are
  `.` and `./client`.

### Removed

- `@meshsdk/core`, `axios`, `express`, and `cors` are no longer dependencies.
  A production install drops from **306 packages / 125 MB** to
  **157 packages / 72 MB**, and the published package from **10.05 MB** to
  **0.53 MB**.
- The hand-maintained `declare class` type shadows in `src/@types/types.ts`,
  which had drifted from the implementation. Types are derived from the code.
- `src/client.ts` no longer duplicates ~180 lines of `src/index.ts`; both build
  on a shared `GaslessCore`.

### Added

- `PoolWallet`, a minimal signer built on `@meshsdk/core-cst`. Key derivation is
  byte-identical to MeshSDK's `MeshWallet`, verified by test fixtures, so an
  existing pool keeps its address.
- `BlockfrostProvider`, a `fetch`-based client with retry on 429/5xx. It also
  maps `min_fee_ref_script_cost_per_byte`, which Mesh's own provider drops.
- `conditions.policy` (`SponsorshipPolicy`): per-feature opt-ins, `maxInputs`,
  `maxOutputs`, `maxTxSizeBytes`, `maxFeeLovelace`, `blockedAddresses` and
  `feeBudget`. Exported alongside `DEFAULT_POLICY`, `resolvePolicy` and
  `FeeBudget`.
- 88 offline tests covering fee maths, witness counting, every validation rule
  in both directions, wallet derivation and signing, provider behaviour, the
  sponsorship policy including both proven exploits, UTxO reservation under
  concurrency, and a full sponsor → serve → validate → sign round trip.
- Opt-in live preprod tests behind `BLOCKFROST_PROJECT_ID` / `POOL_MNEMONIC`.
- CI on Node 18, 20, and 22.
- A pin on `libsodium-wrappers-sumo@0.7.15`, which the library does not import
  but which `@meshsdk/core-cst` reaches transitively. Its `0.7.16` release ships
  an ESM entry that imports an unpublished file, breaking every native Node ESM
  import of `@meshsdk/core-cst`. The pin makes a plain install work unaided.

### Migrating

```diff
-const server = await pool.listen(5050);
-// no way to stop it
+const server = await pool.listen(5050);
+await server.close();

-const { conditions, pubKey } = await (await fetch(url + "/conditions")).json();
+const { conditions, paymentKeyHash, address } = await (await fetch(url + "/conditions")).json();

-} catch (error) { console.log(error); }        // 1.x returned {}
+} catch (error) { if (error.code === "FeeMismatch") { /* ... */ } }
```

Pool wallets, addresses, and the sponsor/validate flow are unchanged; no
on-chain migration is required.

## 1.0.5 and earlier

See the git history.
