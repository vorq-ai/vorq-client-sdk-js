/**
 * Canonicalization and unit-declaration: the encoding that feeds the
 * commitment preimage, and the accounting scalars an order declares.
 *
 * Kept in one file rather than duplicated wherever a container gets sealed —
 * `canonicalJson` produces the commitment preimage, so two copies that drift
 * would produce two different job ids for one input.
 */

import { toBase64 } from "./crypto/bytes.js";
import { ValidationError } from "./errors.js";
import { durationSecs, framePixels, referenceUnits, shape } from "./media.js";
import { MEDIA_UNITS } from "./media-units.js";
import { own } from "./own.js";

/**
 * The two defaults every party sizes an order by, read from the shared media
 * table rather than written here.
 *
 * The provider prices the same order from the same numbers, so a copy that
 * drifted would have this SDK sign units the daemon charges differently — the
 * failure the last round found with a threshold spelled out in four repos, where
 * editing one left every suite green. `make media-check` is the gate.
 */
const DEFAULT_UNITS_OUT = MEDIA_UNITS.defaults.units_out;
const DEFAULT_DIM = MEDIA_UNITS.defaults.dim;

/** The three spellings of an output-token ceiling this SDK reads, in order. */
const OUTPUT_CEILING_KEYS = MEDIA_UNITS.outputCeilingKeys;

/**
 * Order keys the way Python's `sorted()` orders them: by **code point**.
 *
 * The distinction is not decorative. JavaScript's default string comparison —
 * and `JSON.stringify`'s own key order, which is why this module never relies on
 * it — is by UTF-16 **code unit**, and the two disagree for an astral key beside
 * one in `U+E000‥U+FFFF`: Python puts `"�"` before `"😀"`, code-unit order
 * puts the emoji first (its lead surrogate is `0xD83D`). For every other key
 * they are identical. Since these bytes are the commitment preimage, the two
 * SDKs must agree on all of them, so this follows the authority exactly.
 */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Canonical JSON — the encoding of everything that gets sealed, byte for byte
 * Python's `json.dumps(..., sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for every value a JSON round-trip preserves.
 *
 * **Floats are the exception, and deliberately not one this fixes.** The two
 * languages format them differently — Python writes `1.0` and `1e+16` where
 * JavaScript writes `1` and `10000000000000000` — and no reasonable amount of
 * code closes that gap. It is harmless here because the commitment is taken over
 * the container bytes and is never re-derived from a re-parsed plaintext: each
 * SDK commits to what it itself emitted, and the provider that opens the box
 * reads a number either way.
 *
 * Written out rather than delegated to `JSON.stringify` with a replacer,
 * because `JSON.stringify` does not sort keys and cannot be made to: an object
 * rebuilt in sorted order still emits integer-like keys (`"9"`, `"10"`) first
 * and in numeric order, which is a different sequence from Python's string sort.
 * The separators and the non-ASCII pass-through are the other two halves of the
 * same contract — a mismatch in any of them changes the commitment, changes the
 * job id, and produces two different jobs for one input.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    // `undefined` is `null` inside an array and absent inside an object, which
    // is `JSON.stringify`'s own rule; nothing here invents a third one.
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort(byCodePoint)) {
      const member = record[key];
      if (member === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${parts.join(",")}}`;
  }
  // A function or a symbol: `JSON.stringify` drops these, and a payload holding
  // one is a caller mistake worth naming rather than silently truncating.
  throw new ValidationError(`a ${typeof value} cannot be sealed into a job's payload`, {
    type: "invalid_request_error",
  });
}

/** Canonical JSON as UTF-8 bytes. */
function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** A count that is at least one — the `x or 1` Python spells inline. */
function countOrOne(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 1));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : 1;
}

/**
 * The client-declared accounting scalars: how much work this order buys.
 *
 * `unitsOut` is the out dimension and an exact integer — an output-token ceiling
 * for text, output pixels (`num_images × width × height`) for an image, and
 * pixel-seconds (`width × height × duration_secs`) for video. Metering media in
 * raw pixels prices a per-image, a per-megapixel and a per-second backend alike,
 * so a bigger image honestly costs more.
 *
 * `unitsIn` is the quantity of input bought, and what that means depends on the
 * **same shape**. Text and embeddings are metered on the prompt, one unit per
 * four bytes of canonical JSON — a proxy, and a coarse one. Image and video are
 * metered on the *reference*: total pixel-seconds across the assets the request
 * carries, and zero when it carries none. A prompt's length buys nothing on a
 * media job, and counting it would price a job by how well its reference
 * happened to compress.
 *
 * One decision drives both numbers (`shape` in `media.ts`). Deriving them
 * separately is how a request ends up priced as text on the output leg and as
 * pixels on the input leg, which is a bill no party agrees on.
 *
 * **An explicit `unitsOut` beats every heuristic below, zero included.** Nothing
 * this SDK can read tells an input-metered model from a text one — `GET
 * /v1/models` serves no modality — so a job with no output side to buy (an
 * embedding, priced on prompt tokens and settling at `completionTok == 0`)
 * states `unitsOut: 0` itself. Zero has to survive as zero rather than fall
 * through to the 4096 default, or the client escrows an output leg the job can
 * never spend. It does **not** change the input side, which is the request's
 * shape either way.
 */
function declareUnits(
  input: Record<string, unknown>,
  unitsOut?: number | null,
): { unitsIn: number; unitsOut: number } {
  if (unitsOut !== undefined && unitsOut !== null) {
    // `typeof` first, so a boolean is refused rather than coerced: `true` is a
    // perfectly good `1` to `Number()`, and an order is not the place to guess.
    if (typeof unitsOut !== "number" || !Number.isInteger(unitsOut) || unitsOut < 0) {
      throw new ValidationError("units_out must be a non-negative integer", {
        type: "invalid_request_error",
      });
    }
  }

  const kind = shape(input);
  const unitsIn =
    kind === "text"
      ? Math.max(1, Math.floor(canonicalBytes(input).length / 4))
      : referenceUnits(input);
  if (unitsOut !== undefined && unitsOut !== null) return { unitsIn, unitsOut };

  let declared: number;
  // Every read of `input` below is own-properties only — `Object.hasOwn`, never
  // a bare `in` or a bare index (see `own.ts`). `input` is the caller's object
  // and `canonicalJson` walks `Object.keys`, so a ceiling the caller merely
  // inherits is never sealed: declaring `units_out` from one would escrow an
  // output leg against a payload that does not ask for it.
  if (kind === "video") {
    declared = framePixels(input) * durationSecs(input); // pixel-seconds
  } else if (kind === "image") {
    declared = framePixels(input) * countOrOne(own(input, "num_images")); // pixels
  } else {
    declared =
      OUTPUT_CEILING_KEYS.map((key) => Math.trunc(Number(own(input, key) ?? 0)))
        // `!== 0`, not `> 0`: this reproduces the falsy set of Python's
        // `a or b or c or 4096` exactly — `0`, `false`, `""` and a missing key
        // all fall through, and a **negative** does not. A `-5` ceiling reaches
        // `OrderTerms` and is refused there as a `uint32`, which is what the
        // authority does; substituting 4096 for it would have this SDK sign an
        // order for input the other one rejects.
        .find((value) => Number.isFinite(value) && value !== 0) ?? DEFAULT_UNITS_OUT;
  }
  return { unitsIn, unitsOut: declared };
}

export { declareUnits, toBase64, canonicalBytes };
