---
title: Pricing and payment
description: How rates, unit counts, the escrow cap and the payment authorization fit together.
---

Every order states its own price. There is no price list the client accepts implicitly: you bid
a rate for each side of the job, and a provider whose ask your bid meets claims it.

## Rates are USD per 1M units

A rate is **USD per 1 000 000 units of work**, written as a decimal string: `"0.05"` is five
cents per million units. A unit of work is a token for text and embeddings, a pixel for images
and a pixel-second for video.

Every amount the SDK takes or returns is a USD decimal string: ASCII digits, an optional
fraction, no sign, exponent or leading zeros. A `number` or `bigint` rate is refused, and so is
a fraction finer than the payment token carries (6 digits for a 6-decimal token); it is never
rounded. The chain signs atomic token units, and the SDK converts at the token's `decimals`
from `client.chainContext()`: `"0.05"` is `50000` at 6 decimals.

Omit **both** rates and `submit` takes the [market](../reference/submit.md#no-bid-named): the
first provider the coordinator ranks, at its own ask. Omit only one and that side is a bid of
**zero**: the order is posted, no provider asking more claims it, and it expires.

## Two sides, two unit counts

The order signs `rateIn` and `rateOut`, and two unit counts the SDK derives from the request
before sealing:

- **`units_in`**: the input. For text and embeddings, one unit per four bytes of the canonical
  JSON input. For image and video, the reference assets you attach, in pixel-seconds.
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

Each result's `.cost` is computed locally from the signed rates and the unit counts the result
reports (token usage, delivered pixels or pixel-seconds), divided by 1 000 000, as an exact
decimal string in **USD**, never rounded. It covers the rate charge only; the protocol fee and
gas fee are not included. They are reported separately as `.fee` (the protocol fee settlement
took) and `.gasFee`, both USD strings.

## Finding a price

- `client.asks({ model })` lists each provider's published rates per window.
- `client.floors({ model, sla })` gives the cheapest input and output rate per window. The two
  minima may come from different providers.

Both take the model's integer id (`Number(model.vorq.model_id)` from `client.models.list()`),
not its name. See [Chain and market reads](../reference/chain-and-market.md).
