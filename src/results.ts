/**
 * Result types delivered on every path.
 *
 * `handle.result()` normalizes to `TextResult` / `MediaResult` /
 * `EmbeddingResult` values. The API states terms and counts, never totals —
 * `.cost` is computed here, in USD, from the signed rates and the job's unit
 * counts: `units × rate / 1M`, exactly.
 */

import { fromBase64Strict } from "./crypto/bytes.js";
import { SEALED_RESULT_VERSION } from "./crypto/domains.js";
import { ResultIntegrityError, VorqError } from "./errors.js";
import { own } from "./own.js";
import { isUsd, parseUsd } from "./money.js";
import type { Cipher } from "./signer/types.js";

/** The two signed rates a job settles under: USD per 1M units of work, as decimal strings. */
export interface Rates {
  rateIn: string | null;
  rateOut: string | null;
}

/** Rates are USD per 10^6 units of work, so every cost unscales by this power of ten. */
const RATE_SCALE_POW10 = 6;

/** A rate as `mantissa / 10**scale`, exactly; an absent rate is zero. */
function rateFixed(rate: string | null): { mantissa: bigint; scale: number } {
  if (rate === null) return { mantissa: 0n, scale: 0 };
  const scale = rate.split(".")[1]?.length ?? 0;
  return { mantissa: parseUsd(rate, scale), scale };
}

/** `Σ units × rate / 1M` in USD, exact, formatted by `formatCost`. */
function usdCost(...legs: [bigint, string | null][]): string {
  const fixed = legs.map(([units, rate]) => ({ units, ...rateFixed(rate) }));
  const scale = Math.max(0, ...fixed.map((leg) => leg.scale));
  const mantissa = fixed.reduce(
    (sum, leg) => sum + leg.units * leg.mantissa * 10n ** BigInt(scale - leg.scale),
    0n,
  );
  return formatCost(mantissa, scale + RATE_SCALE_POW10);
}

/**
 * Render `mantissa / 10**scale` as a plain decimal string, never scientific
 * notation, with trailing fractional zeros stripped. Every division here is by
 * a power of ten and therefore exact, so rounding never enters.
 */
