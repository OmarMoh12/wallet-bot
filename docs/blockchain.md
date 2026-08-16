# Blockchain integration

---

## The provider abstraction

```ts
interface BlockchainProvider {
  readonly network: Network; // 'tron' | 'ton'
  readonly env: NetworkEnv; // 'mainnet' | 'testnet'
  readonly requiredConfirmations: number;

  validateAddress(address): AddressValidation;
  getNativeBalance(address): Promise<bigint>;
  getTokenBalances(address, assets): Promise<TokenBalance[]>;
  listTransfers(address, cursor, limit): Promise<TransferPage>;
  getTransactionStatus(txHash): Promise<ChainTransactionStatus>;
  estimateFee(request): Promise<FeeEstimate>;
  buildTransfer(request): Promise<UnsignedTransfer>; // never signs
  broadcast(signed): Promise<BroadcastResult>;
  health(): Promise<ProviderHealth>;
}
```

Adding Ethereum or Solana means writing one of these plus rows in the `assets` table.
Nothing in the domain, database or UI layers changes.

Implementations: `TronProvider`, `TonProvider`, `EvmProvider`, `MockProvider`, and
`FallbackProvider` (a decorator with per-provider circuit breaking).

`EvmProvider` is **one implementation for every EVM chain**. EVM chains differ only in chain
id, RPC endpoint, native coin, explorer and finality depth — address format, transaction
encoding, ERC-20 semantics and log filtering are identical. Those constants live in
`EVM_CHAINS`, so adding Ethereum, Polygon or Arbitrum is a `NETWORKS` value, an `ALTER TYPE`
migration, a registry row and asset rows. No new provider code.

---

## Address validation

Implemented in this repository rather than pulled from a package, because it sits directly on
the path where a mistyped address becomes permanently lost funds.

### TRON

Base58Check over a 21-byte payload: `0x41` prefix + 20-byte account hash. Both the Base58
form and the `41…` hex form TronGrid returns are accepted; both canonicalise to Base58.

**Case-sensitive.** Base58 excludes visually ambiguous characters, but the remaining letters
are distinct addresses — lower-casing one produces a different account.

### EVM (BNB Smart Chain)

20 bytes of hex. Case is **not** part of the address — EIP-55 overloads it as a checksum
derived from `keccak256` of the lowercase form, catching roughly 99.986% of typos.

Consequently:

- **storage and comparison use lowercase**, because that is what the address actually is;
- **display uses the checksummed form**, because that is what wallets and explorers show;
- an all-lowercase address is `unchecked`, not invalid — most tooling emits it;
- **mixed case that fails the checksum is rejected**, because that is a corrupted address and
  accepting it would discard the only typo protection the format has.

The zero address validates (it is a real address) but the send pipeline refuses it
explicitly — an accidentally-empty field should not be able to burn a balance.

### TON

Two interchangeable forms:

- raw: `<workchain>:<64 hex>`
- user-friendly: 36 bytes base64/base64url — tag | workchain | hash | CRC16-CCITT

The same account has **several** valid user-friendly representations (bounceable vs
non-bounceable, testnet flag). The canonical form used for storage and comparison is
therefore the **raw** form; comparing friendly strings would make one wallet look like
several. `tests/unit/address.test.ts` asserts exactly this.

---

## Monitoring pipeline

```
worker tick (CHAIN_SCAN_INTERVAL_SECONDS)
  └─ enqueue chain.scan per due wallet (deduped by wallet id)
       └─ provider.listTransfers(address, cursor, 50)
            └─ per transfer, in ONE transaction:
                 1. skip if !succeeded          (a reverted tx moved no value)
                 2. resolve asset by contract   (unknown contract → ignored)
                 3. claim processed_events      (idempotency gate 1)
                 4. INSERT ... ON CONFLICT      (idempotency gate 2)
                 5. adjust wallet_balances
                 6. queue notification
            └─ advance scan cursor, record blockchain_scans row
```

