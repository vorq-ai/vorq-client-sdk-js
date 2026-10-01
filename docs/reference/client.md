---
title: Client
description: The Client constructor and options, sessions, the retry policy, files, result bytes and low-level requests.
---

The public surface is exactly what `@vorq-ai/client-sdk` exports. Deep imports into `dist/` are not
supported at any version. Every method that touches the network returns a promise; `client.job(id)`
and `client.batches.get(id)` build a view from a stored id and make no request.

The client talks to a coordinator and to one storage gateway (for result bytes), and to nothing
else: it holds no RPC endpoint or storage credential and builds no transaction.

## Constructor

```ts
new Client(options?: ClientOptions)
Client.fromSessionToken(token: string, options?: ClientOptions)
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `string` | `"https://api.vorq.co"` | The coordinator origin. Trailing slashes are stripped. |
| `signer` | `Signer` | Node: a `PrivateKeySigner` over `$VORQ_WALLET_KEY` when it is set | The wallet. Signs the session handshake, every order, every payment authorization and every cancel. Required to submit or cancel. |
| `cipher` | `Cipher` | derived from the signer | Opens results; its public key is sealed into every submission. Without one, the client derives it from the signer on first use (`deriveResultCipher`: one wallet signature). |
| `sessionToken` | `string` | — | A pre-minted `vorq_sess_…` token, used as-is. Same as `Client.fromSessionToken`. |
| `verifier` | `Verifier \| null` | `null` | Attestation checks. Required for open orders and `confidential: true`. See [Verifier](./verifier.md). |
| `gateway` | `string` | `$VORQ_PIN_GATEWAY`, then `"https://ipfs.filebase.io"` | Storage gateway for result bytes. An empty string disables the read path. |
| `fetch` | `typeof fetch` | the platform's | Custom transport: a proxy, an instrumented `fetch`, a test double. |
| `maxRetries` | `number` | `3` | Cap on automatic retries per request. |
| `timeoutMs` | `number` | `900000` (15 min) | Per-request HTTP timeout. It bounds one network call, not how long a job takes. |
| `clock` | `() => number` | wall clock, seconds | Time source for the escrow-key cache. |

Every option is optional. A client with neither `signer` nor `sessionToken` can still make the
unauthenticated reads (models, chain and market data).

## Members

| Member | Meaning |
| --- | --- |
| `baseUrl`, `signer`, `cipher`, `verifier` | As constructed (`null` when not given). |
| `sessionToken` | The current token, or `null`. |
| `models` | [Models](./models.md). |
| `batches` | [Batches](./batches.md). |
| `submit(args)` | Submit a job. See [Submit](./submit.md). |
| `job(jobId)` | A `JobHandle` for a stored id, no network call. See [Jobs and results](./jobs-and-results.md). |
| `chainContext()`, `asks()`, `floors()`, `jobs()`, `jobsSummary()`, `evmJob()`, `providers()`, `allowlist()`, `escrowKey()` | See [Chain and market reads](./chain-and-market.md). |
| `uploadFile()`, `file()`, `fileContent()` | See [Files](#files). |
| `fetchBlob(cid)` | See [Reading result bytes](#reading-result-bytes). |
| `json()`, `request()` | See [Low-level requests](#low-level-requests). |
| `sealLine()`, `payLine()` | Low-level batch assembly. See [Submit](./submit.md#low-level-sealing). |
| `ensureSession()` | Mint or rotate the session now. |

## Sessions

A client with a `signer` authenticates by wallet: `GET /auth/nonce`, a `VorqSession` EIP-712
signature on the deployment's chain, then `POST /auth/session` returns a bearer token.

- `ensureSession()` runs before every request. It mints on first use and re-mints 60 seconds
  before the token expires; concurrent requests share one mint.
- A `401` re-mints once and re-sends the request, even one that is otherwise never retried.
- `Client.fromSessionToken(token)` uses the token as-is and never rotates it. Without a signer, a
  `401` raises `AuthenticationError`; with one, it re-mints once. `submit` still needs the
  signer and cipher.

```ts
mintSessionToken({ signer, baseUrl?, fetch? }): Promise<string>
```

Runs the handshake once and returns the token, for pointing another HTTP client at the
coordinator. `baseUrl` defaults to `"https://api.vorq.co"`.

## Retry policy

- A request is retried **only** when the response carries `x-vorq-retryable: true`, up to
  `maxRetries` times, with backoff `0.5 · 2^attempt + uniform(0, 0.25)` seconds.
- **Requests that create something are never retried**: job submissions, file uploads, batch
  creation and batch cancel. A job cancel follows the normal policy, since a job cannot be
  cancelled twice.
- **Network failures are never retried.** A request that never became a response raises
  `TransportError`. (A submission reconciles a dropped connection itself; see
  [Job lifecycle](../concepts/job-lifecycle.md#what-a-submission-does).)
- In a browser, `x-vorq-retryable` is readable only if the coordinator's CORS policy exposes it.

## Files

```ts
client.uploadFile(filename: string, purpose: string, content: Uint8Array | string): Promise<VorqFile>
client.file(fileId: string): Promise<VorqFile>
client.fileContent(fileId: string): Promise<string>
```

- `uploadFile` is a multipart `POST /v1/files`, never retried. `purpose` is `"batch"` (a batch
  input file, sent as `application/jsonl`), `"input"` (a sealed container too large to send
  inline) or `"result"` (a sealed result), the last two sent as `application/octet-stream`.
  `submit` and `batches.submit` call it for you.
- `file(id)` raises `NotFoundError` both for an unknown id and for another account's file.
- `fileContent(id)` returns the file body as text.

`VorqFile`:

| Member | Type | Meaning |
| --- | --- | --- |
| `id`, `filename`, `purpose`, `status` | `string` | |
| `bytes` | `number` | Size. |
| `createdAt` | `number \| null` | Unix seconds. |
| `expiresAt` | `number \| null` | Unix seconds. An upload expires 300 s after creation unless a job or batch uses it, which extends it to the coordinator's retention period. |
| `cid` | `string \| null` | The content id the stored object is readable by. |
| `lines` | `number \| null` | Non-blank line count, for a batch file. |
| `raw` | `Record<string, unknown>` | The file object as received. |

## Reading result bytes

```ts
client.fetchBlob(cid: string): Promise<Uint8Array>
```

A settled job names its result by content id, and those bytes are read from a storage gateway at
`{gateway}/ipfs/{cid}`, never from the coordinator. The read carries no credentials: the content
id is the entitlement. `handle.result()` and batch results call this for you.

- The gateway resolves in order: the `gateway` option, then `$VORQ_PIN_GATEWAY`, then the
  built-in default. An empty string at either level disables the read path and `fetchBlob`
  raises `VorqError`.
- A network error, `404` or `5xx` is retried, up to 8 attempts 1.5 s apart, since a just-settled
  result may still be propagating. Any other error status raises at once.

```ts
const client = Client.fromSessionToken(token, {
  baseUrl: "https://api.vorq.co",
  cipher,                              // needed to open the result
  gateway: "https://ipfs.filebase.io",
});
const result = await client.job(jobId).result(600);
```

## Low-level requests

```ts
client.json<T>(method: string, path: string, options?: RequestOptions): Promise<T>
client.request(method: string, path: string, options?: RequestOptions): Promise<Response>
```

Any coordinator route, with the session and retry policy applied. A non-2xx response raises the
matching [error](./errors.md) unless its status is in `allowStatuses`.

`RequestOptions`:

| Member | Type | Meaning |
| --- | --- | --- |
| `json` | `unknown` | Serialized as the JSON body. |
| `body` | `BodyInit` | A raw body, when `json` is not given. |
| `params` | `Record<string, string \| number \| bigint \| undefined>` | Query parameters; `undefined` values are dropped. |
| `headers` | `Record<string, string>` | Extra headers. |
| `retry` | `boolean` | Default `true`. `false` opts out of automatic retries. |
| `allowStatuses` | `number[]` | Statuses returned as a `Response` instead of raised. |

## Environment variables

Read in Node only; a browser has no environment.

| Variable | Used by |
| --- | --- |
| `VORQ_WALLET_KEY` | `new PrivateKeySigner()` with no key argument. |
| `VORQ_PIN_GATEWAY` | The result gateway, when the `gateway` option is not given. |
| `VORQ_SETTLEMENT_MARGIN` | Seconds added to the SLA window for an order's expiry (default `3600`; the expiry is capped at 24 hours). Read once at import. |
