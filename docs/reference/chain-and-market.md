---
title: Chain and market reads
description: The deployment context, provider asks and floors, the job book, wallet summaries, provider records and the escrow key.
---

Reads of on-chain state, served by the coordinator. Model and provider filters take **integer
ids**, not names; get a model's id from `Number(model.vorq.model_id)`.

| Method | Returns |
| --- | --- |
| `chainContext()` | [`ChainContext`](#chaincontext) |
| `asks({ model?, limit?, offset? })` | [`AskBook`](#asks) |
| `floors({ model?, sla?, limit?, offset? })` | [`FloorBook`](#floors) |
| `jobs({ state?, model?, provider?, owner?, postedBefore?, order?, limit?, offset? })` | [`JobBook`](#jobs) |
| `jobsSummary({ owner })` | [`JobsSummary`](#jobssummary) |
| `evmJob(jobId)` | One job row in its on-chain shape ([`EvmJob`](#jobs), a plain record). |
| `providers(id)` | [`ProviderRecord`](#providers) |
| `allowlist({ limit?, offset? })` | [`Allowlist`](#allowlist) |
| `escrowKey()` | [`EscrowKeyAnnouncement`](#escrowkey) |

## `ChainContext`

The deployment every signature is bound to, from `GET /evm/chain`. Read once and cached for the
client's lifetime.

| Member | Type |
| --- | --- |
| `chainId` | `number` |
| `jobRegistry`, `providerRegistry`, `askRegistry`, `usdc` | `Address` |
| `decimals` | `number` (the payment token's) |
| `tokenDomain` | `{ name: string; version: string }` (the payment token's EIP-712 domain) |
| `feeBps` | `number` (the protocol fee, in basis points) |

## Paging

`AskBook`, `FloorBook`, `JobBook` and `Allowlist` are pages. Each carries `asOfBlock`
(`bigint | null`), `truncated` and `nextOffset`:

- Loop on `nextOffset`, passing it back as `offset`, until it is `null`. `truncated` alone (the
  page was cut by the response size budget) does not tell you whether more rows exist.
- `limit` defaults to 100 and is at most 1000.
- The coordinator refuses offsets past 1 000 000 with a `400`; narrow the query instead.

```ts
const rows = [];
for (let offset: number | null = 0; offset !== null; ) {
  const page = await client.jobs({ owner, offset });
  rows.push(...page.jobs);
  offset = page.nextOffset;
}
```

## `asks`

Published provider asks. `AskBook.asks` is a list of:

| Member | Type |
| --- | --- |
| `providerId`, `modelId` | `number` |
| `sla` | `number` (window seconds) |
| `rateIn`, `rateOut` | `string` (USD per 1M units) |

## `floors`

The cheapest ask per `(model, window)` across listed providers. Input and output are minimised
independently, so the two floors may come from different providers. `sla` narrows to one
window: `"async"`, `"batch"`, `"1h"` or `"24h"`; any other value raises `ValidationError` before
a request.

`FloorBook.floors` is a list of `{ modelId, sla, rateIn, rateOut }`, typed as in `asks`. A rate
in the response that is not a USD decimal string, or a count that is not an integer, raises
`VorqError` rather than defaulting to zero.

## `jobs`

On-chain job rows (`JobBook.jobs`, plain records, typed `EvmJob`). Every row carries `gas_fee`,
the flat relay gas fee fixed when the job was posted, and `fee`, the protocol fee settlement took
on top of the provider's charge (`"0"` for a job that did not settle), both in USD. A row whose
`gas_fee` or `fee` is missing or not a USD decimal string raises `VorqError`; `evmJob` checks its
row the same way.

| Filter | Meaning |
| --- | --- |
| `state` | `"Open"`, `"Claimed"`, `"Settled"` or `"Cancelled"`. |
| `model`, `provider` | Integer ids. |
| `owner` | A wallet address. |
| `postedBefore` | A block number; only jobs posted at or before it. |
| `order` | `"oldest"` (default) or `"newest"`. |

## `jobsSummary`

One wallet's totals. `owner` is required and must be a string, else `ValidationError`.

| Member | Type | Meaning |
| --- | --- | --- |
| `jobs`, `completed` | `number` | Counts. |
| `escrowed` | `string` | What each job's claim locks (cap + protocol fee on the cap + `gas_fee`), summed over every row, in USD. |
| `byModel` | `{ modelId, jobs, completed, escrowed }[]` | The same, per model. |
| `asOfBlock` | `bigint \| null` | |

A count that is not an integer, or an `escrowed` that is not a USD decimal string, raises `VorqError`.

## `providers`

`ProviderRecord`: `providerId`, `operator` (address), `boxKey` (the Curve25519 key designated
orders are sealed to, `0x`-prefixed), `listed` and `raw` (the full record, including any
attestation evidence).

## `allowlist`

The on-chain measurement allowlist the [Verifier](./verifier.md) checks against. `entries` is a
list of `{ key, status, entry }`; `status` `2` is a revoked entry.

## `escrowKey`

The coordinator's escrow key announcement, **unverified**: `escrowPublicKey` (64 hex characters,
no `0x`), `evidence` and `issuedAt` (unix seconds). Open orders verify it themselves before
sealing; see [Verifier](./verifier.md#escrow-key).
