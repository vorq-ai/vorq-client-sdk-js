---
title: Submit
description: client.submit — every argument, SLA windows, local validation, unit derivation and reference-asset limits.
---

```ts
client.submit(args: SubmitArgs): Promise<JobHandle>
```

```ts
interface SubmitArgs {
  model: string;
  input: string | Record<string, unknown>;
  sla?: string;                                   // default "batch"
  maxRateIn?: string | null;                      // USD per 1M units, e.g. "0.05"
  maxRateOut?: string | null;
  provider?: number;
  validateParams?: boolean;                       // default true
  confidential?: boolean;                         // default false
  unitsOut?: number;
  customId?: string;
}
```

```ts
// One ceiling, no provider: never more than $0.60 per 1M input tokens.
const handle = await client.submit({ model: "moonshotai/kimi-k3", input: "Hello", maxRateIn: "0.6" });
```

A ceiling protects you from being overcharged: the order signs the matched provider's ask, and
never a rate above the ceiling on that side. Set it too low and no provider matches: the order
[rests](#how-the-rates-are-chosen) and may expire without being served.

Submissions are always sealed: a client missing its `signer` or `cipher` raises
`ValidationError` before anything is sent. The returned handle is described in
[Jobs and results](./jobs-and-results.md); the steps a submission runs are in
[Job lifecycle](../concepts/job-lifecycle.md#what-a-submission-does).

## Arguments

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `string` | — | A model id from [`client.models.list()`](./models.md). A model the catalog gives no numeric `model_id` raises `ValidationError`. |
| `input` | `string \| object` | — | A `string` is shorthand for `{ input: string }`. An object is the model's own input, sealed as-is. |
| `sla` | `string` | `"batch"` | A tier (`"async"` / `"batch"`) or a window (`"1h"` / `"24h"`). See [SLA windows](#sla-windows). |
| `maxRateIn` | `string \| null` | `null` | The most the order pays for the input side, in [USD per 1M units](../concepts/pricing-and-payment.md#rates-are-usd-per-1m-units), e.g. `"0.05"`. `null` is no ceiling on that side. See [How the rates are chosen](#how-the-rates-are-chosen). |
| `maxRateOut` | same | `null` | The most it pays for the output side, same unit. |
| `provider` | `number` | — | A provider's registry id. Only its ask is considered, and the payload is sealed to its published key. Omit it and an order no provider is within rests as an [open order](../guides/post-an-open-order.md). |
| `validateParams` | `boolean` | `true` | Run [local validation](#local-validation) before sealing. |
| `confidential` | `boolean` | `false` | Verify the named provider's attestation evidence before sealing to it. Requires a `verifier`. |
| `unitsOut` | `number` | derived | The output unit count, exactly, overriding [the derived value](#units). A non-negative integer; `0` for an embedding. |
| `customId` | `string` | — | Your own label, sealed **inside** the payload and returned as `.customId` on the opened result. Never sent in the clear. |

**Rates are USD decimal strings, in code and on the wire.** A `number` or `bigint`, a sign, an
exponent, or more fraction digits than the payment token carries raises `ValidationError`; a rate
is never rounded. The order signs the atomic value (`"0.05"` is `50000` at 6 decimals).

**Recipient.** An order matched to a provider, or resting with `provider` named, is sealed to
the key in that provider's registry record (`GET /evm/providers/{id}`); a record with no key
raises `VerificationError`. An order resting with no `provider` is sealed to the coordinator's
verified escrow key, which requires a `verifier`; without one, or if the key does not verify,
`EscrowKeyUnverified` is raised and nothing is posted.

**`confidential: true`** without a `verifier` raises `ValidationError` before any request. With
one, the named provider's evidence must verify or `VerificationError` is raised; another
provider is never substituted. On an open order it adds nothing, since the escrow key is verified
on that path anyway.

`stream`, `metadata` and `user` are not job params: a sealed result is delivered once, at
settlement, and a caller-chosen identifier would link your jobs to each other across providers.

## How the rates are chosen

`submit` first asks the coordinator for the market: a `POST /v1/jobs` with the job's model,
window and units and your ceilings, no rates and no signature, so it costs no wallet prompt. The
coordinator answers with every live provider that has a free slot and an ask at or under the
ceilings, ranked by what this job would cost at their ask, and among equal prices the provider
picked least recently first. `submit` signs the first candidate's **own ask** and pins the
order to it, so providers at the same price take turns.

With `provider` as well, the probe is pinned too, and the only candidate is that provider's
ask. With `confidential: true` and no `provider`, the list is first filtered to candidates
whose attestation verifies.

When no provider is within the ceilings, the order **rests** until one accepts it or it
expires. An order signs both rates, so it rests at:

| Ceilings named | Rates the order rests at |
| --- | --- |
| both | your two ceilings |
| one | your ceiling on that side, and the **market rate** on the other: the rate of the cheapest live ask for this job, read by a second probe |
| none | nothing to rest at: `ValidationError` is raised before anything is signed |

With one ceiling named and no live ask for the model in the window there is no market rate to
take, and `ValidationError` is raised as well. A resting order is paid at the rates it signed.

## SLA windows

| Tier | Window | Seconds signed |
| --- | --- | --- |
| `"async"` | `"1h"` | 3600 |
| `"batch"` | `"24h"` | 86400 |

A `"batch"` job usually takes minutes to a few hours; 24 hours is the maximum.

Other windows of the form `<n>h`, `<n>m` or `<n>s` are signed as written and validated by the
network; a string of any other form is signed as 3600 s. Job rows report the window as `vorq.sla_secs`.

The order's expiry is the window plus the settlement margin (`$VORQ_SETTLEMENT_MARGIN`, default
3600 s), capped at 86400 s from signing.

## Local validation

Before sealing, an object `input` is checked against the model's published `params_schema`
(`client.models.paramsSchema(model)`):

- A param the schema sets to `false`, or a value that fails its subschema, raises
  `ValidationError` and nothing is sent.
- A param the schema does not mention is sent, with a `console.warn`: the serving provider may
  support it or ignore it.
- Keywords evaluated: `type`, `minimum`, `maximum`, `enum`, `oneOf`, `items`, `properties`.
  Any other keyword is skipped with a warning; the provider still applies it.
- No published schema, or a failed schema read, skips the schema check.

**One check needs no schema.** When the input names an output cap (`max_tokens`,
`max_output_tokens` or `max_completion_tokens`; the smallest one counts), a
`reasoning_max_tokens` at or above the cap, or a `min_tokens` above it, raises `ValidationError`:
reasoning tokens are billed as output, out of the same cap, and would leave no room for an
answer.

`validateParams: false` turns off both checks.

## Units

The order signs `units_in` and `units_out`, which settlement meters against `rateIn` and
`rateOut`. The SDK derives both from the input object.

**Shape.** The request is *text* if it names `max_output_tokens`, `max_tokens` or
`max_completion_tokens`; else *video* if it names `duration` or `duration_secs`; else *image* if
it names `num_images`, `width` or `resolution`, or carries a reference asset; else *text*.

**`units_out`** (unless `unitsOut` is given):

| Shape | `units_out` |
| --- | --- |
| Text | The first non-zero of `max_output_tokens`, `max_tokens`, `max_completion_tokens`; `4096` if none. |
| Image | Frame pixels × `num_images` (1 if absent). |
| Video | Frame pixels × duration seconds. |

**Frame pixels** come from explicit `width` × `height` (a missing one counts as 1024), else from
a `resolution` tier resolved against `aspect_ratio`, else 1024 × 1024.

- Tiers: `480p`, `720p`, `1080p`, `4k`. Aspect ratios: `21:9`, `16:9`, `4:3`, `1:1`, `3:4`,
  `9:16`, plus `auto` and `adaptive`. Any other value raises `ValidationError`.
- A tier is a pixel budget: at `16:9` it is 854×480, 1280×720, 1920×1080 or 3840×2160, and
  every other ratio is the frame of that shape with about the same area.
- `auto` (or no `aspect_ratio`) takes the ratio closest to the first image or clip reference, or
  `16:9` with no references. `adaptive` is priced at the tier's largest frame.

**Duration** is `duration_secs`, else `duration`: a number (truncated to whole seconds), a
digits-only string, or `"auto"` (priced as 15 s). Absent or not positive, it is 5 s. Anything
else raises `ValidationError`.

**`units_in`**:

- Text and embeddings: one unit per four bytes of the input's canonical JSON, at least 1.
- Image and video: the reference assets in pixel-seconds, `width × height × max(1,
  duration_secs)` summed over the assets (a still counts as one second), `0` with none.

## Reference assets

Reference keys are `image`, `end_image` and `video`, and the lists `reference_images`,
`reference_videos` and `reference_audios`. Each asset is an object:

| Member | Required | Meaning |
| --- | --- | --- |
| `b64` | yes | The bytes, base64. |
| `media_type` | yes | For example `"image/png"`, `"video/mp4"`. |
| `width`, `height` | images and clips | Positive integers, the asset's true size. |
| `duration_secs` | clips (`video`, `reference_videos`) | Positive integer seconds, rounded **up**. |

Limits, checked before anything is sealed or signed (`ValidationError`):

| Limit | Value |
| --- | --- |
| `reference_images` | at most 9 |
| `reference_videos` | at most 3 |
| `reference_audios` | at most 3, each at most 15 MiB; audio counts zero units |
| Pixel-bearing assets per request | at most 12 |
| Pixels per asset | at most 8 294 400 (3840 × 2160) |
| Clip length | at most 60 s |

Assets are priced from the dimensions you declare, without decoding. Providers check them
against the decoded bytes, so an asset larger or longer than declared can fail the job.

## Size

A sealed container up to 15 679 488 bytes travels inline in the job body. A larger one is
uploaded first with `client.uploadFile(…, "input", …)` and referenced by content id. There is no
client-side size cap; the coordinator's own limits apply.

## Low-level sealing

```ts
client.sealLine(args: SealLineArgs): Promise<SealedLine>
client.payLine(line: SealedLine, gasFee: bigint, ctx: ChainContext, feeBps: bigint): Promise<Record<string, unknown>>
```

The two halves `batches.submit` is built from, public for callers assembling a batch file by
hand. `sealLine` seals one payload and signs its order; `payLine` signs the payment for it
(`cap + floor(cap × feeBps / 10000) + gasFee`) and returns the flat JSONL row. Prefer `submit`
for a job and `batches.submit` for a file.
