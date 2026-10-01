/**
 * Reference-conditioned media: what a request is asking for, in billable units.
 *
 * A media request names its shape the way the rest of the industry names it — a
 * resolution tier and a whole number of seconds — while the chain bills in
 * pixels. This module is the translation, and it is shared rather than invented
 * here: every number comes out of `media-units-v1.json`, which the Python client
 * and the provider daemon read from their own copies of the same file. The
 * client signs the units; the provider prices the work against them; a
 * disagreement is a provider paid for something it did not do.
 *
 * **Reference assets ride as bytes, never as a URL.** The whole input is sealed
 * into a container only the claiming provider can open, so a link would hand the
 * reference to anyone who fetched the job and defeat the point. Base64 in the
 * input needs no new transport either: the container inlines under
 * `INLINE_MAX_BYTES` and uploads by cid above it, machinery that already exists.
 *
 * **A reference declares its own dimensions and this SDK believes it.** That is
 * deliberate — it keeps an image decoder out of both clients, and out of the
 * parity surface between them, which would be far harder to keep honest than a
 * table of twelve frame sizes. The declaration is a *claim*: the provider decodes
 * the reference after decrypting it and refuses a job whose reference is larger
 * than the units paid for it.
 *
 * Every read of the caller's object goes through `own()` — see `own.ts`. The
 * input is the caller's and `canonicalJson` seals own properties only, so a
 * `width` merely inherited would size an order for pixels the sealed payload
 * never asks for.
 */

import { ValidationError } from "./errors.js";
import { MEDIA_UNITS } from "./media-units.js";
import { own } from "./own.js";

// Every one of these comes out of the shared table, none of them is written
// here. The Python client reads the same names from its own copy of the same
// file, so a convention that changes changes in one place — which is the whole
// reason the table exists.
const {
  defaults,
  caps,
  frames,
  autoOrder,
  resolutions,
  autoFallback: AUTO_FALLBACK,
  adaptiveAspect: ADAPTIVE_ASPECT,
  autoDuration: AUTO_DURATION,
  referenceKeys: REFERENCE_KEYS,
  referenceListKeys: REFERENCE_LIST_KEYS,
  clipKeys: CLIP_KEYS,
  audioKeys: AUDIO_KEYS,
  outputCeilingKeys: OUTPUT_CEILING_KEYS,
} = MEDIA_UNITS;

type Aspect = keyof typeof frames;
type Adaptive = typeof ADAPTIVE_ASPECT;
type Tier = (typeof resolutions)[number];

