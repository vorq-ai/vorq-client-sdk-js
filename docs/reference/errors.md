---
title: Errors
description: The VorqError hierarchy, what raises each class, and the job end causes JobFailed reports.
---

Every error the SDK raises about a network, protocol or wallet condition descends from
`VorqError`, and every class below is exported:

```ts
import { VorqError } from "@vorq-ai/client-sdk";

try {
  await client.submit({ model, input, provider: 7 });
} catch (error) {
  if (error instanceof VorqError) console.error(error.name, error.type, error.statusCode, error.requestId);
  else throw error;
}
```

```
VorqError                  # base; .type, .statusCode, .requestId
├── AuthenticationError    # 401: bad or missing session
├── TransportError         # the request never became a response; .cause
├── NotFoundError          # 404: unknown job, file, model or batch id
├── StateConflictError     # 409: illegal state change, e.g. cancelling a claimed job
├── ValidationError        # 400, and every local refusal before a request
├── VerificationError      # attestation evidence failed verification
│   └── EscrowKeyUnverified  # an open order could not be sealed to a verified escrow key
├── ResultIntegrityError   # a settled job's result cannot be read as a result
├── WaitTimeout            # a wait ran out; .jobId
├── JobFailed              # a job ended failed or cancelled; .errorType, .jobId
├── BatchFailed            # a batch's input file was refused; .batchId
├── ContainerError         # a malformed sealed container; .fault
├── DerivedKeyMismatch     # a wallet derived a different result key for the same address
├── NoWalletError          # the wallet exposed no account
└── WalletRejectedError    # the user dismissed a wallet prompt
```

## `VorqError`

| Member | Type | Meaning |
| --- | --- | --- |
| `type` | `string \| null` | The error type from the response body (`error.type`), or a local one. |
| `statusCode` | `number \| null` | The HTTP status, or `null` for a local error. |
| `requestId` | `string \| null` | The `x-request-id` response header. Include it in bug reports. |

A coordinator error maps by status: `400` → `ValidationError`, `401` → `AuthenticationError`,
`404` → `NotFoundError`, `409` → `StateConflictError`. Any other status (`403`, `429`, `5xx`, …)
is a plain `VorqError` with its `statusCode`.

## Classes

- **`TransportError`**: DNS, refused connection, TLS, timeout or abort. The original error is on
  `.cause`. Never retried automatically.
- **`ValidationError`**: a `400`, and every local refusal: a submission without signer and cipher,
  a malformed rate or unit count, a param the model's schema refuses, a reasoning budget that
  consumes the whole output cap, a reference asset over a limit, `confidential: true` without a
  verifier, a cancel without a wallet or with a drifted clock, an invalid batch window or line.
- **`VerificationError`**: evidence that does not verify, or a provider with no published key.
- **`EscrowKeyUnverified`**: raised before anything is posted when an open order has no verifier
  or the escrow key fails verification (the underlying error is on `.cause`).
- **`ResultIntegrityError`**: a `completed` job that names no result, bytes that are not a
  result or do not open with this client's key, or a frame that is not valid base64.
- **`WaitTimeout`**: `.jobId` is the job (or batch) id, so you can re-attach. Timing out cancels
  nothing.
- **`BatchFailed`**: `.batchId`. Per-line failures are `JobError` values, not exceptions.
- **`ContainerError`**: `.fault` is `"too_short"`, `"bad_version"` or `"commitment_mismatch"`.
- **`NoWalletError`**, **`WalletRejectedError`**: from `BrowserWalletSigner`.

## `JobFailed`

`.errorType` is the job's end cause. Branch on it, not on the status:

| `.errorType` | Status | Meaning |
| --- | --- | --- |
| `provider_fail` | `failed` | The provider reported it could not deliver. |
| `reclaim` | `failed` | A provider claimed it and did not settle within the window. |
| `cancelled` | `cancelled` | You cancelled it. |
| `expired` | `cancelled` | No provider claimed it before it expired. |

An end cause this release does not know falls back to the status.

## Plain `Error`

Programming mistakes raise a plain `Error`, not a `VorqError`, so a `catch` for network
conditions does not hide integration bugs: no key for `PrivateKeySigner`, a key of the wrong
length or a non-hex string, an unknown `Verifier` mode or invalid option, `encrypt` on a
`SealedBoxCipher` with no recipient, and passing both `client` and other options to
`sealingFetch`.
