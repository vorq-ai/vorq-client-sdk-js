---
title: Verifier
description: Verifier — the attestation checks run before a payload is sealed to an escrow or provider key.
---

A `Verifier` checks, before a payload is sealed, that the key it will be sealed to belongs to
something the network allows. A client needs one for open orders and for `confidential: true`.

```ts
const verifier = new Verifier(baseUrl: string, options?: VerifierOptions);
const client = new Client({ baseUrl, signer, cipher, verifier });
```

`baseUrl` is where chain state is read from (`/evm/allowlist`, `/evm/providers/{id}`), usually
the same coordinator as the client.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `"structural" \| "mock"` | `"structural"` | `"mock"` also accepts mock-tagged evidence, for development networks. Any other value throws `Error`. |
| `minTcbSvn` | `number` | `1` | Minimum TCB security version for measured evidence. A non-negative integer. |
| `timeoutMs` | `number` | `30000` | Per-request timeout for chain-state reads. |
| `fetch` | `typeof fetch` | the platform's | Custom transport. |
| `allowlistTtlS` | `number` | `60` | How long a fetched allowlist is reused, in seconds. |
| `clock` | `() => number` | monotonic, seconds | Elapsed-time source for the TTL. |
| `wallClock` | `() => number` | wall clock, seconds | Source for the escrow key freshness check. |

## Methods

| Method | Meaning |
| --- | --- |
| `allowlist()` | The allowlist entries (a copy), re-read after the TTL. |
| `refresh()` | Drops the cache and re-reads. |
| `invalidate()` | Drops the cache; the next check re-reads. |
| `verifyEscrowKey(announcement)` | Checks a raw `GET /key` body; resolves to the key or raises. |
| `verifyRecord(record)` | Checks a raw provider record; resolves or raises. |
| `verifyCandidates(candidates)` | Filters a list of `{ provider, box_key }` entries to those whose record verifies and matches the key. |

## Escrow key

Used by open orders. The announcement must carry a 32-byte hex key, be issued within ±600 s of
the verifier's clock, carry evidence whose report data binds the announced key, and state
`debug: false`.

| Evidence type | Accepted |
| --- | --- |
| `static-coordinator-v1` | In every mode. An escrow key held by the coordinator operator, with no measured hardware; no allowlist read. |
| `mock-coordinator-v1` | Only in `mode: "mock"`. Its measurement must also be an active allowlist entry and its TCB at least `minTcbSvn`. |
| anything else | Refused. |

## Provider records

Used by `confidential: true`. The evidence's measurement must be an active, unrevoked image entry
on the allowlist; its report data must bind the record's box key and operator; it must state
`debug: false`; and its TCB version must be at least `minTcbSvn`.

This release has no validator for hardware-vendor evidence: only `mock-cvm-v1` evidence verifies,
and only in `mode: "mock"`. In `structural` mode, `confidential: true` therefore raises
`VerificationError` for every provider.

## Failure

Malformed input is a `VerificationError`, and a check that cannot be evaluated counts as failed.
Chain state that cannot be read raises (`TransportError` or the coordinator's error) rather than
being treated as empty.

| Situation | Result |
| --- | --- |
| `submit({ confidential: true })` without a verifier | `ValidationError`, before any request. |
| `submit()` with no `provider`, without a verifier | `EscrowKeyUnverified`, nothing posted. |
| `batches.submit(…, { providers: [] })` without a verifier | `EscrowKeyUnverified`, nothing uploaded. |
| An escrow key that fails verification | `EscrowKeyUnverified`, with the `VerificationError` as `.cause`. |
| A named provider that fails under `confidential: true` | `VerificationError`. Never substituted. |

In every case the refusal happens before the payload is sealed. A verified escrow key is reused
by the client for three hours; `refresh()` does not shorten that.
