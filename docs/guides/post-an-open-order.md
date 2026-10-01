---
title: Post an open order
description: Submit a job without naming a provider, so any provider that meets your price can claim it.
---

A designated order (`provider: N`) is sealed to one provider and only that provider can serve
it. An **open** order names no provider: it rests on the book and any provider whose ask your
bid meets can claim it. How the payload stays sealed on that path is explained in
[Sealing and keys](../concepts/sealing-and-keys.md#open-orders).

## Build the client with a verifier

An open order's payload is sealed to the coordinator's escrow key, and the SDK seals to that key
only after checking its attestation evidence. That check needs a `Verifier`:

```ts
import { Client, Verifier, deriveResultCipher } from "@vorq-ai/client-sdk";

const baseUrl = "https://api.vorq.co";
const client = new Client({
  baseUrl,
  signer,
  cipher: await deriveResultCipher(signer),
  verifier: new Verifier(baseUrl),
});
```

## Submit without a provider

```ts
const floors = await client.floors({ model: modelId, sla: "async" });
const floor = floors.floors[0];

const handle = await client.submit({
  model,
  input: "Summarize the attached notes in three bullet points.",
  sla: "async",
  rateIn: floor.rateIn,
  rateOut: floor.rateOut,
  // no provider: an open order
});
```

`floors` gives the cheapest input and output rate across listed providers for the window. The
two may come from different providers, so bidding exactly the floor on both sides is not
guaranteed to meet any single ask; bid at or above one provider's ask from `client.asks()` to be
sure. A bid below every ask rests until the order expires, and then ends as `expired`.

## When it is refused

| Situation | Result |
| --- | --- |
| Client built without a `verifier` | `EscrowKeyUnverified`; nothing posted. |
| The escrow key's evidence does not verify | `EscrowKeyUnverified` (the cause is on `.cause`); nothing posted. |
| The key cannot be fetched at all | `TransportError` or the coordinator's error. |

The SDK never falls back to a named provider. To target one, pass `provider` yourself.

A verified escrow key is reused for three hours. `verifier.refresh()` does not shorten that; to
act on a revoked key immediately, build a new `Client`, or name a provider.

## Open batches

`client.batches.submit(lines, window, { providers: [] })` makes every line an open order, under
the same rule: the client needs a `verifier`.