On EVM chains step 1 reads the transaction receipt status and the log's `removed` flag — a
reverted transaction and a reorged-out log both moved no value, and recording either would be
a financial error. The scan cursor is a **block height** rather than an opaque page token,
because `eth_getLogs` is range-based: each pass advances by up to 2,000 blocks and stops
`requiredConfirmations` short of the head, so only finalised logs are ingested.

Then, separately:

- `chain.confirm` walks `detected` → `confirming` → `confirmed` until the network's finality
  threshold, and fires the confirmation notification.
- `chain.reconcile` re-reads balances from the chain on a slower cadence, so drift is
  self-healing. The ledger is authoritative for _history_; the chain is authoritative for
  _what you hold right now_ — a wallet can have activity predating the day you added it.

### Hostile chain data

Chain data is attacker-controlled input. Anyone can deploy a TRC20 contract claiming to be
USDT with 18 decimals, or airdrop a token whose name is a script tag.

- Every provider response is parsed through a Zod schema.
- Chain-reported `symbol` and `decimals` are treated as **hints**. Pricing and display always
  use our own asset registry, matched by contract address.
- A transfer of an unregistered contract is **ignored**, not recorded. Displaying it would
  misstate the portfolio. `tests/integration/chain-sync.test.ts` covers this.

### SSRF hardening

All provider traffic goes through `HttpClient`: host allow-list, `redirect: 'manual'` (a 302
to `169.254.169.254` is the classic cloud-metadata attack), DNS checked against private
ranges, HTTPS-only outside development, streaming 2 MB response cap, and a timeout on every
call.

---

## Providers and configuration

| Network      | Primary                           | Fallback | Key                                           |
| ------------ | --------------------------------- | -------- | --------------------------------------------- |
| TRON mainnet | TronGrid `api.trongrid.io`        | TronScan | `TRONGRID_API_KEY` (optional; raises limits)  |
| TRON testnet | Shasta `api.shasta.trongrid.io`   | —        | same                                          |
| TON mainnet  | TON Center `toncenter.com/api/v2` | TonAPI   | `TONCENTER_API_KEY` (free, from `@tonapibot`) |
| TON testnet  | `testnet.toncenter.com/api/v2`    | —        | same                                          |

Jetton balances need TonAPI (`TONAPI_KEY`); TON Center v2 has no first-class jetton endpoint.
Without it the provider reports native TON only and returns zero for jettons rather than
guessing.

---

## Explorer links

Built from one registry, never concatenated at a call site — a fabricated link on a financial
record looks authoritative while pointing at nothing.

| Network | Env     | Transaction URL                                    |
| ------- | ------- | -------------------------------------------------- |
| TRON    | mainnet | `https://tronscan.org/#/transaction/{hash}`        |
| TRON    | testnet | `https://shasta.tronscan.org/#/transaction/{hash}` |
| TON     | mainnet | `https://tonviewer.com/transaction/{hash}`         |
| TON     | testnet | `https://testnet.tonviewer.com/transaction/{hash}` |

Values are URL-encoded. Simulated transactions get **no** explorer link, because they are not
on any chain.

---

## Fees

TRON fees depend on the sender's staked bandwidth and energy, which we cannot know for a
watch-only address. The estimates are deliberate **over**-estimates:

|      | Native   | Token                                                                |
| ---- | -------- | -------------------------------------------------------------------- |
| TRON | 1.1 TRX  | 30 TRX (worst case, no energy)                                       |
| TON  | 0.01 TON | 0.10 TON (includes jetton wallet deployment; unused TON is returned) |

Showing a fee that turns out lower is harmless. Under-estimating causes a transfer to fail
after the user has already confirmed it.

---

## Mock mode

`MockProvider` is deterministic — balances and history derive from a hash of the address, so
tests never flake — and **cannot broadcast**: it returns a `mock-` prefixed hash and marks
the result simulated.

It is selected when `BLOCKCHAIN_MOCK=true`, and automatically outside production when no
provider keys are configured, so a fresh clone shows a populated UI instead of a wall of
provider errors.