function invalid(message: string): ValidationError {
  return new ValidationError(message, { type: "invalid_request_error" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Kind = "still" | "clip" | "audio";

function kindOf(key: string): Kind {
  if ((CLIP_KEYS as readonly string[]).includes(key)) return "clip";
  return (AUDIO_KEYS as readonly string[]).includes(key) ? "audio" : "still";
}

/**
 * Every reference this request carries, as `[label, kind, asset]` in the order
 * they are counted: the singular keys, then each list key's elements.
 *
 * `kind` comes from the *key*, never from the asset's own `media_type` — the key
 * is what the caller meant, and the type is a claim the provider checks.
 *
 * A singular key holding anything other than an object is not a reference and is
 * left alone: this SDK forwards a payload verbatim, and a model that happens to
 * take an `image` string for some other purpose must not have its request refused
 * by an accounting helper. A list key holding anything other than a list is left
 * alone for the same reason; its elements are not, because a list of references
 * with a non-reference in it is a mistake and not another protocol.
 */
export function assets(input: Record<string, unknown>): [string, Kind, unknown][] {
  const found: [string, Kind, unknown][] = [];
  for (const key of REFERENCE_KEYS) {
    const value = own(input, key);
    if (isRecord(value)) found.push([key, kindOf(key), value]);
  }
  for (const key of Object.keys(REFERENCE_LIST_KEYS)) {
    const held = own(input, key);
    if (!Array.isArray(held)) continue;
    // By index and own-only, like every other read here: a hole states nothing,
    // and an index the array merely inherits must not stand in for a reference.
    const elements = held as unknown as Record<string, unknown>;
    for (let i = 0; i < held.length; i += 1) {
      found.push([`${key}[${i}]`, kindOf(key), own(elements, String(i))]);
    }
  }
  return found;
}

/** The pixel-bearing references, in counting order — what `auto` measures. */
export function references(input: Record<string, unknown>): Record<string, unknown>[] {
  return assets(input)
    .filter(([, kind, asset]) => kind !== "audio" && isRecord(asset))
    .map(([, , asset]) => asset as Record<string, unknown>);
}

function refDimension(asset: Record<string, unknown>, field: string, key: string): number {
  const value = own(asset, field);
  // `typeof` first, so a boolean is refused rather than coerced: `true` is a
  // perfectly good `1` to `Number()`, and an order is not the place to guess what
  // a caller meant by a flag where a width belongs.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(
      `${key}.${field} must be a positive integer — a reference states its own ` +
        `dimensions, and they are what the input side of the order is priced on`,
    );
  }
  return value;
}

/**
 * `unitsIn` for a reference-conditioned request: total reference pixel-seconds.
 *
 * A still frame counts as its pixels for one second, so `rateIn` prices one input
 * pixel-second whether the reference moves or not, and a start frame plus an end
 * frame is simply the sum. Sound has no pixels and counts zero. A request
 * carrying no reference declares `0` — there is no input quantity to buy, and
 * the chain takes zero.
 *
 * The caps are applied here, before anything is sealed or signed. They are not
 * politeness: `unitsIn` is a `uint32` and a few kilobytes of flat-colour PNG can
 * *claim* a hundred thousand pixels a side, so without them an honest-looking
 * request could overflow the field the order is signed over.
 */
export function referenceUnits(input: Record<string, unknown>): number {
  for (const [key, most] of Object.entries(REFERENCE_LIST_KEYS)) {
    const held = own(input, key);
    if (Array.isArray(held) && held.length > most) {
      throw invalid(`${key} holds at most ${most} references, and this one holds ${held.length}`);
    }
  }
  const found = assets(input);
  const pixelBearing = found.filter(([, kind]) => kind !== "audio").length;
  if (pixelBearing > caps.reference_assets) {
    throw invalid(
      `a request carries at most ${caps.reference_assets} reference assets ` +
        `(reference_assets), and this one carries ${pixelBearing}`,
    );
  }

  let total = 0;
  for (const [key, kind, asset] of found) {
    if (!isRecord(asset)) throw invalid(`${key} must be a reference object`);

    const bytes = own(asset, "b64");
    if (typeof bytes !== "string" || bytes.length === 0) {
      throw invalid(`${key}.b64 must carry the reference's bytes, base64-encoded`);
    }
    const mediaType = own(asset, "media_type");
    if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
      throw invalid(`${key}.media_type must name the reference's media type`);
    }
    if (kind === "audio") {
      if (Math.floor((bytes.length * 3) / 4) > caps.reference_audio_bytes) {
        throw invalid(
          `${key} is larger than the ${caps.reference_audio_bytes} bytes a ` +
            `reference sound may be (reference_audio_bytes)`,
        );
      }
      continue;
    }

    const pixels = refDimension(asset, "width", key) * refDimension(asset, "height", key);
    if (pixels > caps.reference_pixels) {
      throw invalid(
        `${key} declares ${pixels} pixels; the most a reference may carry is ` +
          `${caps.reference_pixels} (reference_pixels)`,
      );
    }

    const declared = own(asset, "duration_secs");
    let seconds: number;
    if (declared === undefined || declared === null) {
      if (kind === "clip") {
        throw invalid(
          `${key}.duration_secs must say how long the reference clip runs, in whole ` +
            "seconds rounded up — the provider reads the clip's real length and hands " +
            "back a job whose clip outruns it",
        );
      }
      seconds = 1; // a still is one pixel-second per pixel
    } else if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1) {
      throw invalid(`${key}.duration_secs must be a positive integer of seconds`);
    } else if (declared > caps.reference_duration_s) {
      throw invalid(
        `${key} declares ${declared} seconds; the longest reference clip is ` +
          `${caps.reference_duration_s} (reference_duration_s)`,
      );
    } else {
      seconds = declared;
    }
    total += pixels * seconds;
  }
  return total;
}

/**
 * Which row of the frame table this request is shaped by.
 *
 * An explicit ratio is taken as written and checked against the table — a
 * spelling the table does not name is refused rather than silently defaulted,
 * because defaulting would quote pixels the caller never asked for.
 *
 * `auto`, and an absent ratio, are resolved from the **first reference's declared
 * dimensions**, the one measurement both the client and the provider hold. The
 * comparison is between logarithms of the ratios, which is what makes it
 * scale-symmetric: 1280×720 and 3840×2160 are one shape and must choose one row,
 * and an absolute comparison would let the larger reference sit further from 16:9
 * than a square one sits from 1:1.
 */
export function resolveAspectRatio(
  declared: unknown,
  assets: Record<string, unknown>[],
): Aspect | Adaptive {
  if (declared === ADAPTIVE_ASPECT) return ADAPTIVE_ASPECT;
  if (declared !== undefined && declared !== null && declared !== "auto") {
    if (typeof declared !== "string" || !Object.hasOwn(frames, declared)) {
      throw invalid(
        `aspect_ratio ${JSON.stringify(declared)} is not one this network prices; ` +
          `it is one of ${autoOrder.join(", ")}, 'auto' or '${ADAPTIVE_ASPECT}'`,
      );
    }
    return declared as Aspect;
  }
  if (assets.length === 0) return AUTO_FALLBACK as Aspect;

  const first = assets[0]!;
  const target = Math.log(
    refDimension(first, "width", "reference") / refDimension(first, "height", "reference"),
  );
  let best = autoOrder[0] as Aspect;
  let bestDistance = Infinity;
  // Strict `<` walking `autoOrder` in order is the tie-break: the earlier entry
  // wins, from the table's own ordering rather than from a sort's stability.
  for (const aspect of autoOrder) {
    const [w, h] = frames[aspect as Aspect]["1080p"];
    const distance = Math.abs(target - Math.log(w / h));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = aspect as Aspect;
    }
  }
  return best;
}

