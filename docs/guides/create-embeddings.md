---
title: Create embeddings
description: Submit an embedding job, price it with no output side, and read the vectors.
---

Embeddings use the same `submit` call with an embedding model. Two things differ from text: the
order should buy no output units, and the result is an `EmbeddingResult`.

## Submit

```ts
const handle = await client.submit({
  model: embeddingModel,
  input: { input: ["first passage", "second passage"], encoding_format: "base64" },
  sla: "async",
  maxRateIn,
  unitsOut: 0,        // an embedding has no output side to pay for
  provider,
});
```

`unitsOut: 0` matters. Without it, a request that names no output-token ceiling is priced as a
text job with a default ceiling of 4096 output units, and your payment authorization covers that
at the order's output rate. See [Units](../reference/submit.md#units).

## Read the vectors

```ts
import { EmbeddingResult } from "@vorq-ai/client-sdk";

const result = await handle.result();
if (result instanceof EmbeddingResult) {
  console.log(result.embeddings.length, "vectors,", result.promptTokens, "input tokens");
  const raw = result.bytes();   // one Uint8Array per vector
}
```

- `.embeddings` is the response's `data` array, as returned.
- `.bytes()` decodes vectors requested with `encoding_format: "base64"`. For `float` output it
  raises; read `.embeddings` directly.
- `.cost` is `promptTokens × rateIn ÷ 1 000 000` in USD; an embedding has no
  output charge.

## In a batch

Set every line's `url` to `/v1/embeddings` and put `units_out: 0` in each `body`. A batch holds
one endpoint only, so embeddings and text go in separate batches. See
[Submit a batch](./submit-a-batch.md).
