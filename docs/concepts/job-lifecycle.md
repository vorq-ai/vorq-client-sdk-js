---
title: Job lifecycle
description: How a job moves from submission to settlement, what the SLA window bounds, and why the id is what you keep.
---

VORQ is submit-and-collect. `submit` returns a job id as soon as the order is on the book; a
provider claims it, runs it, and settles the result inside the job's SLA window. There is no
synchronous call and no token stream: the result is one sealed object, delivered at settlement.

## SLA windows

Every order signs a completion window, a maximum rather than an estimate:

| Tier | Window | Completes within |
| --- | --- | --- |
| `async` | `1h` | 1 hour |
| `batch` | `24h` | 24 hours |

A `batch` job usually takes minutes to a few hours; 24 hours is the maximum.

The SDK accepts either spelling and signs the window in seconds. `submit` defaults to `batch`;
the OpenAI-compatible transport defaults to `1h`.

## What a submission does

1. **Seal.** The input is encrypted in your process into a container addressed to one recipient:
   the named provider, or for an open order the coordinator's escrow. See
   [Sealing and keys](./sealing-and-keys.md).
2. **Sign the order.** The terms (model, window, rates, unit counts, recipient, expiry and a
   commitment to the sealed bytes) are signed as EIP-712 typed data. The job id is derived from
   your address and that commitment, so the client knows it before anything is sent.
3. **Quote.** The terms alone are posted; the coordinator answers `402` with the amount to
   authorize.
4. **Pay and post.** The client signs an EIP-3009 payment authorization for that amount and
   posts it with the sealed container. Containers too large to travel inline are uploaded first
   and referenced by content id.

If the gas fee moves between quote and post, the coordinator answers with a new quote and the
client re-signs the payment only, up to three times. If the connection drops during the post,
the client asks whether the job it already knows the id of was posted, and re-sends once only
if it was not. A submission is never blindly retried, so one call never pays twice.

## States

| Status | Meaning |
| --- | --- |
| `queued` | On the book, not yet claimed. |
| `in_progress` | Claimed by a provider. |
| `completed` | Settled; the result is readable. |
| `failed` | Ended without a result: the provider reported failure, or claimed it and did not settle in time. |
| `cancelled` | Ended unclaimed: you cancelled it, or it expired with no claim. |

The last three are terminal. For `failed` and `cancelled`, the job row's end cause says which,
and `JobFailed.errorType` carries it: `provider_fail`, `reclaim`, `cancelled` or `expired` (see
[Errors](../reference/errors.md#jobfailed)).

An order carries an expiry: its window plus a settlement margin (one hour by default), capped at
24 hours from signing. The payment authorization is valid until the same moment.

## Cancelling

Only the wallet that owns a job can cancel it: the client signs a `Cancel` message and the
coordinator relays it to the chain. A job a provider has already claimed cannot be cancelled and
runs to completion.

## Jobs are durable, handles are not

A `JobHandle` holds nothing but the id and the last row it read. Losing it loses nothing;
`client.job(id)` rebuilds it without a network call, from any process that holds the same
wallet. So the one rule is: **store the id before you wait**, and key your own writes by it.
See [Persist and resume jobs](../guides/persist-and-resume-jobs.md).

## Waiting

`handle.result()` reads the job, then polls until the job is terminal. A `1h` job is read once
a minute. A `24h` job is read once a minute for the first 15 minutes of the wait, every 3
minutes for the rest of the first hour, and every 10 minutes after that. A batch waits on the
same schedule as a `24h` job, with one read of the batch per poll whatever its line count. The wait is bounded by the
window unless you pass a timeout. Running out raises `WaitTimeout` and leaves the job running.

When the job is `completed`, the client reads the sealed result by its content id from a
storage gateway, not from the coordinator, and opens it with your result key.
