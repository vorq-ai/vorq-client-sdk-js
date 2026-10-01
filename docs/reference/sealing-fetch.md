---
title: sealingFetch
description: The sealing transport for the openai package — options, intercepted and forwarded routes, refusals and error mapping.
---

```ts
sealingFetch(options?: SealingFetchOptions): SealingFetch

type SealingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
```

Returns a `fetch`-compatible function for `new OpenAI({ fetch })`. It runs the sealed job flow
under three Responses routes, forwards a short list of prompt-free routes, and refuses everything
else before reading its body. A how-to is in
[Use the openai package](../guides/use-the-openai-package.md).

## Options

| Option | Type | Meaning |
| --- | --- | --- |
| `baseUrl` | `string` | The **bare** coordinator origin, without `/v1`. |
| `signer`, `cipher` | `Signer`, `Cipher` | As on [`Client`](./client.md#constructor). |
| `verifier` | `Verifier \| null` | Required for open orders: a request that names a bid and no `vorq.provider`. |
| `timeoutMs` | `number` | Per-request HTTP timeout. |
| `fetch` | `typeof fetch` | The underlying transport. |
| `client` | `Client` | An existing client, **instead of** all options above. Passing both throws `Error`. |

One `Client` backs the returned function for its whole life, so the session, chain context and
verified escrow key are reused across calls.

## Intercepted routes

### `POST /v1/responses`

The body becomes a sealed job:

- `model` is the model; `background`, `vorq` and `metadata` are taken out; the rest of the body
  is the model input. An array `input` is passed to the model as `messages`.
- `vorq.sla` (default `"1h"`), `vorq.rate_in`, `vorq.rate_out` and `vorq.provider` become the
  order terms, as on [`submit`](./submit.md): with neither rate, the order takes the market.
  Other `vorq` keys are ignored.
- With `background: true`, answers at once with a `queued` Response. Without it, waits for the
  job, bounded by its window, and answers with the settled Response. A job that fails while
  waited on is answered `200` with `status: "failed"` and an `error` object `{ code, message }`.

Refused with a `400` before anything is sent:

| Request | Why |
| --- | --- |
| `model` missing or not a string | The model decides the provider and the rates. |
| `stream: true` | A sealed result is a single object, opened when the job settles. |
| non-empty `metadata` | A stable caller-chosen identifier would link your jobs across providers. |
| `vorq.sla` present but not a string (`null` and `""` mean the default) | Defaulting it would sign a window you did not ask for. |
| `vorq.provider` present but not a number (`null` means open) | Dropping it would turn a designated order into an open one. |
| A body that is not a JSON object | |

### `GET /v1/responses/{id}`

Reads the job. A `completed` text or media job is returned with its opened output. `?stream=`
anything other than `false` is refused with a `400`.

### `POST /v1/responses/{id}/cancel`

Signs and relays a cancel with the owning wallet, and answers a `cancelled` Response. A claimed
job is refused with `409`.

## Response objects

Every Response carries `id` (the job id), `object: "response"`, `status`, `model`,
`background`, `created_at`, `output`, `metadata: {}`, and a top-level `vorq` block with the job's
terms as the job row reports them (empty on an answer built before the row was read).

- Text: one `message` output item with an `output_text` part, and `usage` with `input_tokens`,
  `output_tokens`, `total_tokens`.
- Image and video: one `image_generation_call` item per frame, each carrying the frame's base64
  as `result`. Video uses the same item type, since the Responses schema has no video item; use
  the native [`MediaResult`](./jobs-and-results.md#mediaresult) to tell them apart by
  `content_type`.
- `failed` / `cancelled`: an `error` object with the end cause as `code`.

Embedding results are not rendered on this surface; use the native `submit`.

## Forwarded routes

Matched on method **and** exact path:

| Forwarded | Why no prompt travels |
| --- | --- |
| `GET /v1/models` | A catalog read. |
| `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}` | Batch creation references an already-uploaded file by id. |
| `POST /v1/batches/{id}/cancel` | No body. |
| `GET /v1/files/{id}`, `GET /v1/files/{id}/content` | File metadata, and output that was sealed before it was written. |
| `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel` | A status read and a cancel. |

A forwarded request is re-sent with the wallet session: your `openai` client's `Authorization`
and other headers are dropped. The response keeps its body, status and content type, plus
`x-request-id`, and no other headers.

**Every other route answers `400` before its body is read**, so nothing leaves your process. That
includes `POST /v1/files` (the message points to `client.batches.submit`), `POST /v1/jobs`, chat
completions, audio, images, moderations, threads, vector stores, realtime, and any route the
`openai` package adds later. A base URL with a path prefix matches nothing, and a
percent-encoded slash (`/v1/jobs%2Fx`) is one segment and matches nothing.

## Errors

- Coordinator errors keep their status, so the `openai` exception classes stay meaningful: a late
  cancel is `ConflictError` (409), an unknown id `NotFoundError` (404), and `429` / `5xx` keep
  the package's own retry behaviour.
- Refusals by the transport itself, and local SDK errors such as `EscrowKeyUnverified`, are `400`
  (`BadRequestError`), with the SDK's message.
- A dropped connection is passed through as-is, so the package reports `APIConnectionError` and
  applies its own retry policy.
- **Submissions are never retried automatically.** Each retry would seal a new order under a new
  job id and could bill twice, so a failed `POST /v1/responses` or `POST /v1/batches` is marked
  `x-should-retry: false`. Reads and cancels keep the package's normal retries.

## Differences from OpenAI

| | OpenAI | VORQ |
| --- | --- | --- |
| Prompt delivery | Plaintext request body | Sealed in your process; a plaintext `/v1/responses` is refused |
| Waiting | Waits as long as the response takes | Waits too, bounded by the job's `sla` window |
| Response body | No VORQ fields | A top-level `vorq` block |
| `GET /v1/models` | A model list | Each entry also has a `vorq` block |
| Cancelling | `responses.cancel(id)` | The same call, signed by the owning wallet; a claimed job cannot be cancelled |
| Streaming | `stream: true` | Refused |
