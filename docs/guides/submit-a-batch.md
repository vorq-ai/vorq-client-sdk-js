---
title: Submit a batch
description: Seal many requests into one batch file, submit it, and read every line's result.
---

A batch is many jobs submitted as one file. Every line is sealed and paid for locally before
anything is uploaded, so the file the coordinator stores holds routing terms and ciphertext only.

## Write the lines

Each line is an OpenAI-style batch request. Put the model in `body`:

```ts
const requests = prompts.map((prompt, i) => ({
  custom_id: `row-${i}`,             // optional, 1–64 characters, unique in the batch
  url: "/v1/responses",              // or "/v1/embeddings"; one endpoint per batch
  body: { model: "moonshotai/kimi-k3", input: prompt, max_output_tokens: 512 },
}));
```

- `body.model` is required. `body.rate_in`, `body.rate_out` and `body.units_out` are order terms,
  taken out of the body; everything else in `body` is the model input.
- A line with neither rate takes the market. Before sealing, the client asks the coordinator for
  a plan: which providers take how many of those lines, and at which ask. A provider is never
  given more lines than its on-chain capacity leaves free, and each line is pinned to the
  provider it was planned to. If the network cannot take all of a model's unpriced lines in the
  window, `submit` raises `ValidationError` before anything is signed.
- `url` defaults to `/v1/responses`. `method` is ignored.
- `requests` may also be a JSONL string of such lines.

## Submit

```ts
const batch = await client.batches.submit(requests, "24h", { providers: [] });
await store.put(batch.id, { jobIds: batch.jobIds });   // keep both before waiting
```

- **`providers`** is required and applies to priced lines only; unpriced lines go where the plan
  puts them. Priced lines are assigned round-robin across the list, each sealed to its own
  provider. With an empty list (`{ providers: [] }`) every priced line is an
  [open order](./post-an-open-order.md), which needs a client built with a `verifier`.
- The window is `"1h"` / `"24h"`, or the tier names `"async"` / `"batch"`; it defaults to
  `"24h"`.
- `metadata` (at most 16 string pairs) is optional and stored **in plaintext** on the batch
  record.
- Every distinct model's input is checked against its published schema first, as `submit` does;
  `{ validateParams: false }` turns that off.

`batch.jobIds` lists each line's job id in input order. Until results are opened, the job id is
the only way to correlate a line: your `custom_id` travels sealed inside the line and the
coordinator never sees it.

## Read the results

```ts
import { JobError } from "@vorq-ai/client-sdk";

for (const line of await batch.results()) {
  if (line instanceof JobError) console.error(line.jobId, line.type, line.message);
  else console.log(line.customId, line.cost);
}
```

`results()` polls until the batch is terminal (`completed`, `failed`, `expired` or `cancelled`),
then returns every line: a `TextResult`, `MediaResult` or `EmbeddingResult` for a settled line,
or a `JobError` for one that produced nothing. Lines come back in **file order** (all settled
lines, then all failed ones), not input order; match them on `.customId` or `.jobId`.

To process lines as they are read instead of collecting them:

```ts
await batch.consume(
  async (result) => save(result.customId, result),
  async (error) => logFailure(error.jobId, error.type),
);
```

A batch whose input file was refused raises `BatchFailed`. A failed line is never an exception.

## Re-attach, list, cancel

```ts
const batch = client.batches.get(batchId);            // no network call
console.log(await batch.status(), batch.requestCounts);

const page = await client.batches.list({ limit: 20 });
const next = page.hasMore ? await client.batches.list({ after: page.lastId! }) : null;

await batch.cancel();   // lines no provider has claimed are cancelled; claimed ones finish
```

A re-attached handle has `jobIds: null`, which is why you store them at submit time.

## With the openai package

After submission, the stock `openai` client can read the batch too: `batches.retrieve`,
`batches.list` and `files.content(output_file_id)` all pass through
[`sealingFetch`](./use-the-openai-package.md#batches). Creating the batch must go through
`client.batches.submit`, which seals each line.
