---
title: Use the openai package
description: Run the stock openai npm package against VORQ through the sealing transport, sealingFetch.
---

The coordinator never accepts a plaintext prompt, so a plain `POST /v1/responses` is refused.
The stock `openai` package still works, unmodified, through `sealingFetch(…)`: a `fetch` you pass
to `new OpenAI({ fetch })`. It seals each Responses request in your process, submits the order,
waits or polls, and opens the result on the way back.

`openai` is not a dependency of this package; install it yourself:

```sh
npm install openai @vorq-ai/client-sdk
```

## Configure the client

```ts
import OpenAI from "openai";
import { sealingFetch } from "@vorq-ai/client-sdk";

const openai = new OpenAI({
  baseURL: "https://api.vorq.co/v1",
  apiKey: "unused",                             // the wallet session authenticates
  fetch: sealingFetch(),                        // signs with $VORQ_WALLET_KEY
});

const response = await openai.responses.create({
  model: "moonshotai/kimi-k3",
  input: "Say hello.",
  // The openai types do not know the `vorq` field, so state the params type.
  vorq: { sla: "batch" },
} as OpenAI.Responses.ResponseCreateParamsNonStreaming);

console.log(response.output_text);
```

- **`sealingFetch()`** talks to `https://api.vorq.co` and signs with `$VORQ_WALLET_KEY`. In a
  browser, pass `sealingFetch({ signer })` with a browser wallet signer.
- **Two base URLs.** `new OpenAI({ baseURL })` takes the `/v1` suffix; `sealingFetch({ baseUrl })`,
  when you set it, takes the **bare coordinator origin**. The coordinator must be mounted at the root: a prefixed
  base such as `https://host/api/v1` matches no route and every call is refused.
- **`apiKey`** is not used; any non-empty string satisfies the constructor.
- **In a browser**, the `openai` package also needs `dangerouslyAllowBrowser: true`. No secret is
  exposed by it here: the key is unused and the wallet signs.
- To reuse a `Client` you already have, pass `sealingFetch({ client })` instead of the other
  options.

## Put VORQ terms in the `vorq` block

| Key | Meaning |
| --- | --- |
| `sla` | The completion window, `"1h"` or `"24h"` (tier names `"async"` / `"batch"` also work). Defaults to `"1h"`. |
| `rate_in` / `rate_out` | Your bid, in USD per 1M units as decimal strings (`"0.05"`). With neither, the order takes the [market](../reference/submit.md#no-bid-named): the first provider the coordinator ranks, at its own ask. With only one, the other side is zero. |
| `provider` | A provider id. The request is sealed to that provider. Omitted with a bid named: an [open order](./post-an-open-order.md), which needs `sealingFetch({ verifier })`. |

With a bid named, no `vorq.provider` and no verifier, the request comes back as a `400`
(`openai.BadRequestError`) whose message names the escrow key; nothing is posted.

## Wait, or run in the background

Without `background`, `responses.create` waits for the job, bounded by its window. A `"24h"` job
can hold the call for up to a day, so use `background: true` whenever the wait might outlive the
connection or, in a browser, the page:

```ts
let response = await openai.responses.create({
  model: "moonshotai/kimi-k3",
  input: "Summarize the attached notes in three bullet points.",
  background: true,
  vorq: { sla: "batch" },
} as OpenAI.Responses.ResponseCreateParamsNonStreaming);

// store response.id here if the process might not outlive the job
while (response.status === "queued" || response.status === "in_progress") {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  response = await openai.responses.retrieve(response.id);
}
console.log(response.output_text);
```

`responses.cancel(id)` cancels a job no provider has claimed yet; a claimed one is refused with
`openai.ConflictError`.

A job that fails while you wait comes back as a normal response with `status: "failed"` and an
`error` object, not as an exception.

## Batches

Creating a batch uploads a JSONL of prompts, so `files.create({ purpose: "batch" })` is refused.
Create it with the native `client.batches.submit(requests, …)`, which seals every line (see
[Submit a batch](./submit-a-batch.md)). Everything after that works with the stock client:

```ts
let batch = await openai.batches.retrieve(batchId);
// …poll until batch.status is terminal, then:
if (batch.status === "completed" && batch.output_file_id) {
  const jsonl = await (await openai.files.content(batch.output_file_id)).text();
}
```

The output file's rows reference sealed results; the native `batchHandle.results()` fetches and
opens them for you.

## What is not available

- `stream: true`, on create or retrieve: a sealed result is one object delivered at settlement.
- `metadata` on a response: a caller-chosen identifier would link your jobs across providers.
- Chat Completions, audio, images, moderations, file uploads and every other route outside the
  short forwarded list.

All of these are refused with a `400` before the request body is read. The complete behaviour,
including the forwarded routes and error mapping, is in the
[sealingFetch reference](../reference/sealing-fetch.md).
