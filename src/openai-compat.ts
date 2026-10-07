/**
 * The sealed transport for the stock `openai` npm package.
 *
 * `sealingFetch(options)` returns a `fetch`-compatible function that
 * intercepts the OpenAI Responses surface and runs the native sealed-job flow
 * underneath: seal the request to the serving provider, submit the order, wait
 * (sync) or poll (background), open the sealed result, and synthesize a
 * standard Response object. The coordinator never sees the request params or
 * the generated text.
 *
 *     import OpenAI from "openai";
 *     import { sealingFetch } from "@vorq-ai/client-sdk";
 *
 *     const client = new OpenAI({
 *       baseURL: "https://api.example/v1",
 *       apiKey: "unused",
 *       fetch: sealingFetch({ baseUrl: "https://api.example", signer }),
 *     });
 *
 * **Two different base URLs, on purpose.** `new OpenAI({baseURL})` needs the
 * `/v1` suffix — that is what the package uses to build the request path
 * (`/v1/responses`), which is what this function pattern-matches on.
 * `sealingFetch({baseUrl})` takes the bare coordinator origin instead, since
 * the `Client` underneath talks to `/v1/jobs` and friends directly.
 *
 * Both the intercepts and the forward list match `/v1/…` exactly, so an
 * OpenAI base URL carrying a mount prefix (`https://host/api/v1`) presents
 * paths as `/api/v1/…` and matches neither — every call is refused, including
 * Responses. The mount prefix is a misconfiguration and it reads as one; it
 * does not silently unseal anything.
 *
 * Ports `vorq-client-sdk-python/vorq/_openai_compat.py`. The Python version is
 * an `httpx.BaseTransport` and is sync-only because it owns a private event
 * loop per call; this one is a closure over one long-lived `Client` and is
 * async throughout. Every divergence from it is deliberate and carries its
 * plan number at the site that diverges: D7-D11, and D13-D21 below.
 */
import { Client, type ClientOptions, type SubmitArgs } from "./client.js";
import { wallNow } from "./clock.js";
import { JobFailed, TransportError, ValidationError, VorqError } from "./errors.js";
import { endCause } from "./jobs.js";
import { own } from "./own.js";
import { EmbeddingResult, MediaResult, TextResult } from "./results.js";
import type { Signer, Cipher } from "./signer/types.js";
import type { Verifier } from "./verify.js";

const STATUSES = new Set(["queued", "in_progress", "completed", "failed", "cancelled"]);

/**
 * The coordinator routes this transport forwards unsealed, as `[method,
 * pattern]` with `*` standing for one path segment. Anything not listed here
 * and not intercepted is refused before its body is read, so a route leaks
 * only if it was declared content-free deliberately — never by being
 * overlooked. That is the whole point of the direction: the OpenAI surface
 * grows, and a list of what must NOT be sent can never be shown complete.
 *
 * No entry here submits a prompt, and that is the only property this list
 * asserts. The batch-create body is the one exception to "carries nothing of
 * yours": its optional `metadata` is a plaintext field by design and travels
 * in the clear. That is a property of the batch API rather than of this
 * transport.
 *
 * **`POST /v1/files` is deliberately not on this list, and it is the one file
 * route that is not.** A stock caller doing `client.files.create({file,
 * purpose: "batch"})` uploads a plaintext JSONL — every prompt in it, in the
 * clear — which is precisely the disclosure this transport exists to prevent.
 * The reads are content-free and forward: the object, and the bytes of an
 * output file that were sealed before they were ever written.
 */
export const FORWARD: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/v1/models"],
  ["POST", "/v1/batches"],
  ["GET", "/v1/batches"],
  ["GET", "/v1/batches/*"],
  ["POST", "/v1/batches/*/cancel"],
  ["GET", "/v1/files/*"],
  ["GET", "/v1/files/*/content"],
  ["GET", "/v1/jobs/*"],
  ["POST", "/v1/jobs/*/cancel"],
];

/**
 * Response headers a forwarded call carries back **beyond `content-type`**,
 * which a forward relays from the answer it is relaying. `x-request-id` is what
 * the `openai` package attaches to its exceptions; everything else is the
 * coordinator's transport detail.
 */
export const PASSTHROUGH_HEADERS = ["x-request-id"] as const;

export const SEALED_SURFACE_HINT =
  "Use the Responses surface (POST /v1/responses), which seals the payload end-to-end.";
export const FILE_UPLOAD_HINT =
  "A batch input file is uploaded already sealed, line by line: use " +
  "client.batches.submit(requests), which seals each line into its own container before " +
  "anything leaves the process. Uploading the file through this transport would put every " +
  "prompt in it on the wire in the clear.";
/**
 * The sentence both streaming refusals open with — the one on the create body
 * and the one on the retrieve query. Two copies of it drift, and the second
 * copy is the one nobody updates.
 */
