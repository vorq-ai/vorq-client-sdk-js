---
title: Pricing and payment
description: How rates, unit counts, the escrow cap and the payment authorization fit together.
---

Every order states its own price. You name the most you will pay for each side of the job, and
the order signs the ask of a provider at or under it.

## Cap what you pay

The simplest order names one ceiling and no provider:

```ts
const handle = await client.submit({
  model: "moonshotai/kimi-k3.1-pro:mxfp4",
  input: "Summarize the plot of Hamlet in three bullet points.",
  maxRateIn: "1.5",       // never more than $1.50 per 1M input tokens
});
```

`maxRateIn` protects you from being overcharged: the order never signs an input rate above it,
whatever providers are asking when it is posted, and when a provider asks less you pay that. It
caps the input side only; the output side pays the matched provider's ask unless you name
`maxRateOut` too. This matters most in a [batch](../guides/submit-a-batch.md), where every line
is signed and paid for in one call.

Set it too low and no provider matches: the order
[rests](../reference/submit.md#how-the-rates-are-chosen) and may expire without being served.

## Rates are USD per 1M units

A rate is **USD per 1 000 000 units of work**, written as a decimal string: `"0.05"` is five
cents per million units. A unit of work is a token for text and embeddings, a pixel for images
and a pixel-second for video.

Every amount the SDK takes or returns is a USD decimal string: ASCII digits, an optional
fraction, no sign, exponent or leading zeros. A `number` or `bigint` rate is refused, and so is
a fraction finer than the payment token carries (6 digits for a 6-decimal token); it is never
rounded. The chain signs atomic token units, and the SDK converts at the token's `decimals`
from `client.chainContext()`: `"0.05"` is `50000` at 6 decimals.

`maxRateIn` and `maxRateOut` are **ceilings**, each optional. `submit` asks the coordinator for
the live asks within them and signs the first one's own rates, so you pay the ask and never
more than a ceiling. A side you leave out has no ceiling: you pay the provider's ask there,
whatever it is. When no provider is within the ceilings the order
[rests](../reference/submit.md#how-the-rates-are-chosen) at them instead.

## Two sides, two unit counts

The order signs two rates, `rateIn` and `rateOut`, and two unit counts the SDK derives from the request
before sealing:

- **`units_in`**: the most input the job may bill. For text and embeddings, the byte length of
  the canonical JSON input: a ceiling that sits above the model's own prompt count, chat
  template included, for anything but a few-word prompt. For image and video, the reference
  assets you attach, in pixel-seconds.
- **`units_out`**: the most output the job may bill. For text, the output-token ceiling you set;
  for images, pixels per image times the image count; for video, frame pixels times seconds.

The exact rules are in [Units](../reference/submit.md#units). `unitsOut` on `submit` overrides
the derived output count.

## The cap and the payment

The signed terms fix the most a job can cost, its **cap**:

```
cap = ceil((rateIn × units_in + rateOut × units_out) / 1 000 000)     (at least 1)
```

The chain computes this in atomic units, so the cap is at least one atomic unit
(`"0.000001"` USD for a 6-decimal token).

Settlement charges what the job used, never more than the cap:

```
charge = ceil(((promptTok − cachedTok) × rateIn
              + cachedTok × rateInCached
              + completionTok × rateOut) / 1 000 000)            (at least 1)
```

`promptTok` is the model's own prompt count, at most `units_in`; for media it is the declared
reference units. `cachedTok` is the part of the prompt the model served from its cache, billed at
`rateInCached`, which is never above `rateIn` (0 when the model reports none, always 0 for media).
`completionTok` is the delivered output, at most `units_out`.

At submission the coordinator quotes an amount in USD, and the client signs an EIP-3009
`ReceiveWithAuthorization` for it in the deployment's USDC token. For a batch the client computes
the same amount per line itself:

```
amount = cap + floor(cap × feeBps / 10 000) + gas fee
```

`feeBps` is the protocol fee from `client.chainContext()`, and the gas fee comes from the quote.
The client derives every other member of the authorization itself: it is payable to the job
registry, valid until the order's expiry, and single-use because its nonce is the job id. A
quote describing any other authorization is refused.

Nothing moves while the order is open. The chain pulls the amount when a provider claims the
job, and job rows report the gas fee it used as `gas_fee` and the protocol fee settlement took as
`fee` (`"0"` until the job settles). How the job ends decides who keeps what:

| Ending | Provider | Treasury | Refunded to you |
| --- | --- | --- | --- |
| Settled | the charge | `floor(charge × feeBps / 10 000)` + gas fee | the rest |
| Provider failed, or reclaimed after the window | nothing | gas fee | cap + protocol fee on the cap |
| Cancelled or expired while open | nothing | nothing | nothing was taken |

## What a result reports

Each result's `.cost` is the charge formula above, computed locally from the counts and rates the
job settled on (the job row's `prompt_tok`, `cached_tok`, `completion_tok`, `rate_in`,
`rate_in_cached` and `rate_out`), as an exact decimal string in **USD**, never rounded. It covers the rate charge only; the protocol fee and
gas fee are not included. They are reported separately as `.fee` (the protocol fee settlement
took) and `.gasFee`, both USD strings.

## Finding a price

`client.asks({ model })` lists each provider's published rates per window. It takes the model's
integer id (`Number(model.vorq.model_id)` from `client.models.list()`), not its name. See
[Chain and market reads](../reference/chain-and-market.md).
