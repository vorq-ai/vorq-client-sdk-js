---
title: Post an open order
description: Let an order rest at your price when no provider is within it, so any provider that accepts it can claim it.
---

An order goes to the first provider asking at or under its ceilings. When none is, and the order
names no `provider`, it becomes an **open** order: it rests on the book at its ceilings and any
provider that accepts those rates can claim it. How the payload stays sealed on that path is explained in
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

## Submit under the market

```ts
const handle = await client.submit({
  model,
  input: "Summarize the attached notes in three bullet points.",
  sla: "async",
  maxRateIn: "0.04",
  maxRateOut: "0.12",
  // no provider: rests open when nobody asks this little
});
```

`client.asks()` lists what providers ask today. With ceilings at or above one provider's ask on
both sides, the order is matched to it straight away and pays that ask; with ceilings under
every ask, it rests at them until a provider accepts or the order expires, and then ends as
`expired`.

Name only one ceiling and the other side rests at the market rate, the rate of the cheapest
live ask for the job. See
[How the rates are chosen](../reference/submit.md#how-the-rates-are-chosen).

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