export const STREAM_REFUSAL =
  "streaming is not available on the sealed surface: a sealed result is a single " +
  "object, delivered when the job settles.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Python's truthiness, for the three places this port meets it: an empty
 * container is falsy there and truthy here. Ported as `Boolean(x)` all three
 * sites invert — an empty `metadata` object would be passed through where the
 * authority replaces it with `{}`, and an empty `error` object would be
 * rendered where the authority omits it.
 *
 * Arrays go down the same arm as objects, because `[] or {}` is `{}` in Python
 * too; `isRecord` is not reused here for exactly that reason.
 */
const nonEmpty = (value: unknown): boolean =>
  typeof value === "object" && value !== null ? Object.keys(value).length > 0 : Boolean(value);

/**
 * Match a path against a pattern where `*` stands for exactly one segment.
 *
 * Segment counts must agree and a `*` never matches an empty segment, so
 * `/v1/jobs/` is not `/v1/jobs/*` and `/v1/responses/a/b` is not
 * `/v1/responses/*`. The intercepts and the forward list share this so the
 * file has one matching rule rather than one per caller.
 */
export function matches(pattern: string, path: string): boolean {
  const parts = pattern.split("/");
  const segments = path.split("/");
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => (part === "*" ? segments[i] !== "" : part === segments[i]));
}

/** Whether this route is declared free of prompt content, so it may go unsealed. */
export function forwardable(method: string, path: string): boolean {
  return FORWARD.some(([m, pattern]) => m === method && matches(pattern, path));
}

