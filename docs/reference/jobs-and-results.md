---
title: Jobs and results
description: JobHandle, and the TextResult, MediaResult, EmbeddingResult and JobError result types.
---

## `JobHandle`

Returned by `client.submit(…)`, or built from a stored id with `client.job(jobId)` (no network
call; never creates a job).

```ts
handle.id: string
handle.taskCid: string | null
handle.status(): Promise<string>
handle.result(timeoutSeconds?: number): Promise<TextResult | MediaResult | EmbeddingResult>
handle.cancel(): Promise<void>
```

### `id`

The job id, a `0x`-prefixed 32-byte hex string. Store it before waiting on anything.

### `taskCid`

The content id of the job's sealed input, from the submission's answer. `null` on a handle built
with `client.job(id)`.

### `status()`

One `GET /v1/jobs/{id}`. Returns `queued`, `in_progress`, `completed`, `failed` or `cancelled`;
the last three are terminal. A row whose `vorq.gas_fee` or `vorq.fee` is missing or not a USD
decimal string raises `VorqError`; every read of the row by `result()` does the same.

### `result()`

Polls until the job is terminal, then fetches the result by content id and opens it with the
client's cipher.

- Windows under 24 hours poll every window ÷ 60 seconds, held between 2 and 60 seconds. A `24h`
  job polls every 60 seconds for the first 15 minutes of the wait, every 180 seconds until the
  first hour is up, and every 600 seconds after.
- Without `timeoutSeconds`, the wait is the job's window, counted from the call. A handle from
  `submit` knows the window; a handle from `client.job(id)` reads `vorq.sla_secs` from the job
  row, and assumes 1 hour if the row names none.
- On expiry, raises `WaitTimeout` with `.jobId`. The job continues.
- A `failed` or `cancelled` job raises `JobFailed` with `.errorType`.
- A `completed` job that names no result, or whose bytes are not a result or do not open with
  this client's key, raises `ResultIntegrityError`.
- A job row stating a window of zero or less seconds raises `ValidationError`.

### `cancel()`

Signs `Cancel(bytes32 jobId, uint64 issuedAt)` with the owning wallet and posts it for the
coordinator to relay to the chain.

- A client without a `signer` raises `ValidationError` before sending.
- The chain accepts `issuedAt` within ±600 s of block time. When the handle has seen the
  coordinator's `Date` header on an earlier job read, the SDK checks that bound locally and
  raises `ValidationError` without sending. A cross-origin browser can read that header only if
  the coordinator exposes it; otherwise the local check is skipped.
- A job a provider has already claimed is refused with `StateConflictError`.

## Result types

`result()` returns a union of classes; narrow it with `instanceof`:

```ts
import { EmbeddingResult, MediaResult, TextResult } from "@vorq-ai/client-sdk";

const result = await handle.result();
if (result instanceof TextResult) console.log(result.text);
else if (result instanceof MediaResult) console.log(result.frames.length, "frames");
else if (result instanceof EmbeddingResult) console.log(result.embeddings.length, "vectors");
```

All three carry these members:

| Member | Type | Meaning |
| --- | --- | --- |
| `rates` | `Rates` | The order's signed rates in USD per 1M units, `{ rateIn: string \| null; rateOut: string \| null }`. |
| `cost` | `string` | Computed locally as an exact decimal, in USD. See [Pricing and payment](../concepts/pricing-and-payment.md#what-a-result-reports). |
| `fee` | `string` | The protocol fee settlement took on top of `cost`, in USD, from the job row or batch line (`vorq.fee`). Not included in `cost`. |
| `gasFee` | `string` | The job's gas fee in USD, from the job row or batch line (`vorq.gas_fee`). Not included in `cost`. |
| `provider` | `number \| string \| null` | The registry id of the provider that settled the job. |
| `jobId` | `string \| null` | The job that produced the result. |
| `customId` | `string \| null` | Your `customId`, returned from inside the sealed payload. |
| `raw` | `Record<string, unknown>` | The opened result object. |

### `TextResult`

| Member | Type | Meaning |
| --- | --- | --- |
| `text` | `string` | The generated text, joined from the output items. |
| `output` | `unknown[]` | The raw output items (or `choices`, for a chat-completion-shaped result). |
| `usage` | `Record<string, unknown>` | Token usage, as `input_tokens`, `output_tokens`, `total_tokens`. |

`cost` = `(input_tokens × rateIn + output_tokens × rateOut) / 1 000 000`.

### `MediaResult`

| Member | Type | Meaning |
| --- | --- | --- |
| `frames` | `Record<string, unknown>[]` | One per image, or one for a video. Each carries `b64`, `content_type` and dimensions. |
| `bytes()` | `Uint8Array[]` | The frames decoded, in order. No network call. |
| `seed` | `number \| null` | The seed the model used, when reported. |

`bytes()` decodes strictly: a frame with no `b64` member, or one that is not valid base64, raises
`ResultIntegrityError`.

`cost` = delivered pixels (images) or pixel-seconds (video) × `rateOut` / 1 000 000.

### `EmbeddingResult`

| Member | Type | Meaning |
| --- | --- | --- |
| `embeddings` | `Record<string, unknown>[]` | The response's `data` array. |
| `model` | `string \| null` | The model the provider reported. |
| `promptTokens` | `number` | Input tokens billed. |
| `bytes()` | `Uint8Array[]` | The vectors decoded from base64, in order. |

`bytes()` needs `encoding_format: "base64"`. For `float` vectors it raises `VorqError`; read
`.embeddings` directly.

`cost` = `promptTokens × rateIn / 1 000 000`.

### `JobError`

A batch line that produced no result. Returned by batch results, never raised.

| Member | Type | Meaning |
| --- | --- | --- |
| `message` | `string` | |
| `type` | `string` | `provider_fail`, `reclaim`, `cancelled` or `expired` for a line that became a job; the coordinator's refusal code for one that did not; `unknown` if none was given. |
| `jobId` | `string \| null` | The correlation key. |
| `customId` | `string \| null` | Normally `null`: your label is sealed inside the payload, and an error has no sealed result to read it from. |
| `raw` | `Record<string, unknown>` | The error object as received. |

## One result shape everywhere

| Source | Returns |
| --- | --- |
| `handle.result()`, `client.job(id).result()` | `TextResult` / `MediaResult` / `EmbeddingResult`; raises `JobFailed` on failure |
| `batchHandle.results()`, `batchHandle.consume()` | the same three, plus `JobError` for a failed line |
| `sealingFetch` | the same job, rendered as an OpenAI Response object |