/**
 * The pixels in one output frame.
 *
 * Explicit `width`/`height` win over a tier, always: a caller who named pixels
 * gets those pixels, and `resolution` is a convenience rather than an override.
 * Each dimension falls back independently, which is the behaviour the first media
 * jobs shipped with and which their numbers still depend on.
 */
export function framePixels(input: Record<string, unknown>): number {
  const width = own(input, "width");
  const height = own(input, "height");
  if (width !== undefined || height !== undefined) {
    return dimension(width) * dimension(height);
  }
  const tier = own(input, "resolution");
  if (tier !== undefined && tier !== null) {
    if (typeof tier !== "string" || !(resolutions as readonly string[]).includes(tier)) {
      throw invalid(
        `resolution ${JSON.stringify(tier)} is not one this network prices; ` +
          `it is one of ${resolutions.join(", ")}`,
      );
    }
    const aspect = resolveAspectRatio(own(input, "aspect_ratio"), references(input));
    if (aspect === ADAPTIVE_ASPECT) {
      // The model keeps the reference's own shape, which no row names. The
      // tier's largest frame is the cap; the delivered clip settles under it.
      return Math.max(
        ...Object.values(frames).map((row) => row[tier as Tier][0] * row[tier as Tier][1]),
      );
    }
    const [w, h] = frames[aspect][tier as Tier];
    return w * h;
  }
  return defaults.dim * defaults.dim;
}

/** One frame dimension, defaulting on absent, zero and unreadable alike. */
function dimension(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? defaults.dim));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : defaults.dim;
}

/**
 * How many seconds of output this request buys.
 *
 * `duration_secs` is the canonical spelling and wins; `duration` is the one the
 * prevailing interface uses and is accepted as a whole number or its decimal
 * string, because that interface serializes it both ways and `5` and `"5"` are
 * the same request.
 */
export function durationSecs(input: Record<string, unknown>): number {
  // `??`, so a null `duration_secs` is an absent one, as everywhere else.
  const raw = own(input, "duration_secs") ?? own(input, "duration");
  if (raw === undefined || raw === null || raw === "") return defaults.duration_secs;
  // The model chooses the length; the order signs the most it may choose.
  if (raw === AUTO_DURATION) return defaults.auto_duration_secs;
  // Narrower than `Number()` on purpose. `Number()` reads "7.5", "1e1", "0x10" and
  // " 5 "; the other client's parser reads "+5" and "1_0" instead. The provider
  // re-derives this number, so a spelling two parsers disagree about is escrow for
  // seconds nobody will render.
  let seconds: number;
  if (typeof raw === "string" && WHOLE_SECONDS.test(raw)) {
    seconds = Number(raw);
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    seconds = Math.trunc(raw);
  } else {
    throw invalid(`duration ${JSON.stringify(raw)} must be a whole number of seconds`);
  }
  return seconds > 0 ? seconds : defaults.duration_secs;
}

/** A duration written as a string: ASCII digits and nothing else. */
const WHOLE_SECONDS = /^[0-9]{1,9}$/;

/**
 * `"text"`, `"image"` or `"video"` — **one** decision, driving both units.
 *
 * Deriving the two sides separately is how a request ends up priced as text on
 * the output leg and as pixels on the input leg, which is a bill no party agrees
 * on. So the shape is decided once, here, and both scalars follow from it.
 *
 * An output-token ceiling wins outright: a request naming one is token-metered
 * whatever else it carries. Then a duration makes it video, and pixels, a tier or
 * a reference make it an image. Nothing else is media.
 *
 * `height` is deliberately not in that list. It sizes a frame once a request is
 * already media, but on its own it decides nothing — and reading it here would
 * make a payload whose `width` is merely inherited from a prototype take the
 * image branch off its own `height`, which is exactly what
 * `test/prototype-reads.test.ts` exists to refuse.
 *
 * This is a guess, and it has to be: `GET /v1/models` serves no modality, so the
 * request's own shape is the only signal a client has about what it is ordering.
 * Asking for a clip therefore means saying how long it is.
 */
export function shape(input: Record<string, unknown>): "text" | "image" | "video" {
  if (OUTPUT_CEILING_KEYS.some((key) => Object.hasOwn(input, key))) return "text";
  if (Object.hasOwn(input, "duration") || Object.hasOwn(input, "duration_secs")) return "video";
  if (
    ["num_images", "width", "resolution"].some((key) => Object.hasOwn(input, key)) ||
    assets(input).length > 0
  ) {
    return "image";
  }
  return "text";
}