/** The surface to point a refused caller at instead. */
export function denyHint(path: string): string {
  return path.startsWith("/v1/files") ? FILE_UPLOAD_HINT : SEALED_SURFACE_HINT;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A `VorqError` as the HTTP response the `openai` package expects.
 *
 * The status the error arrived on is preserved, so the package raises the
 * class a caller expects — and, for 429/5xx, still applies its own retry
 * policy, which it does not do for a 400. An error the SDK raised locally has
 * no status and is rendered 400.
 *
 * **Not every status-less error that reaches here is a request-shape refusal,
 * and 400 is still the faithful render.** `fetchBlob` raises a status-less
 * `VorqError(type: "api_error")` when the gateway connection fails
 * (`files.ts`), and Task 3 reaches it on the retrieve path — `settledResult`
 * opens a named result by fetching its blob. Nothing answered, so there is no
 * status to carry, and the authority does exactly the same thing:
 * `_client.py:1096-1099` **converts** that failure into a status-less
 * `VorqError(type="api_error")` rather than letting the `httpx` exception
 * escape, and `_openai_compat.py`'s `_error` renders it 400 through the same
 * `exc.status_code or 400`. (The authority re-raises raw `httpx` on the
 * *submit* path instead — `_client.py:829/841` — which is why "Python's
 * transport failures always escape" is not a safe generalization to reason
 * from.)
 *
 * **D17 — `TransportError` is the one status-less error that must not be
 * rendered here at all, and Task 3 rethrows it rather than calling this.** It
 * is a `VorqError` with no `statusCode` (`errors.ts`), so it would land on the
 * same 400 — but the `openai` package does not retry a 400, and the identical
 * failure arriving as a 5xx would be retried. Its Python counterpart is not a
 * `VorqError` at all: `_request`'s transport failures escape `handle_request`
 * and reach the package as `APIConnectionError`, **which it does retry**.
 * Rendering one here would be a behaviour regression against the authority
 * wearing the costume of faithfulness to `exc.status_code or 400`.
 *
 * `retryable: false` opts a route out of that policy with the header the
 * package checks ahead of the status. Submissions need it: a re-seal produces
 * a fresh job id, so the coordinator's duplicate-id guard cannot collapse the
 * copies, and a retried 429 there would mean paying twice for one call.
 *
 * `x-should-retry` is minted here and never crosses a network — this response
 * is constructed in-process and handed straight back to the caller.
 */
export function errorResponse(error: VorqError, options: { retryable?: boolean } = {}): Response {
  // Own properties only, the same hole `responseObject` had four lines of
  // comment away: `{ retryable = true }` fires on `undefined`, and an inherited
  // property is not undefined, so a polluted `Object.prototype.retryable` of
  // `false` strips `x-should-retry` from a refusal that never chose to.
  // Nothing signed and nothing on the wire rests on this — the response is
  // built in-process — but it is the same class, in the file the rule was
  // swept through.
  const retryable = (own(options as Record<string, unknown>, "retryable") as boolean) ?? true;
  const headers: Record<string, string> = {};
  if (error.requestId) headers["x-request-id"] = error.requestId;
  if (!retryable) headers["x-should-retry"] = "false";
  return jsonResponse(
    // `||`, not `??`: `0` is not a status. Every `statusCode` this SDK sets is
    // either a `Response.status` off a real `fetch` or one of the literals in
    // `client.ts`/`batches.ts`/`files.ts`, so the value handed to `Response`
    // here is always inside the 200-599 it accepts.
    error.statusCode || 400,
    // `||` again, and for the same reason the authority uses `or`
    // (`_openai_compat.py:266`): `errorFromWire` keeps a wire `error.type`
    // verbatim whenever it is a string, `""` included (`errors.ts`), and an
    // empty type is not a type. Emitting `"type": ""` would hand the `openai`
    // package a discriminator it cannot map to any exception class.
    { error: { message: error.message, type: error.type || "invalid_request_error" } },
    headers,
  );
}

export interface ResponseObjectOptions {
  model?: string | null;
  background: boolean;
  result?: TextResult | MediaResult | EmbeddingResult | null;
  now?: () => number;
}

/**
 * Render an OpenAI Response from whatever the coordinator just answered.
 *
 * **Two wire shapes name a job and they spell it differently.** A row from
 * `GET /v1/jobs/{id}` is keyed `id`; a relay receipt from `POST /v1/jobs` (and
 * from the cancel) is keyed `job_id` and carries no `status` at all. Both
 * reach here — a background create renders the receipt, a retrieve renders the
 * row — so reading `job.id` alone fails on every fresh submission.
 *
 * A receipt has no status because it does not need one: the node waits for the
 * transaction receipt before answering, so a post that returned is a job on
 * the book (`queued`), and a cancel that returned is a job the chain has
 * ended.
 */
export function responseObject(
  job: Record<string, unknown>,
  options: ResponseObjectOptions,
): Record<string, unknown> {
  // **Own properties only on the options record, and a destructuring default is
  // not enough.** `{ model = null }` fires only on `undefined`, and an
  // inherited property is not undefined — so a polluted `Object.prototype.model`
  // was read here as the caller's own, and a cancel receipt (which names no
  // model at all) rendered somebody else's. Same shape for `now` and `result`.
  const opts = options as unknown as Record<string, unknown>;
  const model = (own(opts, "model") ?? null) as ResponseObjectOptions["model"];
  const background = own(opts, "background") === true;
  const result = (own(opts, "result") ?? null) as ResponseObjectOptions["result"];
  const now = (own(opts, "now") ?? wallNow) as () => number;
  // **D14 — a status this SDK cannot read degrades where the authority
  // crashes.** `_openai_compat.py:134` is
  // `_STATUS.get(job.get("status", "queued"), "queued")`, and a row spelling
  // its status `["completed"]` — legal JSON, and all a broken or hostile
  // coordinator has to send — raises `TypeError: unhashable type: 'list'`
  // there, mid-render, on a body that arrived intact.
  //
  // `STATUSES.has` is what makes that a `"queued"` here: a `Set` lookup on a
  // non-string is simply `false`, where the dict lookup it ports throws. The
  // `typeof` line below is **not** load-bearing for that — deleting it and
  // testing `job.status` directly passes every test in this file — and it is
  // kept as defence in depth, not because it does work `STATUSES.has` does not.
  //
  // What the pair does buy is that nothing here stringifies first:
  // `String(["completed"])` is `"completed"` in JS, so a port that reached for
  // `String()` to be lenient would report a job **settled** on the strength of
  // a bracket. (Python's `str(["completed"])` is `"['completed']"`, so that
  // hazard is this language's, just as the crash above is that one's.)
  // **Own properties only, on every read of `job` in this function** — the
  // package rule (`own.ts`), and it is load-bearing here: `job` is a
  // coordinator answer off `JSON.parse`, and a bare `job.status` is answered by
  // a polluted `Object.prototype.status`. `"completed"` there reports every
  // queued job settled, with an empty output because nothing was fetched.
  const rawStatus =
    typeof own(job, "status") === "string" ? (own(job, "status") as string) : "queued";
  const status = STATUSES.has(rawStatus) ? rawStatus : "queued";
  // The same rule on the one field the caller passes back to
  // `responses.retrieve`: a prototype-supplied `id` names a job nobody
  // submitted, and the real one is lost.
  const id = own(job, "id") || own(job, "job_id");
  if (typeof id !== "string" || id === "") {
    // Named rather than left to escape as a `TypeError`, which the `openai`
    // package wraps as `APIConnectionError` — the network blamed for a body
    // that arrived (D7).
    //
    // **D13 — this refuses more than D7 describes.** D7 is about an answer that
    // named *no* job; the `typeof` half also refuses one that named a job
    // badly. `_response_object({"id": 123})` renders `{"id": 123, …}` and
    // `{"id": "", "job_id": 7}` renders `"id": 7`, so the authority will hand
    // an `openai` caller a response whose `id` cannot be passed back to
    // `responses.retrieve`. Refused instead, at the one place that can still
    // say which body was wrong. Relaxing this guard to `id == null` would
    // restore the authority's behaviour and the bug with it.
    throw new VorqError(`the coordinator's answer named no job: ${JSON.stringify(job)}`, {
      type: "invalid_response",
    });
  }

  const out: Record<string, unknown> = {
    id,
    object: "response",
    status,
    // `||`, not `??`: Python's `model or job.get("model")` lets an empty
    // string fall through to the row's own model, and an empty model name is
    // not a model name.
    //
    // **D16 — the `typeof` is a divergence, not a restatement of the `or`.**
    // Python's `job.get("model")` passes a non-string through, so a row whose
    // `model` is `7` renders `"model": 7`; this renders `null`. A model name is
    // a string on this surface, and a number there is a row the caller cannot
    // act on either way.
    model: model || (typeof own(job, "model") === "string" ? (own(job, "model") as string) : null),
    background,
    created_at: own(job, "created_at") || Math.floor(now()),
    output: [],
    incomplete_details: null,
    metadata: nonEmpty(own(job, "metadata")) ? own(job, "metadata") : {},
    vorq: nonEmpty(own(job, "vorq")) ? own(job, "vorq") : {},
  };

  if (result instanceof MediaResult) {
    out.status = "completed";
    // An OpenAI client consumes bytes. The frames are already base64 inside
    // the result, so they pass straight through — decoding to re-encode would
    // be the same string and twice the work.
    //
    // Video frames render under the same item type: the Responses schema has
    // no video item, and the type is the consumer's only signal for what
    // `result` decodes to, so the frame's `content_type` is what a caller
    // reads off the native `MediaResult` to tell the two apart.
    out.output = result.frames.map((frame, i) => ({
      type: "image_generation_call",
      id: `ig_${id}_${i}`,
      status: "completed",
      // Own properties only, for the reason `results.ts`'s `MediaResult.bytes`
      // gives at its own copy of this read (`own.ts`): a frame is `JSON.parse`
      // output over provider bytes, and a polluted `Object.prototype.b64`
      // renders an image nobody produced as this response's output.
      result: own(frame, "b64"),
    }));
  } else if (result instanceof TextResult) {
    // `TextResult` and not "anything that is not media": an `EmbeddingResult`
    // has no `.text` and no Responses item type to render as, and this
    // surface is the Responses API. One reaching here would mean a job settled
    // through the embeddings preset was retrieved as a response, and the
    // honest render of that is the job row without an output — not a
    // fabricated message.
    out.status = "completed";
    out.output = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: result.text }] },
    ];
    // `typeof … === "number"`, not `?? 0`: a `usage` that carries the key with
    // an explicit `null` is the shape Python's `.get(key, 0)` passes straight
    // through as `None`, and `null` is not a token count (D8).
    // Own properties only, for the reason `results.ts` gives at its own copy of
    // this read: `result.usage` is a literal built by spreading the provider's
    // usage record, so it still inherits from `Object.prototype` and a bare
    // index would let a polluted prototype choose the token counts rendered
    // here (`own.ts`).
    const count = (key: string): number => {
      const value = own(result.usage, key);
      return typeof value === "number" ? value : 0;
    };
    out.usage = {
      input_tokens: count("input_tokens"),
      output_tokens: count("output_tokens"),
      total_tokens: count("total_tokens"),
    };
  }

  if (status === "failed" || status === "cancelled") {
    // The row carries no `error` object — the end cause is `vorq.ended_because`
    // (`Types.sol`: 2 cancelled, 3 provider_fail, 4 reclaim, 5 expired). Read
    // through the same table the native surface uses, so a retrieve reports the
    // cause `handle.result()` would have raised instead of reporting nothing.
    // An explicit `error` on the body still wins.
    //
    // **D15 — an `error` that is truthy but not an object is ignored, where the
    // authority renders it as a null cause.** Python gates the *read* on
    // `isinstance(error, dict)` but not the `if error or cause`, so
    // `{"status": "failed", "error": "boom"}` with no `vorq` renders
    // `{"code": None, "message": "job x failed (None)"}` — a fabricated cause
    // saying nothing. Gating both on `isRecord` here omits the key instead,
    // which is what D15's own sibling case (a `failed` row naming no cause at
    // all) already does. Where the row *does* name a cause the two agree.
    // Own properties only again: a polluted `Object.prototype.error` would
    // attach a failure cause to a row that named none.
    const error = isRecord(own(job, "error")) ? (own(job, "error") as Record<string, unknown>) : null;
    const cause = error ? own(error, "code") : endCause(job);
    if (nonEmpty(error) || cause) {
      out.error = nonEmpty(error)
        ? error
        : { code: cause, message: `job ${id} ${status} (${cause})` };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plumbing
// ---------------------------------------------------------------------------

/** The shape the `openai` package's `fetch` option expects. */
export type SealingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SealingFetchOptions {
  baseUrl?: string;
  signer?: Signer;
  cipher?: Cipher;
  /**
   * Needed for an open order (a ceiling in the `vorq` block that no provider is
   * within, and no provider named): it seals to the coordinator's escrow key,
   * and the client will not post one it cannot verify. A call that names no
   * ceiling is pinned to a provider and needs none.
   */
  verifier?: Verifier | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * An already-built client, used instead of the fields above. This is the
   * seam the suite drives; passing it alongside any construction option is a
   * configuration mistake and throws.
   */
  client?: Client;
}

const CONSTRUCTION_KEYS = [
  "baseUrl",
  "signer",
  "cipher",
  "verifier",
  "timeoutMs",
  "fetch",
] as const;

/** One request, normalized from the three input forms. The body stays lazy. */
interface Incoming {
  method: string;
  pathname: string;
  params: Record<string, string>;
  readBody: () => Promise<string>;
}

/**
 * Normalize the three shapes `Fetch` admits — a string, a `URL`, or a
 * `Request` — into one, without reading the body.
 *
 * **D18 — percent-encoded separators make the two SDKs answer differently on
 * the same URL.** `httpx.URL.path` is percent-*decoded*, so the authority sees
 * `/v1/jobs%2Fx` as `/v1/jobs/x` and forwards it; `URL.pathname` here is not
 * decoded, so the same request is one segment named `jobs%2Fx` and is refused.
 * `POST /v1/jobs%2Fx%2Fcancel` goes the same way. Both are the closed
 * direction. One case inverts: `GET /v1/files/%2E%2E%2Fjobs` is one segment
 * here and forwards, where the authority decodes it to three and refuses — a
 * content-free GET either way, so nothing of the caller's is disclosed by it.
 *
 * `new URL()` also normalizes `..` segments before `pathname` is read, which
 * is why a mount-prefixed base does not sneak back to `/v1/...`: it presents
 * `/api/v1/...`, matches neither list, and is refused.
 */
function normalize(input: string | URL | Request, init?: RequestInit): Incoming {
  const request = input instanceof Request ? input : null;
  // A relative href would throw here. The `openai` package always builds an
  // absolute one, and a caller passing a relative path has no coordinator to
  // send it to either.
  const url = new URL(request ? request.url : String(input));
  // Own properties only on `init` — it is the caller's object literal, and the
  // package rule (`own.ts`) covers a record that arrived from a caller as well
  // as one off `JSON.parse`. A polluted `Object.prototype.method` would rewrite
  // the verb of every call that passes an `init` without one, turning a
  // forwardable `GET /v1/models` into a refusal; a polluted
  // `Object.prototype.body` would put bytes nobody sent on the wire. `request`
  // is a `Request`, not a record — its `method`/`url` are accessors on
  // `Request.prototype` and are read normally.
  const stated = (key: string): unknown =>
    init === undefined || init === null ? undefined : own(init as Record<string, unknown>, key);
  const initMethod = stated("method");
  const method = String(initMethod ?? request?.method ?? "GET").toUpperCase();
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return {
    method,
    pathname: url.pathname,
    params,
    // Lazy on purpose. A denied route must be refused without this ever being
    // called: reading the body is the step that would put a prompt anywhere
    // other than this process.
    readBody: async () => {
      const body = stated("body");
      if (body !== undefined && body !== null) {
        return typeof body === "string" ? body : await new Response(body as BodyInit).text();
      }
      return request ? await request.clone().text() : "";
    },
  };
}

export function sealingFetch(options: SealingFetchOptions = {}): SealingFetch {
  // **Own properties only on `options`, and this is the most consequential
  // application of the rule in the file** (`own.ts`). `options` is the caller's
  // object literal, so a bare `options.client` is answered by a polluted
  // `Object.prototype.client` — and this transport would then seal every prompt
  // through an object the caller never passed. `options.fetch` is the same door
  // one layer down. A caller who states nothing states nothing.
  const opts = options as Record<string, unknown>;
  /** One own-read for every construction key — the guard, in one place. */
  const stated = <K extends (typeof CONSTRUCTION_KEYS)[number]>(key: K): SealingFetchOptions[K] =>
    own(opts, key) as SealingFetchOptions[K];
  const supplied = CONSTRUCTION_KEYS.filter((key) => stated(key) !== undefined);
  const givenClient = own(opts, "client") as Client | undefined;
  if (givenClient && supplied.length > 0) {
    // A plain `Error`, not a `VorqError`: `errors.ts` reserves that tree for
    // wire and protocol conditions, and this is argument validation of a
    // caller-supplied value.
    throw new Error(
      "sealingFetch takes either 'client' or construction options, not both; got both " +
        `'client' and ${supplied.map((key) => `'${key}'`).join(", ")}.`,
    );
  }
  // One client for the life of this function: the session token, the chain
  // context and the verified escrow key all survive between calls, which is
  // the whole reason those caches exist. The authority builds one per request
  // because its transport is sync and each call needs its own event loop; this
  // one has no such constraint.
  const client =
    givenClient ??
    new Client({
      baseUrl: stated("baseUrl"),
      signer: stated("signer"),
      cipher: stated("cipher"),
      verifier: stated("verifier"),
      timeoutMs: stated("timeoutMs"),
      fetch: stated("fetch"),
    } satisfies ClientOptions);

  const parseBody = async (read: () => Promise<string>): Promise<Record<string, unknown>> => {
    const text = await read();
    if (text === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // Named rather than left to escape as a `SyntaxError`, which the `openai`
      // package would report as a connection fault.
      throw new ValidationError(`request body is not valid JSON: ${(cause as Error).message}`);
    }
    if (!isRecord(parsed)) throw new ValidationError("request body is not a JSON object.");
    return parsed;
  };

  const create = async (body: Record<string, unknown>): Promise<Response> => {
    // **Own properties only, on `body` and on the `vorq` block below** — the
    // package rule (`own.ts`), and the whole request shape rests on it here.
    // `body` is `JSON.parse` output and `block` is either a member of it or a
    // fresh `{}`; both inherit from `Object.prototype`. Read bare, a polluted
    // prototype states terms the caller never typed, and the D19/D20 guards
    // below cannot see it: they refuse a *wrong-typed own* value, and a
    // prototype supplies a correctly-typed one.
    const model = own(body, "model");
    if (typeof model !== "string" || model === "") {
      // The model selects the provider and the rates it clears at, so an order
      // without one is not submittable. Refused here rather than sealed and
      // sent: the coordinator would reject it, and the caller would have paid a
      // round trip to learn what is knowable locally.
      return errorResponse(
        new ValidationError(
          "'model' is required and must be a model name; see client.models.list().",
        ),
      );
    }
    if (own(body, "stream")) {
      // The `openai` package treats a non-SSE 200 as an empty event stream, so
      // accepting this would hand the caller a silent empty iterator instead of
      // their answer. A sealed result is one object, opened at settle.
      return errorResponse(
        new ValidationError(
          `${STREAM_REFUSAL} Omit 'stream', or use background: true and poll retrieve.`,
        ),
      );
    }
    if (nonEmpty(own(body, "metadata"))) {
      // Forbidden as a job param, for the same reason as 'user': a stable
      // caller-chosen identifier would link a wallet's jobs to each other across
      // every provider that serves them. The rule is "rejected, not quietly
      // dropped" — dropping it and echoing {} back reads as stored. Scoped to
      // this surface deliberately: batch-level metadata is a different,
      // plaintext-by-design field, and is not affected.
      return errorResponse(
        new ValidationError(
          "'metadata' is not carried by the sealed Responses surface: a stable caller-chosen " +
            "identifier would link your jobs to each other across providers, and nothing on " +
            "the network reads it. Keep it locally, keyed by the response id.",
        ),
      );
    }

    const background = own(body, "background") === true;
    // Everything an order needs that OpenAI's body has no field for: the SLA
    // window, the ceilings, and an optional named provider. `max_rate_in` /
    // `max_rate_out` are USD per 1M units as decimal strings; a side left out
    // has no ceiling, exactly as on `submit`.
    const block = isRecord(own(body, "vorq")) ? (own(body, "vorq") as Record<string, unknown>) : {};
    // **D19 — a `vorq.sla` that is present and not a string is refused, not
    // defaulted.** Falling back to `"1h"` here would silently rewrite a *signed*
    // term: `{sla: 3600}` is a caller stating a window, and it would have been
    // signed, priced and settled as one hour without a word. The authority
    // passes the value down and `normalize_sla` raises on it, so refusing is the
    // same closed direction and strictly narrower. `null` and `""` still default
    // — that is Python's `or`, which is falsiness rather than a type error.
    const rawSla = own(block, "sla");
    if (rawSla !== undefined && rawSla !== null && rawSla !== "" && typeof rawSla !== "string") {
      return errorResponse(
        new ValidationError(
          `'vorq.sla' must be a window string such as "1h" or "24h"; got ` +
            `${JSON.stringify(rawSla)}. Nothing was sent — defaulting it would have ` +
            "signed a window you did not ask for.",
        ),
      );
    }
    // **D20 — a `vorq.provider` that is present and not a number is refused, not
    // dropped.** Dropping it turns a designated order into an **open** one,
    // sealed to the coordinator's escrow key instead of the named provider's:
    // a change of who can read the payload, made silently, on the one field
    // that decides it. `null` still means "open", which is what the authority's
    // `.get("provider")` means when the key is absent.
    const rawProvider = own(block, "provider");
    if (rawProvider !== undefined && rawProvider !== null && typeof rawProvider !== "number") {
      return errorResponse(
        new ValidationError(
          `'vorq.provider' must be a provider id number; got ` +
            `${JSON.stringify(rawProvider)}. Nothing was sent — dropping it would have ` +
            "re-targeted this order to the coordinator's escrow key instead of the " +
            "provider you named.",
        ),
      );
    }
    const sla = typeof rawSla === "string" && rawSla !== "" ? rawSla : "1h";
    const payload: Record<string, unknown> = { ...body };
    for (const key of ["model", "background", "vorq", "metadata"]) delete payload[key];
    // Own properties only here too: a spread copies own properties into a fresh
    // literal that still inherits from `Object.prototype`, so a bare
    // `payload.input` reads a polluted prototype and seals `messages` the caller
    // never wrote into the payload.
    const input = own(payload, "input");
    if (Array.isArray(input)) {
      payload.messages = input;
      delete payload.input;
    }

    try {
      const handle = await client.submit({
        model,
        input: payload,
        sla,
        // The ceilings bound **signed, settled terms**: a prototype-supplied one
        // is a price this SDK would sign up to on the caller's behalf.
        maxRateIn: (own(block, "max_rate_in") ?? null) as SubmitArgs["maxRateIn"],
        maxRateOut: (own(block, "max_rate_out") ?? null) as SubmitArgs["maxRateOut"],
        ...(typeof rawProvider === "number" ? { provider: rawProvider } : {}),
      });
      if (background) {
        // `nonEmpty`, not `??` — the authority is `handle._job or {...}` and `{}`
        // is falsy there (see the doc comment on `nonEmpty` above; this is the
        // fourth site in this file where Python truthiness is load-bearing).
        // `Client.submit` deliberately keeps the handle when a 2xx receipt is
        // unreadable and leaves `row` as `{}` — "not a reason to lose it" — so a
        // `??` here renders that `{}` and `responseObject` refuses it as naming
        // no job. The caller would get a non-retryable 400 for a job that is
        // posted and paid for, and the 400 would not even name it.
        return jsonResponse(
          200,
          responseObject(nonEmpty(handle.row) ? handle.row! : { id: handle.id, status: "queued" }, {
            model,
            background: true,
          }),
        );
      }
      let result: TextResult | MediaResult | EmbeddingResult;
      try {
        result = await handle.result();
      } catch (error) {
        if (!(error instanceof JobFailed)) throw error;
        return jsonResponse(
          200,
          responseObject(
            {
              id: handle.id,
              status: "failed",
              error: { code: error.errorType, message: error.message },
            },
            { model, background: false },
          ),
        );
      }
      return jsonResponse(
        200,
        // `nonEmpty` for the same reason as the background leg above: an empty
        // row is falsy to the authority and falls through to the literal.
        responseObject(
          nonEmpty(handle.row) ? handle.row! : { id: handle.id, status: "completed" },
          { model, background: false, result },
        ),
      );
    } catch (error) {
      // D17, and it must come first: a `TransportError` is a status-less
      // `VorqError`, so the leg below would render the dropped connection as a
      // 400 the `openai` package never retries. It escapes as the authority's
      // does, and the package reports `APIConnectionError`.
      if (error instanceof TransportError) throw error;
      // `retryable: false` on every failed create is the point of this catch.
      // `Client.submit` posts `POST /v1/jobs` with retry off precisely so a job
      // is never duplicated, and a re-seal produces a fresh job id, so the
      // coordinator's duplicate-id guard cannot collapse the copies either. A
      // retried 429 here would mean paying twice for one call.
      if (error instanceof VorqError) return errorResponse(error, { retryable: false });
      throw error;
    }
  };

  const retrieve = async (id: string, params: Record<string, string>): Promise<Response> => {
    // **D21 — the `openai` package can ask this route for a stream, and a
    // hand-rolled `fetch` never does.** `responses.retrieve(id, {stream: true})`
    // builds `GET /v1/responses/{id}?stream=true` and then reads the answer as
    // SSE, so a JSON 200 is an event stream that ended: the caller iterates it,
    // gets no events and no error, and the settled output is silently replaced
    // by nothing. `create` refuses `stream` in the body for exactly that reason,
    // and the query string is the only place this route can be asked for one.
    //
    // The authority does not do this — `_openai_compat.py`'s `handle_request`
    // passes `path.split("/")[3]` to `_retrieve` and never looks at
    // `request.url.params` — so this is a divergence that closes the same hole
    // there rather than a restatement of it.
    //
    // **The value is compared rather than tested for presence, and the leniency
    // is required rather than tolerated.** The package renders a query boolean
    // through `qs`, so `retrieve(id, {stream: false})` really does put
    // `?stream=false` on the wire — and then reads the answer as JSON, because
    // it opens a stream only when `query.stream` is true. A guard on presence
    // alone would refuse that caller, who asked for precisely what this surface
    // offers. `stream` is absent entirely unless a caller passes it, so the
    // ordinary `retrieve(id)` reaches neither arm.
    // Own properties only: `params` is an object literal built in `normalize`
    // and inherits `Object.prototype`, so a bare read answers for a `stream`
    // nobody put on the query string — and refuses every retrieve (`own.ts`).
    const stream = own(params, "stream");
    if (stream !== undefined && stream !== "false") {
      return errorResponse(
        new ValidationError(
          `${STREAM_REFUSAL} Drop 'stream' from the retrieve and read the response ` +
            "object: a settled one already carries its output, and one that has not " +
            "settled carries its status.",
        ),
      );
    }
    const handle = client.job(id);
    const job = await handle.fetch();
    // Own properties only on the fetched row (`own.ts`): a polluted
    // `Object.prototype.status` of `"completed"` sends every retrieve down the
    // settled-result path for a job that named no result.
    const model = typeof own(job, "model") === "string" ? (own(job, "model") as string) : null;
    if (own(job, "status") === "completed") {
      // Same read as the native surface — the named result is fetched and opened
      // here too.
      const result = await handle.settledResult(job);
      if (result instanceof TextResult || result instanceof MediaResult) {
        return jsonResponse(200, responseObject(job, { model, background: true, result }));
      }
    }
    return jsonResponse(200, responseObject(job, { model, background: true }));
  };

  const cancel = async (id: string): Promise<Response> => {
    // Routed through the handle rather than posted here, because the cancel is a
    // signed chain op: the body carries `{issued_at, signature}` over
    // `Cancel(jobId, issuedAt)` and there is exactly one place in this SDK that
    // authors it.
    //
    // **The answer is a relay receipt, not a job.** The node's cancel route ends
    // in `relay(chain, …, reply, 200, { job_id: jobId })`, so the body is
    // `{job_id, tx_hash}` — no `id`, no `status`, no terms.
    //
    // `cancelled` is asserted rather than re-read, and it is not optimism:
    // `relay` waits for the transaction receipt before it answers, so a `200`
    // here means the chain has ended this job. A follow-up `GET` would cost a
    // round trip and open a window for a state the cancel did not produce.
    const response = await client.job(id).cancelRequest();
    let receipt: unknown = null;
    try {
      receipt = await response.json();
    } catch {
      receipt = null;
    }
    // Own properties only: the receipt is `JSON.parse` output, and a polluted
    // `Object.prototype.job_id` would let a 2xx that named no job be reported
    // as a cancel of some other id (`own.ts`).
    const jobId = isRecord(receipt) ? own(receipt, "job_id") : null;
    if (typeof jobId !== "string") {
      // A 2xx whose body names no job. Named as such rather than left to escape
      // as a `TypeError`, which the `openai` package wraps as
      // `APIConnectionError` — blaming the network for a coordinator that
      // answered.
      throw new VorqError(
        `cancel of ${id} was accepted but the answer named no job_id: ${JSON.stringify(receipt)}`,
        { type: "invalid_response" },
      );
    }
    return jsonResponse(
      200,
      responseObject({ id: jobId, status: "cancelled" }, { background: true }),
    );
  };

  const forward = async (incoming: Incoming): Promise<Response> => {
    const { method, pathname, params } = incoming;
    const text = await incoming.readBody();
    const body = text === "" ? undefined : await parseBody(async () => text);
    let upstream: Response;
    try {
      // The caller's Authorization header is intentionally dropped: session
      // auth rides the wallet underneath, minted and rotated by the client, so
      // the request re-authenticates rather than replays a token.
      upstream = await client.request(method, pathname, {
        json: body,
        params: Object.keys(params).length > 0 ? params : undefined,
      });
    } catch (error) {
      if (error instanceof TransportError) throw error; // D17
      if (!(error instanceof VorqError)) throw error;
      // POST /v1/batches creates a batch, so replaying it bills twice; every
      // other forwarded route is a read or an idempotent cancel.
      const creates = method === "POST" && pathname === "/v1/batches";
      return errorResponse(error, { retryable: !creates });
    }
    const headers: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    };
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  };

  return async (input, init) => {
    const incoming = normalize(input, init);
    const { method, pathname } = incoming;
    try {
      if (method === "POST" && pathname === "/v1/responses") {
        return await create(await parseBody(incoming.readBody));
      }
      if (method === "POST" && matches("/v1/responses/*/cancel", pathname)) {
        return await cancel(pathname.split("/")[3]);
      }
      if (method === "GET" && matches("/v1/responses/*", pathname)) {
        return await retrieve(pathname.split("/")[3], incoming.params);
      }
      if (forwardable(method, pathname)) return await forward(incoming);
    } catch (error) {
      if (error instanceof TransportError) throw error; // D17
      if (error instanceof VorqError) return errorResponse(error);
      throw error;
    }
    // Refused here, before the body was read, so the prompt stayed local. The
    // message says so: a caller that sees a bare transport error cannot tell
    // whether its content was disclosed.
    return errorResponse(
      new ValidationError(
        `${pathname} is not sealed by this transport, so the request was not sent. ` +
          denyHint(pathname),
      ),
    );
  };
}
