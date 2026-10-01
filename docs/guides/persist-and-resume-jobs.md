---
title: Persist and resume jobs
description: Store job ids so a reload, crash or restart never loses a job or pays for it twice.
---

The job lives on the network; a `JobHandle` is only a view of its id. Lose the handle (a page
reload, a crash, a deploy) and the job carries on. What you must not lose is the **id**.

## Store the id before you wait

```ts
import { WaitTimeout } from "@vorq-ai/client-sdk";

const handle = await client.submit({ model, input, sla: "batch", rateIn, rateOut, provider });
await store.put(handle.id, { status: "submitted" });       // BEFORE waiting on anything

try {
  const result = await handle.result(900);                 // wait up to 15 minutes here
  await store.put(handle.id, { status: "completed", cost: result.cost });
} catch (error) {
  if (!(error instanceof WaitTimeout)) throw error;
  await store.put(handle.id, { status: "waiting" });       // re-attach later; do NOT resubmit
}
```

`store` stands for your own storage: a database in Node, `localStorage` in a page.

## Re-attach later

```ts
const handle = client.job(jobId);   // no network call; never creates a job
const result = await handle.result();
```

`client.job(id)` builds a handle from the id alone. It cannot create or pay for anything, so
resuming after a crash is always safe. Any process or tab holding the same wallet (and so the
same derived result key) can re-attach.

- Without a `timeoutSeconds`, `result()` waits for the job's whole SLA window **from now**. A
  re-attached handle reads the window from the job row, and assumes 1 hour if the row names
  none.
- `WaitTimeout` carries `.jobId`; `client.job(error.jobId!).result()` resumes waiting.
- A timeout never cancels the job.

## Make writes idempotent

Key every write by the job id, so processing the same result twice (a retry, two tabs, a
resumed worker) is a no-op rather than a duplicate.

## Many jobs at once

`result()` suspends one promise and blocks nothing, so jobs can be in flight concurrently:

```ts
const handles = await Promise.all(
  prompts.map((p) => client.submit({ model, input: p, sla: "async", rateIn, rateOut, provider })),
);
await Promise.all(handles.map((h) => store.put(h.id, { status: "submitted" })));
const results = await Promise.all(handles.map((h) => h.result()));
```

Each handle polls about once a minute. For many requests of the same kind,
[a batch](./submit-a-batch.md) prices and uploads them together.

## Check without waiting

```ts
const status = await client.job(jobId).status(); // "queued" | "in_progress" | "completed" | "failed" | "cancelled"
```

## Cancel a job

```ts
await client.job(jobId).cancel();
```

A cancel is signed by the wallet that owns the job and relayed by the coordinator, so the client
needs its `signer`. Only a job no provider has claimed yet can be cancelled; a claimed one is
refused with `StateConflictError` and runs to completion. The signature carries a timestamp the
chain accepts within ±600 seconds, so a machine with a badly wrong clock is refused with
`ValidationError` before anything is sent.
