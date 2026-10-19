---
title: Batches
description: client.batches — submit, get and list, and the BatchHandle a batch is read through.
---

```ts
client.batches.submit(
  requests: Record<string, unknown>[] | string,
  completionWindow?: string,        // default "24h"
  options?: BatchSubmitOptions,
): Promise<BatchHandle>

client.batches.get(batchId: string): BatchHandle       // no network call
client.batches.list(query?: { limit?: number; after?: string }): Promise<BatchPage>
```

A how-to is in [Submit a batch](../guides/submit-a-batch.md).

## `submit`

Every line is sealed, signed and paid for locally, then the file is uploaded once and the batch
created. Each line is a complete submission with its own order, sealed payload, payment and job
id.

**`requests`** is an array of lines or a JSONL string of them. A line:

| Member | Required | Meaning |
| --- | --- | --- |
| `custom_id` | no | 1–64 characters, unique within the batch. Sealed inside the line; returned as `.customId` on the opened result. |
| `url` | no | `/v1/responses` (default) or `/v1/embeddings`. Every line must name the same one. |
| `body.model` | yes | The model id. |
| `body.max_rate_in`, `body.max_rate_out` | no | The line's ceilings, as `maxRateIn` / `maxRateOut` on `submit`. Each is optional. |
| `body.units_out` | no | The output unit count, as `unitsOut` on `submit`. |
| `body.provider` | no | A provider id (an integer from 1 to 4294967295): the line is planned onto that provider only. Overrides `providers` in the options. |
| rest of `body` | | The model input. |

Other line members (such as `method`) are ignored.

**Every line is planned.** Before sealing, one `POST /v1/batches` with no file sends, per model,
pair of ceilings and set of allowed providers, the line count and summed units; a restricted
entry names its set as `providers`. The coordinator answers which providers within the ceilings
take how many lines at which ask, cheapest first, and plans a restricted entry onto its allowed
providers only; no provider gets more than its on-chain capacity leaves free. Each planned line
signs its provider's ask and is designated to it.

A **restricted** line (`providers` in the options, or `body.provider`) never rests. If the plan
leaves any over, because the allowed providers' asks do not clear the ceilings or they lack the
capacity, the whole batch raises `ValidationError` before anything is sealed or signed, naming
the model, how many lines could not be placed and the allowed providers.

An **unrestricted** line the plan cannot place **rests** at its ceilings as an **open order**
sealed to the verified escrow key, which needs a client built with a `verifier` (else
`EscrowKeyUnverified`, before anything is sealed). A side with no ceiling rests at the market
rate, the cheapest live ask's, read by one more plan. If lines with no ceiling at all do not all
fit in the window, or there is no live ask to take a market rate from, `ValidationError` is
raised and nothing is signed.

**`completionWindow`** is `"1h"` or `"24h"`, or `"async"` / `"batch"`. Anything else raises
`ValidationError`. A `"24h"` batch usually takes minutes to a few hours; 24 hours is the maximum.

**`BatchSubmitOptions`**:

| Member | Type | Meaning |
| --- | --- | --- |
| `providers` | `number[]` | Optional. An allow-list for every line without its own `body.provider`: those lines are planned only onto these providers, cheapest first. Non-empty, unique, each an integer from 1 to 4294967295. |
| `metadata` | `Record<string, string>` | Optional. At most 16 pairs, 64-character keys, 512-character values. **Stored in plaintext** on the batch record. |
| `validateParams` | `boolean` | Default `true`. Validates each line's input against its model's schema, as on [`submit`](./submit.md#local-validation). |

Pricing takes one request: the first line's terms are posted to read the gas fee and fee rate,
and every line's amount is computed locally as `cap + floor(cap × feeBps / 10000) + gasFee`.
Batch lines are never `confidential`.

Raised before anything is uploaded (`ValidationError` unless noted): a client without `signer`
and `cipher`; an invalid window; an empty batch; a line that is not valid JSON, not an object, or
has no `body.model`; an invalid or duplicate `custom_id`; a `body.provider` that is not an
integer from 1 to 4294967295; a `providers` that is empty, repeats an id, or holds anything but
such integers; an unknown `url`, or more than one; a param the model's schema refuses; a
restricted line the plan cannot place; an open line without a verifier (`EscrowKeyUnverified`).

## `BatchHandle`

| Member | Meaning |
| --- | --- |
| `id` | The batch id. |
| `jobIds` | Per-line job ids in input order; `null` on a handle from `batches.get`. |
| `outputFileId`, `errorFileId`, `requestCounts` | Updated on every read. |
| `status()` | One `GET /v1/batches/{id}`. Terminal states: `completed`, `failed`, `expired`, `cancelled`. |
| `results(timeoutSeconds?)` | Waits until terminal, then returns every line as `TextResult \| MediaResult \| EmbeddingResult \| JobError`. |
| `consume(onResult, onError?, timeoutSeconds?)` | The same, one callback per line. Callbacks may return promises, which are awaited before it resolves. Without `onError`, `JobError` lines go to `onResult`. |
| `cancel()` | Cancels lines no provider has claimed; claimed lines run to completion. Raises `ValidationError` unless the batch is `validating`, `in_progress` or `cancelling`. |

- Waiting polls once a minute for the first 15 minutes, every 3 minutes for the rest of the
  first hour, and every 10 minutes after that. Each poll is one `GET /v1/batches/{id}`, whatever
  the line count. Without `timeoutSeconds` the wait is the batch's window;
  on expiry it raises `WaitTimeout` whose `.jobId` is the batch id, and cancels nothing.
- A `failed` batch (its input file was refused) raises `BatchFailed` with `.batchId`. A failed
  line is a `JobError`, never an exception.
- Lines arrive in **file order**: every settled line, then every failed one. Correlate on
  `.customId` or `.jobId`.
- A settled line whose `vorq.gas_fee` or `vorq.fee` is missing or not a USD decimal string
  raises `VorqError`.

## `list`

Pages by cursor. `limit` is at most 100.

`BatchPage`:

| Member | Type |
| --- | --- |
| `batches` | `Record<string, unknown>[]` (OpenAI batch objects) |
| `firstId`, `lastId` | `string \| null` |
| `hasMore` | `boolean` |

Pass `lastId` back as `after` while `hasMore` is true.