export function formatCost(mantissa: bigint, scale: number): string {
  let m = mantissa;
  let s = scale;
  const negative = m < 0n;
  if (negative) m = -m;
  while (s > 0 && m % 10n === 0n) {
    m /= 10n;
    s -= 1;
  }
  let text: string;
  if (s <= 0) {
    text = (m * 10n ** BigInt(-s)).toString();
  } else {
    const digits = m.toString().padStart(s + 1, "0");
    text = `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * A unit count off an untrusted body: whole, finite, and never a throw.
 *
 * `BigInt()` rejects any non-integer or non-finite double with a bare
 * `RangeError`, and a sealed result body is exactly the input that might carry
 * `"input_tokens": 1.5` or a width that overflowed to `Infinity`. That
 * `RangeError` is not a `VorqError` and would walk straight through the one
 * `catch` this module's own comments promise over the read path. A count is a
 * count, so it truncates — the same thing `dimension` already does — rather
 * than costing the caller an otherwise readable result.
 */
function unitCount(value: unknown, fallback: number): bigint {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : BigInt(fallback);
}

/**
 * Own properties only, like everything else that reads a usage block.
 *
 * **A spread is not a defence, which is what the comment here used to claim.**
 * `{ ...record }` copies own enumerable properties into an object literal whose
 * prototype is still `Object.prototype`, so a key absent from the copy is still
 * answered by a polluted prototype. `textResultFromResponse` passes exactly such
 * a copy, on the public `JobHandle.result()` path, and a bare read here let
 * `Object.prototype.input_tokens` choose the displayed cost of somebody's job.
 *
 * Guarding inside this function rather than at the two call sites is what
 * retires the exception: neither caller has to be the kind of object this one
 * happens to tolerate.
 */
function textCost(usage: Record<string, unknown>, rates: Rates): string {
  const inTok = unitCount(own(usage, "input_tokens"), 0);
  const outTok = unitCount(own(usage, "output_tokens"), 0);
  return usdCost([inTok, rates.rateIn], [outTok, rates.rateOut]);
}

/**
 * Output pixels (or pixel-seconds) against the signed rate, **divided by
 * RATE_SCALE like every other modality** — `JobRegistry._atomicCharge` has one
 * code path and no media exception: a rate is USD per 1M units of work whatever
 * is being metered. Omitting this divisor displays a figure a million times the
 * charge.
 */
function mediaCost(units: bigint, rates: Rates): string {
  return usdCost([units, rates.rateOut]);
}

/**
 * Input side only, and `rate_out` is deliberately not read: an embeddings
 * backend reports `prompt_tokens` and no completion count, so the job settles at
 * `completionTok == 0` and the chain's charge is `rate_in * units_in`. An
 * input-only ask may still publish a nonzero `rate_out` — it is inert,
 * multiplied by zero units — and reading it here would display a charge nobody
 * was ever billed.
 */
function embeddingCost(usage: Record<string, unknown>, rates: Rates): string {
  return usdCost([unitCount(own(usage, "prompt_tokens"), 0), rates.rateIn]);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A settled text job: a Responses object or a `chat.completion`, opened. */
export class TextResult {
  readonly text: string;
  readonly output: unknown[];
  readonly usage: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
  readonly rates: Rates;
  readonly cost: string;
  /**
   * The flat relay gas fee this job's claim took, in USD, from the row's
   * `vorq.gas_fee`. Kept by the network however the job ended; not in `cost`.
   */
  readonly gasFee: string;
  /**
   * The protocol fee settlement took on top of `cost`, in USD, from the row's
   * `vorq.fee`. `"0"` for a job that did not settle.
   */
  readonly fee: string;
  readonly provider: number | string | null;
  readonly jobId: string | null;
  /**
   * The caller's own label for this line, echoed back by the provider from
   * inside the sealed payload. `null` when the submission named none.
   */
  readonly customId: string | null;

  constructor(fields: {
    text: string;
    output: unknown[];
    usage: Record<string, unknown>;
    raw: Record<string, unknown>;
    rates: Rates;
    cost: string;
    gasFee: string;
    fee: string;
    provider: number | string | null;
    jobId: string | null;
    customId: string | null;
  }) {
    this.text = fields.text;
    this.output = fields.output;
    this.usage = fields.usage;
    this.raw = fields.raw;
    this.rates = fields.rates;
    this.cost = fields.cost;
    this.gasFee = fields.gasFee;
    this.fee = fields.fee;
    this.provider = fields.provider;
    this.jobId = fields.jobId;
    this.customId = fields.customId;
  }
}

/** A settled image or video job: the delivered frames, opened. */
export class MediaResult {
  readonly frames: Record<string, unknown>[];
  readonly seed: number | null;
  readonly raw: Record<string, unknown>;
  readonly rates: Rates;
  readonly cost: string;
  /**
   * The flat relay gas fee this job's claim took, in USD, from the row's
   * `vorq.gas_fee`. Kept by the network however the job ended; not in `cost`.
   */
  readonly gasFee: string;
  /**
   * The protocol fee settlement took on top of `cost`, in USD, from the row's
   * `vorq.fee`. `"0"` for a job that did not settle.
   */
  readonly fee: string;
  readonly provider: number | string | null;
  readonly jobId: string | null;
  readonly customId: string | null;

  constructor(fields: {
    frames: Record<string, unknown>[];
    seed: number | null;
    raw: Record<string, unknown>;
    rates: Rates;
    cost: string;
    gasFee: string;
    fee: string;
    provider: number | string | null;
    jobId: string | null;
    customId: string | null;
  }) {
    this.frames = fields.frames;
    this.seed = fields.seed;
    this.raw = fields.raw;
    this.rates = fields.rates;
    this.cost = fields.cost;
    this.gasFee = fields.gasFee;
    this.fee = fields.fee;
    this.provider = fields.provider;
    this.jobId = fields.jobId;
    this.customId = fields.customId;
  }

  /**
   * The frames, decoded, in order.
   *
   * They travelled inside the sealed result, so this reaches no network: the
   * result was fetched and opened once, by its CID, before this object existed.
   *
   * The decode is **strict**, and that is the whole point of the method. A
   * lenient decoder skips characters outside the base64 alphabet and returns
   * what is left, so `"###"` decodes to zero bytes — a provider could declare
   * 1024x768, seal garbage, and hand back a frame that read as a perfectly good
   * zero-byte image. Nothing else on the read path would have said a word.
   *
   * A frame with no `b64` member is the same failure arriving as a missing
   * property, which would walk straight through the one `catch` a caller holds
   * over this path. Both raise `ResultIntegrityError`, because both mean what
   * every other unreadable result means: this job has no answer to hand back.
   */
  bytes(): Uint8Array[] {
    return this.frames.map((frame, i) => {
      // **Own properties only** (`own.ts`). A frame is `JSON.parse` output over
      // bytes a provider produced, and this read *is* the bytes this method
      // returns. Read bare, the refusal below is answered by the same prototype
      // that supplies the value, so a frame carrying no `b64` at all decodes to
      // whatever `Object.prototype.b64` holds and is handed back as this job's
      // image — the strictness the rest of this method spends its comment on,
      // defeated one line above where it is applied.
      const encoded = own(frame, "b64");
      if (typeof encoded !== "string") {
        throw new ResultIntegrityError(
          `frame ${i} of job ${JSON.stringify(this.jobId)} carries no base64 'b64' member, ` +
            `so there are no bytes to decode; the frame's keys are ${JSON.stringify(
              Object.keys(frame).sort(),
            )}`,
        );
      }
      const decoded = fromBase64Strict(encoded);
      if (decoded === null) {
        throw new ResultIntegrityError(
          `frame ${i} of job ${JSON.stringify(this.jobId)} is not base64, so the bytes ` +
            "stored under this job's result_cid are not a frame",
        );
      }
      return decoded;
    });
  }
}

/**
 * A settled embeddings job: the `EmbeddingResponse`, opened.
 *
 * The provider seals that response verbatim, so `raw` is byte-for-byte what an
 * embeddings call would have returned and `embeddings` is its `data` array
 * unchanged.
 */
export class EmbeddingResult {
  readonly embeddings: Record<string, unknown>[];
  readonly model: string | null;
  readonly promptTokens: number;
  readonly raw: Record<string, unknown>;
  readonly rates: Rates;
  readonly cost: string;
  /**
   * The flat relay gas fee this job's claim took, in USD, from the row's
   * `vorq.gas_fee`. Kept by the network however the job ended; not in `cost`.
   */
  readonly gasFee: string;
  /**
   * The protocol fee settlement took on top of `cost`, in USD, from the row's
   * `vorq.fee`. `"0"` for a job that did not settle.
   */
  readonly fee: string;
  readonly provider: number | string | null;
  readonly jobId: string | null;
  readonly customId: string | null;

  constructor(fields: {
    embeddings: Record<string, unknown>[];
    model: string | null;
    promptTokens: number;
    raw: Record<string, unknown>;
    rates: Rates;
    cost: string;
    gasFee: string;
    fee: string;
    provider: number | string | null;
    jobId: string | null;
    customId: string | null;
  }) {
    this.embeddings = fields.embeddings;
    this.model = fields.model;
    this.promptTokens = fields.promptTokens;
    this.raw = fields.raw;
    this.rates = fields.rates;
    this.cost = fields.cost;
    this.gasFee = fields.gasFee;
    this.fee = fields.fee;
    this.provider = fields.provider;
    this.jobId = fields.jobId;
    this.customId = fields.customId;
  }

  /**
   * The vectors, decoded, in order.
   *
   * Assumes `encoding_format: "base64"` — the default this SDK's jobs request,
   * because a float32 vector is roughly a quarter the size that way. A response
   * taken in `float` format carries lists of numbers instead; read `.embeddings`
   * directly for those.
   *
   * The decode is the same strict one the frames use. A vector from a standard
   * encoder decodes identically either way, so the only thing strictness costs
   * is a silently short vector.
   */
  bytes(): Uint8Array[] {
    return this.embeddings.map((entry) => {
      // Own properties only, for the reason `MediaResult.bytes` states above:
      // this read is the vector bytes this method returns, and a polluted
      // `Object.prototype.embedding` answers the `encoding_format='float'`
      // refusal below with a base64 string the provider never sent.
      const vector = own(entry, "embedding");
      if (typeof vector !== "string") {
        throw new VorqError(
          "this result's vectors are not base64: the request asked for " +
            "encoding_format='float'. Read .embeddings directly.",
          { type: "result_integrity" },
        );
      }
      const decoded = fromBase64Strict(vector);
      if (decoded === null) {
        throw new ResultIntegrityError(
          "this result's vectors are not base64, so the bytes stored under this " +
            "job's result_cid are not embeddings",
        );
      }
      return decoded;
    });
  }
}

/**
 * One line of a batch that never delivered.
 *
 * `type` is the cause in the one canonical vocabulary every VORQ surface uses —
 * `provider_fail`, `reclaim`, `cancelled`, `expired` for a line that became a
 * job, or the coordinator's own refusal code (`invalid_json`,
 * `invalid_order_signature`, `DuplicateJob`, …) for one that never did. A client
 * cancel and an order nobody claimed before its deadline are different facts,
 * and this keeps them different.
 *
 * `customId` is `null` here and that is structural rather than missing: the
 * label rides sealed inside the container, and an error row has no sealed result
 * to read it back out of. Correlate on `jobId` — the content job id, listed in
 * input order on `BatchHandle.jobIds`.
 */
export class JobError {
  readonly message: string;
  readonly type: string;
  readonly jobId: string | null;
  readonly customId: string | null;
  readonly raw: Record<string, unknown>;

  constructor(fields: {
    message: string;
    type: string;
    jobId: string | null;
    customId: string | null;
    raw?: Record<string, unknown>;
  }) {
    this.message = fields.message;
    this.type = fields.type;
    this.jobId = fields.jobId;
    this.customId = fields.customId;
    this.raw = fields.raw ?? {};
  }
}

// ---------------------------------------------------------------------------
// Reading an opened body
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * `null` for a rate the job did not carry — the cost paths read that as zero. A
 * rate that is present but not a USD decimal string is refused: a cost computed
 * from it would be a figure nobody signed.
 */
function asRate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isUsd(value)) {
    throw new VorqError(`the node sent ${field}=${JSON.stringify(value)}, which is not a USD rate`, {
      type: "api_error",
    });
  }
  return value;
}

/**
 * One dimension of a frame, defaulting to 1024 to match the coordinator and the
 * provider so the displayed cost tracks the per-pixel rate.
 */
function dimension(value: unknown): bigint {
  // `|| 1024` so an explicit `0` falls back too, matching Python's `or 1024`.
  return unitCount(Number(value ?? 1024) || 1024, 1024);
}

/**
 * A produced frame's pixels (width × height).
 *
 * Own properties only (see `own.ts`): every record this file reads came out of
 * `JSON.parse` over bytes a provider produced, and a polluted `Object.prototype`
 * would otherwise size a frame nobody delivered.
 */
const framePixels = (frame: Record<string, unknown>): bigint =>
  dimension(own(frame, "width")) * dimension(own(frame, "height"));

/** Flatten Responses output items into their text. */
function flattenResponseOutput(outputItems: unknown[]): string {
  const parts: string[] = [];
  for (const item of outputItems) {
    for (const part of asArray(own(asRecord(item), "content"))) {
      const record = asRecord(part);
      // Own properties only — see `own.ts`. `type` and `text` are not names
      // `Object.prototype` supplies, but a polluted realm can add them, and a
      // text part assembled from the prototype is text the model never wrote.
      const type = own(record, "type");
      const text = own(record, "text");
      if ((type === "output_text" || type === "text") && typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

/**
 * An embeddings response, told apart by its own `object` discriminator.
 *
 * A Responses object is `"response"` and a chat completion is
 * `"chat.completion"`, so `"list"` is unambiguous here; the per-entry check
 * keeps some other future list shape from being read as vectors.
 */
function isEmbedding(output: Record<string, unknown>): boolean {
  if (own(output, "object") !== "list") return false;
  const data = own(output, "data");
  return (
    Array.isArray(data) && data.every((entry) => isRecord(entry) && Object.hasOwn(entry, "embedding"))
  );
}

/**
 * Own properties only, and this dispatch is why the rule reaches this file.
 *
 * These three membership tests choose which result class an opened body becomes.
 * Read with a bare `in`, a polluted `Object.prototype.images` turns every text
 * completion into a `MediaResult`, and a polluted `Object.prototype.choices`
 * routes a Responses body through the chat parser — so `result.text` returns
 * whatever the prototype carries instead of the model's own output. That is
 * attacker-chosen content standing in for a confidential inference result, and
 * `JobHandle.result()` is a public path to it (`jobs.ts` → `resultFromRaw`).
 */
const isMedia = (output: Record<string, unknown>): boolean =>
  Object.hasOwn(output, "images") || Object.hasOwn(output, "video");

/** What every result carries beyond its own body. */
interface Terms {
  rates: Rates;
  gasFee: string;
  fee: string;
  provider: number | string | null;
  jobId: string | null;
  customId: string | null;
}

function embeddingResult(output: Record<string, unknown>, terms: Terms): EmbeddingResult {
  const usage = asRecord(own(output, "usage"));
  return new EmbeddingResult({
    // **Masked by `isEmbedding`, which is the only caller and reads `data` with
    // `own` itself before dispatching here.** So this read cannot reach the
    // prototype today — and nothing enforces that ordering. Reverting it to a
    // bare `output.data` is invisible until somebody calls `embeddingResult`
    // from a second place, or moves the `object === "list"` check.
    embeddings: asArray(own(output, "data")).map(asRecord),
    model: typeof own(output, "model") === "string" ? (own(output, "model") as string) : null,
    promptTokens: Number(unitCount(own(usage, "prompt_tokens"), 0)),
    raw: output,
    cost: embeddingCost(usage, terms.rates),
    ...terms,
  });
}

function mediaResult(output: Record<string, unknown>, terms: Terms): MediaResult {
  let frames: Record<string, unknown>[];
  let units: bigint;
  if (Object.hasOwn(output, "images")) {
    // **Masked by the `Object.hasOwn` one line up**: the key is own or this arm
    // does not run. The `own` is kept anyway because the pairing is what makes
    // it true, and nothing enforces the pairing — separate the two and the bare
    // read is back.
    frames = asArray(own(output, "images")).map(asRecord);
    // Output pixels, summed over the delivered images — the image billing unit.
    units = frames.reduce((total, frame) => total + framePixels(frame), 0n);
  } else {
    // **Masked by `isMedia` plus the `images` test above**: reaching this arm
    // means `isMedia` found one of the two own, and it was not `images`. Both
    // halves of that argument live in other lines, and neither is enforced.
    const video = asRecord(own(output, "video"));
    frames = Object.keys(video).length > 0 ? [video] : [];
    // Pixel-seconds — the video billing unit.
    units = framePixels(video) * unitCount(own(video, "duration_secs"), 0);
  }
  // The provider's own statement of what settled, when it makes one: frames are
  // labelled with what was delivered, the order's `units_out` caps the charge,
  // and a render larger than its cap makes the two differ.
  const stated = own(output, "units");
  if (typeof stated === "number" && Number.isSafeInteger(stated) && stated >= 0) {
    if (BigInt(stated) <= units) units = BigInt(stated);
  }
  return new MediaResult({
    frames,
    seed: typeof own(output, "seed") === "number" ? (own(output, "seed") as number) : null,
    raw: output,
    cost: mediaCost(units, terms.rates),
    ...terms,
  });
}

function textResultFromResponse(response: Record<string, unknown>, terms: Terms): TextResult {
  const outputItems = asArray(own(response, "output"));
  // The spread is here so `result.usage` is not an alias into `raw` — nothing
  // more. It copies own properties into a literal that still inherits from
  // `Object.prototype`, so it is not a guard, and `textCost` reads it
  // own-properties only for that reason.
  const usage = { ...asRecord(own(response, "usage")) };
  return new TextResult({
    text: flattenResponseOutput(outputItems),
    output: outputItems,
    usage,
    raw: response,
    cost: textCost(usage, terms.rates),
    ...terms,
  });
}

function textResultFromChatCompletion(body: Record<string, unknown>, terms: Terms): TextResult {
  // **Masked by the `Object.hasOwn(body, "choices")` in `resultFromRaw` that
  // dispatches here** — the only caller. The guard is one function away and
  // nothing binds the two, so a second caller, or a dispatch reordered to test
  // something else, un-masks this line silently.
  const choices = asArray(own(body, "choices"));
  const text = choices
    .map((choice) => {
      const content = own(asRecord(own(asRecord(choice), "message")), "content");
      return typeof content === "string" ? content : "";
    })
    .join("");
  const rawUsage = asRecord(own(body, "usage"));
  // Built here from own reads. `textCost` still reads it own-properties only:
  // an object literal inherits from `Object.prototype` like any other.
  const usage = {
    input_tokens: own(rawUsage, "prompt_tokens") ?? 0,
    output_tokens: own(rawUsage, "completion_tokens") ?? 0,
    total_tokens: own(rawUsage, "total_tokens") ?? 0,
  };
  return new TextResult({
    text,
    output: choices,
    usage,
    raw: body,
    cost: textCost(usage, terms.rates),
    ...terms,
  });
}

/**
 * Open a `vorq-sealed-v1` result sealed to our key; pass cleartext through.
 *
 * A seal that does not open is a `ResultIntegrityError` like every other
 * unreadable result, and for the same reason: the caller asked for an answer and
 * there is none to give. The underlying cipher's own exception is wrapped rather
 * than allowed to escape — a caller holding one `catch (e) { if (e instanceof
 * VorqError) … }` over the read path should not also have to know which crypto
 * library opened the box — and it is chained on `cause`, so the original is
 * still there for anyone debugging a key mismatch.
 */
function decryptOutput(
  output: Record<string, unknown>,
  cipher: Cipher | null,
): Record<string, unknown> {
  // Own properties only (see `own.ts`). A polluted `Object.prototype.enc` would
  // otherwise make every cleartext result look sealed, and every result read
  // fail with "sealed but no cipher is configured".
  if (own(output, "enc") !== SEALED_RESULT_VERSION) return output;
  if (cipher === null) {
    throw new ResultIntegrityError("result is sealed but no cipher is configured to open it");
  }
  let opened: unknown;
  try {
    const ciphertext = own(output, "ciphertext");
    if (typeof ciphertext !== "string") {
      throw new Error("the sealed result carries no base64 'ciphertext' member");
    }
    const box = fromBase64Strict(ciphertext);
    if (box === null) throw new Error("the sealed result's ciphertext is not base64");
    // The plaintext is parsed inside the wrap as well: bytes that opened but are
    // not JSON are the same unreadable result, and a bare `SyntaxError` escaping
    // here would miss the one `catch` a caller holds over this path.
    opened = JSON.parse(new TextDecoder().decode(cipher.decrypt(box)));
  } catch (cause) {
    const error = new ResultIntegrityError(
      "the sealed result did not open with this client's result key. It was sealed " +
        "to the result_key the submission's envelope carried, which a wallet-backed " +
        `client derives from its own wallet (${String(cause)})`,
    );
    error.cause = cause;
    throw error;
  }
  if (!isRecord(opened)) {
    throw new ResultIntegrityError(
      "the sealed result opened to something other than a result object",
    );
  }
  return opened;
}

/**
 * Open the bytes stored under the CID a job settled with.
 *
 * `cid` is the name these bytes were fetched by and is carried here for the
 * errors to quote: the storage layer serves back what it stored, so the name
 * identifies the result rather than challenging it. Nothing here recomputes it.
 *
 * Bytes that are not a JSON result object raise `ResultIntegrityError` — nothing
 * at that name is readable as a result — so callers meet one shaped error the
 * transports already carry, rather than a decoder's own exception.
 */
export function openResultBytes(
  raw: Uint8Array,
  cid: string,
  cipher: Cipher | null,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    const error = new ResultIntegrityError(
      `result bytes under CID ${JSON.stringify(cid)} are not JSON: ${String(cause)}`,
    );
    error.cause = cause;
    throw error;
  }
  if (!isRecord(parsed)) {
    throw new ResultIntegrityError(
      `result bytes under CID ${JSON.stringify(cid)} decode to ` +
        `${Array.isArray(parsed) ? "array" : typeof parsed}, not a result object`,
    );
  }
  return decryptOutput(parsed, cipher);
}

/** Dispatch an opened output onto its result type, under the job's terms. */
function resultFromOutput(
  output: Record<string, unknown>,
  job: Record<string, unknown>,
): TextResult | MediaResult | EmbeddingResult {
  // Own properties only, throughout this function and everything it dispatches
  // to (see `own.ts`): `output` came out of `JSON.parse` over bytes a provider
  // produced and `job` off the coordinator's wire, and `JobHandle.result()` is
  // a public path to both.
  const vorq = asRecord(own(job, "vorq"));
  const rates: Rates = {
    rateIn: asRate(own(vorq, "rate_in"), "rate_in"),
    rateOut: asRate(own(vorq, "rate_out"), "rate_out"),
  };
  // The provider's correlation stamp, lifted off the sealed body before anything
  // else reads it: `raw` stays the model's own object, and the stamp is VORQ's,
  // added outside it. Only the caller's label is surfaced — the stamp's `job_id`
  // is there for a human reading a sealed body, and nothing here branches on it.
  const stamp = asRecord(own(output, "vorq"));
  let body = output;
  if (Object.keys(stamp).length > 0) {
    body = Object.fromEntries(Object.entries(output).filter(([key]) => key !== "vorq"));
  }
  // Required on every row a result is built from — a job row and a batch
  // success line alike. Refused, never defaulted.
  const gasFee = own(vorq, "gas_fee");
  if (!isUsd(gasFee)) {
    throw new VorqError(`the node sent gas_fee=${JSON.stringify(gasFee)}, which is not a USD amount`, {
      type: "api_error",
    });
  }
  const fee = own(vorq, "fee");
  if (!isUsd(fee)) {
    throw new VorqError(`the node sent fee=${JSON.stringify(fee)}, which is not a USD amount`, {
      type: "api_error",
    });
  }
  const terms: Terms = {
    rates,
    gasFee,
    fee,
    // `provider_id`, which is what the row carries — `clientJob` projects the
    // chain's `providerId` and there is no `provider` key on it. Reading the
    // wrong one is invisible: the result builds and `.provider` is just null.
    provider:
      typeof own(vorq, "provider_id") === "number" || typeof own(vorq, "provider_id") === "string"
        ? (own(vorq, "provider_id") as number | string)
        : null,
    jobId: typeof own(job, "id") === "string" ? (own(job, "id") as string) : null,
    customId:
      typeof own(stamp, "custom_id") === "string" ? (own(stamp, "custom_id") as string) : null,
  };
  if (isEmbedding(body)) return embeddingResult(body, terms);
  if (isMedia(body)) return mediaResult(body, terms);
  // A job settled through the chat-completions preset carries a verbatim
  // `chat.completion` object; the native surface passes it through as-is, so the
  // chat-completion shape is parsed rather than the Responses one.
  if (Object.hasOwn(body, "choices")) return textResultFromChatCompletion(body, terms);
  return textResultFromResponse(body, terms);
}

/**
 * Build the result for a settled job from its fetched result bytes.
 *
 * The only path a settled job's result is read on: the bytes fetched by the
 * job's `result_cid` are opened with `cipher` (a sealed body was sealed to the
 * `result_key` the submission's envelope carried), then dispatched onto their
 * result type. There is no unnamed variant — a job that settled without naming
 * its result named nothing to fetch.
 */
export function resultFromRaw(
  raw: Uint8Array,
  job: Record<string, unknown>,
  cipher: Cipher | null = null,
): TextResult | MediaResult | EmbeddingResult {
  const cid = own(job, "result_cid");
  const resultCid = typeof cid === "string" ? cid : "";
  return resultFromOutput(openResultBytes(raw, resultCid, cipher), job);
}

/**
 * Build a result or an error from one row of a batch output or error file.
 *
 * **The named bytes are the only bytes.** A row carries `vorq.result_cid` and a
 * `response.body` that is always null: the result is sealed to this client's own
 * result key, so the coordinator cannot read it and does not pretend to. There
 * is no inline convenience copy, which is what stops sealed bodies being
 * swapped between lines.
 *
 * Each row carries its own line's rates — every line settles under its own
 * signed order — so cost is computed from those and never from a batch-level
 * average.
 */
export function resultFromBatchLine(
  line: Record<string, unknown>,
  cipher: Cipher | null = null,
  raw: Uint8Array | null = null,
): TextResult | MediaResult | EmbeddingResult | JobError {
  // Own properties only: a batch row is `JSON.parse` output off the wire.
  const vorq = asRecord(own(line, "vorq"));
  // `null` when the row carries a `vorq` block naming no job, and that is the
  // answer rather than a fallback: a line the coordinator skipped never became
  // a job, so there is no job id, and reporting the synthetic row id as one
  // would hand a caller a string that resolves to nothing on chain. Those lines
  // correlate through `BatchHandle.jobIds`, in input order. The row id is used
  // only when there is no `vorq` block at all.
  //
  // An id that is present but not a string answers `null` here too, which
  // overloads that meaning slightly: the caller cannot tell a skipped line from
  // a malformed one. The alternative is surfacing a non-string through a
  // `string | null` type, and a job id nothing can look up is worth less than a
  // type callers can trust.
  const jobId = Object.hasOwn(line, "vorq")
    ? typeof own(vorq, "job_id") === "string"
      ? (own(vorq, "job_id") as string)
      : null
    : typeof own(line, "id") === "string"
      ? (own(line, "id") as string)
      : null;

  // Decided before any result CID is looked for: a row that reports an error
  // never delivered, whatever else it happens to name.
  //
  // An `error` that is not an object still reports one, so it is carried
  // through stringified under the canonical unknown cause. Reading past it
  // would be a fail-open: a row carrying `"error": "boom"` beside a valid
  // `result_cid` and openable bytes would be handed to the caller as a
  // delivered result, which is the one shape of mistake this module must not
  // make. That a malformed row also names no result is an assumption about the
  // coordinator, not something the row guarantees.
  const errorMember = own(line, "error");
  const malformedError =
    errorMember !== null && errorMember !== undefined && !isRecord(errorMember);
  const error = asRecord(errorMember);
  if (malformedError || Object.keys(error).length > 0) {
    return new JobError({
      message: malformedError
        ? String(errorMember)
        : typeof own(error, "message") === "string"
          ? (own(error, "message") as string)
          : "",
      type: typeof own(error, "code") === "string" ? (own(error, "code") as string) : "unknown",
      jobId,
      customId: typeof own(line, "custom_id") === "string" ? (own(line, "custom_id") as string) : null,
      raw: error,
    });
  }

  const rowCid = own(vorq, "result_cid");
  const resultCid = typeof rowCid === "string" ? rowCid : "";
  if (resultCid === "") {
    // A success row that names nothing named nothing to fetch. Fail closed
    // rather than inventing an empty result: the row claims a delivery and
    // there is no way to check it.
    throw new ResultIntegrityError(
      `batch row ${JSON.stringify(own(line, "id") ?? null)} reports success and names no ` +
        "result_cid, so there are no bytes to open",
    );
  }
  return resultFromOutput(openResultBytes(raw ?? new Uint8Array(), resultCid, cipher), {
    id: jobId,
    // The row spells the provider `provider`; `resultFromOutput` reads
    // `provider_id`, which is what a job projection carries. Reading the wrong
    // one is invisible — the result builds and `.provider` is just null.
    vorq: {
      rate_in: own(vorq, "rate_in"),
      rate_out: own(vorq, "rate_out"),
      gas_fee: own(vorq, "gas_fee"),
      fee: own(vorq, "fee"),
      provider_id: own(vorq, "provider"),
    },
  });
}
