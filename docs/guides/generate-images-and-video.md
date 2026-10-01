---
title: Generate images and video
description: Submit an image or video job, pass reference assets, and read the frames back.
---

Image and video jobs use the same `submit` / `result` flow as text. The difference is the input
object, which is the model's own, and the result type, `MediaResult`.

## Submit an image job

Pass the model's input object. The keys it names decide how the job is metered (see
[Units](../reference/submit.md#units)):

```ts
const handle = await client.submit({
  model: "black-forest-labs/flux-2-dev:fp8",
  input: { prompt: "a lighthouse in fog, oil painting", width: 1024, height: 768, seed: 42 },
  sla: "batch",
  rateOut: "0.02",       // USD per 1M output pixels
  provider: 7,
});
```

Output is priced per pixel: `width × height × num_images` (one image when `num_images` is
absent). Use `client.models.paramsSchema(model)` to see which params a model accepts.

## Submit a video job

A request that names `duration` or `duration_secs` is a video job, priced in pixel-seconds:

```ts
const handle = await client.submit({
  model: videoModel,
  input: { prompt: "a slow pan across the valley", resolution: "720p", aspect_ratio: "16:9", duration: 5 },
  sla: "batch",
  rateOut,
  provider,
});
```

- `resolution` is one of `480p`, `720p`, `1080p`, `4k`; `aspect_ratio` one of `21:9`, `16:9`,
  `4:3`, `1:1`, `3:4`, `9:16`, `auto` or `adaptive`. Explicit `width` / `height` win over a tier.
- `duration` is a whole number of seconds (a number, a digits-only string, or `"auto"`, priced as
  15 s). Absent, it is priced as 5 s.

## Pass reference assets

References (a start frame, an end frame, a source clip, style images) travel as **bytes inside
the sealed payload**, never as URLs. Each one states its media type and true dimensions:

```ts
// In Node: Buffer.from(bytes).toString("base64")
const toB64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const handle = await client.submit({
  model: videoModel,
  input: {
    prompt: "the lighthouse beam sweeps through the fog",
    image:     { b64: toB64(first), media_type: "image/png", width: 1280, height: 720 },
    end_image: { b64: toB64(last),  media_type: "image/png", width: 1280, height: 720 }, // optional
    resolution: "720p",
    duration: 5,
  },
  sla: "batch",
  rateIn,
  rateOut,
  provider,
});
```

- A clip (`video`, or an element of `reference_videos`) must also state `duration_secs`, rounded
  **up** to whole seconds.
- The input side is priced from the dimensions you declare, without decoding the assets.
  Providers check them against the real bytes, so declare them truthfully or the job may fail.
- Limits are checked before anything is signed; see
  [Reference assets](../reference/submit.md#reference-assets).

## Read the frames

```ts
import { MediaResult } from "@vorq-ai/client-sdk";

const result = await handle.result();
if (result instanceof MediaResult) {
  const [first] = result.bytes();                // decoded frames, no network call
  console.log(result.frames[0]?.content_type, first.byteLength, "bytes", "seed", result.seed);
}
```

An image job returns one frame per image; a video job returns one frame holding the clip. Each
frame carries `b64`, `content_type` and its dimensions. `bytes()` decodes them strictly and raises
`ResultIntegrityError` on a frame that is not valid base64.

In a browser, turn a frame into something displayable with
`URL.createObjectURL(new Blob([bytes], { type: frame.content_type }))`.
