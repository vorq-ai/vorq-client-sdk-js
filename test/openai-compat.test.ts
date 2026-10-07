/**
 * The compat surface's decision layer: matching, the forward allowlist, the
 * deny hints, the job→Response render, and the error→Response conversion.
 *
 * Everything here is a pure function of its input — no `Client`, no network.
 * The forward table is the whole security boundary of `openai-compat.ts`, so
 * its edges are pinned case by case rather than left to a reading of
 * `matches`; each boundary row below violates exactly one guard, so deleting
 * any single guard reddens a named row.
 */

import { describe, expect, it } from "vitest";

import { SEALED_RESULT_VERSION } from "../src/crypto/domains.js";
import { curvePublicKey, seal } from "../src/crypto/sealed-box.js";
import { TransportError, ValidationError, VorqError, errorFromWire } from "../src/errors.js";
import { EmbeddingResult, MediaResult, TextResult } from "../src/results.js";
import type { Rates } from "../src/results.js";
import {
  FILE_UPLOAD_HINT,
  FORWARD,
  PASSTHROUGH_HEADERS,
  SEALED_SURFACE_HINT,
  denyHint,
  errorResponse,
  forwardable,
  jsonResponse,
  matches,
  responseObject,
  sealingFetch,
} from "../src/openai-compat.js";
import type { SealingFetch } from "../src/openai-compat.js";
import { Verifier } from "../src/verify.js";
import {
  MODELS,
  QUOTE,
  RECIPIENT_PUBLIC,
  RESULT_KEY,
  baseRoutes,
  client,
  funded,
  json,
  openEnvelope,
  posts,
  probes,
} from "./helpers/submit-harness.js";
import type { Call, Route } from "./helpers/submit-harness.js";
import {
  ESCROW_ACTIVE,
  NOW,
  announcement,
  scriptedNode,
} from "./helpers/verify-harness.js";

/** A pinned clock, so `created_at` is an assertion rather than a range check. */
const at = () => 1_790_000_000;

const RATES: Rates = { rateIn: null, rateOut: "0.09" };

const textResult = (
  text: string,
  usage: Record<string, unknown> = { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
): TextResult =>
  new TextResult({
    text,
    output: [],
    usage,
    raw: {},
    rates: RATES,
    cost: "0.0",
    gasFee: "0.03",
    fee: "0",
    provider: 1,
    jobId: "0xabc",
    customId: null,
  });

const mediaResult = (frames: Record<string, unknown>[]): MediaResult =>
  new MediaResult({
    frames,
    seed: 42,
    raw: {},
    rates: RATES,
    cost: "0.0",
    gasFee: "0.03",
    fee: "0",
    provider: 1,
    jobId: "0xabc",
    customId: null,
  });

const embeddingResult = (): EmbeddingResult =>
  new EmbeddingResult({
    embeddings: [{ embedding: "AAAA", index: 0 }],
    model: "m",
    promptTokens: 7,
    raw: {},
    rates: RATES,
    cost: "0.0",
    gasFee: "0.03",
    fee: "0",
    provider: 1,
    jobId: "0xabc",
    customId: null,
  });

/** `responseObject` with the pinned clock and the two required options. */
const render = (
  job: Record<string, unknown>,
  options: Partial<Parameters<typeof responseObject>[1]> = {},
): Record<string, unknown> => responseObject(job, { background: false, now: at, ...options });

// ---------------------------------------------------------------------------
// Group A — matches
// ---------------------------------------------------------------------------

describe("matches", () => {
  const cases: [string, string, boolean, string][] = [
    ["/v1/jobs/*", "/v1/jobs/abc", true, "one concrete segment under a star"],
    ["/v1/jobs/*", "/v1/jobs/", false, "a star never matches an empty segment"],
    ["/v1/jobs/*", "/v1/jobs", false, "segment counts differ (one short)"],
    ["/v1/jobs/*", "/v1/jobs/a/b", false, "segment counts differ (one long)"],
    ["/v1/responses/*/cancel", "/v1/responses/r1/cancel", true, "a star in the middle"],
    ["/v1/responses/*/cancel", "/v1/responses//cancel", false, "an empty middle segment"],
    ["/v1/models", "/v1/models", true, "a literal pattern"],
    ["/v1/models", "/V1/models", false, "matching is case-sensitive"],
  ];

  for (const [pattern, path, expected, why] of cases) {
    it(`${expected ? "matches" : "refuses"} ${pattern} against ${path} — ${why}`, () => {
      expect(matches(pattern, path)).toBe(expected);
    });
  }

  it("does not treat a star as a prefix wildcard", () => {
    expect(matches("/v1/responses/*", "/v1/responses/resp_1/input_items")).toBe(false);
    expect(matches("/v1/responses/*", "/v1/responses/resp_1/extra/deep")).toBe(false);
  });

  it("refuses a mount-prefixed path segment by segment, not by length alone", () => {
    // Four pattern parts against four path segments, so the length check cannot
    // be what refuses this. A mount prefix shifts every segment right by one:
    // index 0 is `""` against `""` and matches, then the pattern's `v1` meets
    // `api` at index 1 and its `jobs` meets `v1` at index 2. Only the
    // positional literal comparison catches that — a matcher that dropped it
    // would forward a mount-prefixed route.
    expect(matches("/v1/jobs/*", "/api/v1/jobs")).toBe(false);
    expect(matches("/v1/models", "/api/v1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group B — forwardable, the boundary table
// ---------------------------------------------------------------------------

describe("forwardable", () => {
  const refused: [string, string, string][] = [
    // The submission route. The single most dangerous entry to add to FORWARD
    // by accident: forwarding it would post an unsealed order.
    ["POST", "/v1/jobs", "the submission route is on no list"],
    // Method confusion. Each shares a path with a forwarded route but not its
    // method, so the method comparison is the guard each is here for. Three of
    // the four pin it alone; `GET /v1/batches/batch_1/cancel` also reddens when
    // the length check goes, because unchecked its five segments match the
    // four-part `GET /v1/batches/*`.
    ["POST", "/v1/models", "GET /v1/models is forwarded; POST is not"],
    ["DELETE", "/v1/batches/batch_1", "GET /v1/batches/* is forwarded; DELETE is not"],
    ["GET", "/v1/batches/batch_1/cancel", "POST .../cancel is forwarded; GET is not"],
    ["POST", "/v1/files/file_1/content", "GET .../content is forwarded; POST is not"],
    // Segment counts. `*` is one segment, never zero and never several. Each of
    // these has the right method and pins one arm of `matches`.
    ["GET", "/v1/jobs/", "an empty segment is not a segment"],
    ["GET", "/v1/batches/batch_1/extra", "one segment too many"],
    ["GET", "/v1/files//content", "an empty middle segment"],
    // The one file route deliberately absent: a stock
    // `files.create({purpose: "batch"})` uploads a plaintext JSONL.
    ["POST", "/v1/files", "the upload is the disclosure this transport prevents"],
  ];

  for (const [method, path, why] of refused) {
    it(`refuses ${method} ${path} — ${why}`, () => {
      expect(forwardable(method, path)).toBe(false);
    });
  }

  it("forwards each of the nine allowlist entries with a concrete id", () => {
    expect(FORWARD).toHaveLength(9);
    for (const [method, pattern] of FORWARD) {
      const path = pattern.replace(/\*/g, "id_1");
      expect(forwardable(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("does not forward POST /v1/jobs under any spelling on the list", () => {
    // Restated against the table itself, not against the matcher: an entry
    // added here is the one edit that unseals the submission route.
    expect(FORWARD.some(([, pattern]) => pattern === "/v1/jobs")).toBe(false);
    expect(FORWARD.some(([, pattern]) => pattern === "/v1/responses")).toBe(false);
    expect(FORWARD.some(([, pattern]) => pattern === "/v1/files")).toBe(false);
  });

  it("compares the method case-sensitively", () => {
    expect(forwardable("get", "/v1/models")).toBe(false);
  });

  it("refuses a mount-prefixed forward route", () => {
    expect(forwardable("GET", "/api/v1/models")).toBe(false);
  });

  it("relays only x-request-id back off a forwarded call", () => {
    expect([...PASSTHROUGH_HEADERS]).toEqual(["x-request-id"]);
  });
});

// ---------------------------------------------------------------------------
// Group C — denyHint
// ---------------------------------------------------------------------------

describe("denyHint", () => {
  it("points a refused upload at the sealing batch surface", () => {
    const hint = denyHint("/v1/files");
    expect(hint).toBe(FILE_UPLOAD_HINT);
    expect(hint).toContain("client.batches.submit");
    expect(hint).toContain("in the clear");
  });

  it("points every route under /v1/files at the same place", () => {
    expect(denyHint("/v1/files/file_1")).toBe(FILE_UPLOAD_HINT);
    expect(denyHint("/v1/files/file_1/content")).toBe(FILE_UPLOAD_HINT);
  });

  it("points a refused prompt path at the sealed Responses surface", () => {
    const hint = denyHint("/v1/chat/completions");
    expect(hint).toBe(SEALED_SURFACE_HINT);
    expect(hint).toContain("/v1/responses");
  });

  it("points a route nobody enumerated at the sealed surface too", () => {
    expect(denyHint("/v1/anything/invented/later")).toBe(SEALED_SURFACE_HINT);
    expect(denyHint("/v1/anything/invented/later")).toContain("/v1/responses");
  });
});

// ---------------------------------------------------------------------------
// Group D — responseObject
// ---------------------------------------------------------------------------

describe("responseObject", () => {
  it("renders a relay receipt, which carries job_id and no status", () => {
    const out = render({ job_id: "0xabc", tx_hash: "0x1" }, { background: true });
    expect(out.id).toBe("0xabc");
    expect(out.status).toBe("queued");
    expect(out.object).toBe("response");
    expect(out.background).toBe(true);
  });

  it("renders a job row, which carries id and status", () => {
    const out = render({ id: "0xabc", status: "in_progress" });
    expect(out.id).toBe("0xabc");
    expect(out.status).toBe("in_progress");
  });

  it("keeps each of the five known statuses", () => {
    for (const status of ["queued", "in_progress", "completed", "failed", "cancelled"]) {
      expect(render({ id: "x", status }).status).toBe(status);
    }
  });

  it("degrades an unknown status rather than passing it through", () => {
    expect(render({ id: "x", status: "weird" }).status).toBe("queued");
  });

  it("degrades a non-string status rather than passing it through", () => {
    expect(render({ id: "x", status: 7 }).status).toBe("queued");
    expect(render({ id: "x", status: null }).status).toBe("queued");
    // `["completed"]` stringifies to `"completed"`, which is a status this
    // module knows. A row is JSON, so a wrapped status is a shape a caller can
    // actually put on the wire, and reading it as its own stringification would
    // report a job settled on the strength of a bracket.
    expect(render({ id: "x", status: ["completed"] }).status).toBe("queued");
  });

  it("falls through an empty id to job_id", () => {
    expect(render({ id: "", job_id: "0xabc" }).id).toBe("0xabc");
  });

  it("prefers id over job_id when a body carries both", () => {
    // The order is the authority's (`job.get("id") or job["job_id"]`) and it is
    // the line the whole "two wire shapes name a job" docstring is written
    // around. No body the real coordinator sends carries both non-empty — a row
    // has top-level `id` and only `vorq.job_id`, and a relay receipt has no
    // `id` — so nothing else in this file distinguishes the two orders, and a
    // reader tidying them into one lookup would not be told.
    expect(render({ id: "a", job_id: "b" }).id).toBe("a");
  });

  it("names the failure when the answer names no job", () => {
    let thrown: unknown;
    try {
      render({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VorqError);
    expect((thrown as VorqError).type).toBe("invalid_response");
    expect((thrown as Error).message).toContain("{}");
    // Not a TypeError: the `openai` package wraps one as APIConnectionError,
    // which blames the network for a body that arrived.
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it("refuses a job named by something that is not a string", () => {
    expect(() => render({ id: 123 })).toThrow(VorqError);
    expect(() => render({ job_id: ["0xabc"] })).toThrow(VorqError);
    expect(() => render({ id: "", job_id: "" })).toThrow(VorqError);
  });

  it("falls through a created_at of 0 to the clock", () => {
    expect(render({ created_at: 0, id: "x" }).created_at).toBe(1_790_000_000);
  });

  it("keeps a created_at the row actually carries", () => {
    expect(render({ created_at: 1_700_000_001, id: "x" }).created_at).toBe(1_700_000_001);
  });

  it("truncates the clock to whole seconds", () => {
    expect(render({ id: "x" }, { now: () => 1_790_000_000.75 }).created_at).toBe(1_790_000_000);
  });

  it("falls through an empty model name to the row's own", () => {
    expect(render({ id: "x", model: "row-model" }, { model: "" }).model).toBe("row-model");
    expect(render({ id: "x", model: "row-model" }, { model: "arg-model" }).model).toBe(
      "arg-model",
    );
    expect(render({ id: "x" }).model).toBeNull();
    expect(render({ id: "x", model: 7 }).model).toBeNull();
  });

  it("renders a TextResult as one assistant message with its usage", () => {
    const out = render({ id: "x", status: "queued" }, { result: textResult("hello") });
    expect(out.status).toBe("completed");
    expect(out.output).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ]);
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 22, total_tokens: 33 });
  });

  it("renders an absent usage as three zeros", () => {
    const out = render({ id: "x" }, { result: textResult("hi", {}) });
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it("renders a null token count as zero rather than as null", () => {
    const out = render(
      { id: "x" },
      { result: textResult("hi", { input_tokens: null, output_tokens: 5, total_tokens: 5 }) },
    );
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 5, total_tokens: 5 });
  });

  it("renders a non-numeric token count as zero", () => {
    const out = render({ id: "x" }, { result: textResult("hi", { input_tokens: "11" }) });
    expect((out.usage as Record<string, unknown>).input_tokens).toBe(0);
  });

  it("renders MediaResult frames as image_generation_call items", () => {
    const frames = [
      { b64: "iVBORw0KGgo=", content_type: "image/png" },
      { b64: "AAECAwQ=", content_type: "image/png" },
    ];
    const out = render({ id: "0xabc", status: "queued" }, { result: mediaResult(frames) });
    expect(out.status).toBe("completed");
    const item = (i: number, b64: unknown) => ({
      type: "image_generation_call",
      id: `ig_0xabc_${i}`,
      status: "completed",
      result: b64,
    });
    expect(out.output).toEqual([item(0, frames[0]!.b64), item(1, frames[1]!.b64)]);
  });

  it("passes a frame's base64 through without a decode round trip", () => {
    // Deliberately not canonical base64. Nothing on this path decodes it, so it
    // arrives at the consumer exactly as the provider sealed it; a render that
    // decoded to re-encode would change or reject this string.
    const b64 = "not~canonical~base64";
    const out = render({ id: "j" }, { result: mediaResult([{ b64 }]) });
    expect((out.output as Record<string, unknown>[])[0]!.result).toBe(b64);
  });

  it("renders an EmbeddingResult honestly, with no output and no usage", () => {
    const out = render({ id: "x", status: "completed" }, { result: embeddingResult() });
    expect(out.output).toEqual([]);
    expect("usage" in out).toBe(false);
    expect(out.status).toBe("completed");
  });

  it("reports the end cause a failed row carries under vorq", () => {
    const out = render({ id: "x", status: "failed", vorq: { ended_because: 3 } });
    const error = out.error as Record<string, unknown>;
    expect(error.code).toBe("provider_fail");
    expect(error.message).toBe("job x failed (provider_fail)");
  });

  it("reports the end cause a cancelled row carries under vorq", () => {
    const out = render({ id: "x", status: "cancelled", vorq: { ended_because: 2 } });
    expect((out.error as Record<string, unknown>).code).toBe("cancelled");
  });

  it("lets an explicit error object win verbatim", () => {
    const error = { code: "explicit", message: "m" };
    const out = render({ id: "x", status: "cancelled", error });
    expect(out.error).toBe(error);
  });

  it("lets an explicit error win over the row's own end cause", () => {
    const error = { code: "explicit", message: "m" };
    const out = render({ id: "x", status: "failed", error, vorq: { ended_because: 3 } });
    expect(out.error).toBe(error);
  });

  it("omits the error entirely when the explicit one is empty", () => {
    // `vorq` carries a cause the row could have fallen back on, and it is
    // deliberately not read: an explicit `error` object is the authority on this
    // row's error even when it is empty, so `error.code` — `undefined` — is the
    // cause, and there is none. Checked against the authority, which reaches the
    // same answer by `{}` being falsy and `{}.get("code")` being `None`.
    const out = render({ id: "x", status: "failed", error: {}, vorq: { ended_because: 3 } });
    expect("error" in out).toBe(false);
  });

  it("omits the error when nothing names a cause", () => {
    expect("error" in render({ id: "x", status: "failed" })).toBe(false);
  });

  it("omits the error when the cause code is one this SDK does not know", () => {
    expect("error" in render({ id: "x", status: "failed", vorq: { ended_because: 99 } })).toBe(
      false,
    );
  });

  it("never renders an error on a status that did not end badly", () => {
    for (const status of ["completed", "queued", "in_progress"]) {
      const job = { id: "x", status, error: { code: "e", message: "m" } };
      expect("error" in render(job), status).toBe(false);
    }
  });

  it("ignores an error member that is not an object and reads the row's cause", () => {
    // An array is not an error object, so the row's own cause is read instead.
    // The authority agrees on this fixture — it gates its own read on
    // `isinstance(error, dict)` too.
    const out = render({ id: "x", status: "failed", error: ["boom"], vorq: { ended_because: 4 } });
    expect((out.error as Record<string, unknown>).code).toBe("reclaim");
  });

  it("omits the error when a non-object error is all the row names (D15)", () => {
    // The fixture that actually separates this port from the authority: with no
    // `vorq` to fall back on, Python's `if error or cause` fires on the truthy
    // string and renders `{"code": None, "message": "job x failed (None)"}` — a
    // cause that names nothing. Omitting the key says the same thing honestly.
    expect("error" in render({ id: "x", status: "failed", error: "boom" })).toBe(false);
    expect("error" in render({ id: "x", status: "cancelled", error: 7 })).toBe(false);
  });

  it("defaults metadata, vorq, incomplete_details and background", () => {
    const out = render({ id: "x" }, { background: true });
    expect(out.metadata).toEqual({});
    expect(out.vorq).toEqual({});
    expect(out.incomplete_details).toBeNull();
    expect(out.background).toBe(true);
    expect(out.output).toEqual([]);
    expect(render({ id: "x" }, { background: false }).background).toBe(false);
  });

  it("passes a populated metadata and vorq through", () => {
    const job = { id: "x", metadata: { k: "v" }, vorq: { sla_secs: 3600 } };
    const out = render(job);
    expect(out.metadata).toBe(job.metadata);
    expect(out.vorq).toBe(job.vorq);
  });

  it("renders an empty metadata as a fresh object rather than the row's", () => {
    const job = { id: "x", metadata: {}, vorq: {} };
    const out = render(job);
    expect(out.metadata).toEqual({});
    expect(out.metadata).not.toBe(job.metadata);
    expect(out.vorq).not.toBe(job.vorq);
  });

  it("renders an empty-array metadata as {}, as Python's `or` does", () => {
    const out = render({ id: "x", metadata: [], vorq: [] });
    expect(out.metadata).toEqual({});
    expect(out.vorq).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Group E — errorResponse and jsonResponse
// ---------------------------------------------------------------------------

describe("errorResponse", () => {
  const body = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;

  it("restates a local refusal as a 400 the openai package will not retry", async () => {
    const response = errorResponse(new ValidationError("nope"));
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: { message: "nope", type: "invalid_request_error" },
    });
    expect(response.headers.has("x-should-retry")).toBe(false);
  });

  it("preserves the status and type a wire error arrived on", async () => {
    const response = errorResponse(
      new VorqError("slow down", { statusCode: 429, type: "rate_limited" }),
    );
    expect(response.status).toBe(429);
    expect((await body(response)).error).toEqual({ message: "slow down", type: "rate_limited" });
  });

  it("opts a route out of the package's retry policy on request", () => {
    const error = new VorqError("slow down", { statusCode: 429, type: "rate_limited" });
    expect(errorResponse(error, { retryable: false }).headers.get("x-should-retry")).toBe("false");
    expect(errorResponse(error, { retryable: true }).headers.has("x-should-retry")).toBe(false);
  });

  it("relays a request id when the error carries one", () => {
    const error = new VorqError("boom", { requestId: "req_1" });
    expect(errorResponse(error).headers.get("x-request-id")).toBe("req_1");
  });

  it("sets no request id header when the error carries none", () => {
    expect(errorResponse(new VorqError("boom")).headers.has("x-request-id")).toBe(false);
    expect(
      errorResponse(new VorqError("boom", { requestId: "" })).headers.has("x-request-id"),
    ).toBe(false);
  });

  it("treats a status code of 0 as no status at all", () => {
    expect(errorResponse(new VorqError("boom", { statusCode: 0 })).status).toBe(400);
  });

  it("renders a status-less gateway failure as 400, as the authority does", () => {
    // Not a request-shape refusal — nothing answered — but still a 400, and
    // reachable: `fetchBlob` raises exactly this when the gateway connection
    // fails, and the retrieve path opens a named result through it. The
    // authority converts the same failure to a status-less
    // `VorqError(type="api_error")` (`_client.py:1096-1099`) and renders it the
    // same way. `TransportError` is the one status-less error that must not
    // reach here at all (D17); Task 3 rethrows it.
    const gateway = new VorqError("gateway read of bafy… could not reach https://g", {
      type: "api_error",
    });
    expect(gateway.statusCode).toBeNull();
    expect(errorResponse(gateway).status).toBe(400);
  });

  it("defaults the type but never the message", async () => {
    const response = errorResponse(new VorqError("boom", { statusCode: 500 }));
    expect((await body(response)).error).toEqual({
      message: "boom",
      type: "invalid_request_error",
    });
  });

  it("treats an empty wire type as no type at all", async () => {
    // Reachable, not hypothetical: `errorFromWire` keeps a wire `error.type`
    // whenever it is a string, and `""` is a string. `??` would emit
    // `"type": ""` and hand the openai package a discriminator matching no
    // exception class; the authority's `exc.type or …` does not.
    const wire = errorFromWire(500, { error: { message: "boom", type: "" } }, {
      requestId: null,
    });
    expect(wire.type).toBe("");
    expect((await body(errorResponse(wire))).error).toEqual({
      message: "boom",
      type: "invalid_request_error",
    });
  });

  it("always answers as json", () => {
    for (const error of [
      new ValidationError("a"),
      new VorqError("b", { statusCode: 429, requestId: "r" }),
    ]) {
      expect(errorResponse(error).headers.get("content-type")).toBe("application/json");
    }
  });
});

describe("jsonResponse", () => {
  it("serializes the body and declares json", async () => {
    const response = jsonResponse(200, { a: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("lets a caller add headers without losing the content type", () => {
    const response = jsonResponse(429, {}, { "x-request-id": "r" });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-request-id")).toBe("r");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("lets a caller's own content-type win over the default", () => {
    // The spread order is the precedence rule: `application/json` is a default,
    // not a floor. A forward relays the content-type of the answer it is
    // relaying, and that answer is not always json — a file's bytes are not.
    const response = jsonResponse(200, {}, { "content-type": "application/octet-stream" });
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// sealingFetch — forwarding, refusal, and the shape of the function itself
// ---------------------------------------------------------------------------

/**
 * The `create`/`retrieve`/`cancel` intercepts are Task 3b; everything here is
 * the dispatch, the deny path, and `forward`.
 *
 * The two base URLs differ on purpose and the difference is the point: the
 * `openai` package builds `https://compat.test/v1/...`, which is the path the
 * dispatch matches on, while the `Client` underneath talks to `http://node`.
 */
describe("sealingFetch — forwarding and refusal", () => {
  const AT = "https://compat.test";

  /** A `sealingFetch` over the harness client, plus that client's call log. */
  function surface(routes: Route[] = baseRoutes()) {
    const { client: c, calls } = client(routes);
    return { fetch: sealingFetch({ client: c }), calls };
  }

  // -- forward --------------------------------------------------------------

  it("forwards a content-free read", async () => {
    const { fetch, calls } = surface();
    const response = await fetch(`${AT}/v1/models`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(MODELS);
    expect(calls.some((c) => c.url.endsWith("/v1/models"))).toBe(true);
  });

  it("preserves a forwarded request body", async () => {
    // A regression pin: an earlier authority dropped the body on the forward
    // path, so every batch create reached the node as `{}` and was refused for
    // a reason that had nothing to do with the caller.
    const { fetch, calls } = surface([
      ...baseRoutes(),
      [/\/v1\/batches$/, (_n, body) => json({ echoed: body })],
    ]);
    await fetch(`${AT}/v1/batches`, {
      method: "POST",
      body: JSON.stringify({ marker: "round-trip", n: 7 }),
    });

    const sent = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/batches"));
    expect(sent?.body).toEqual({ marker: "round-trip", n: 7 });
  });

  it("forwards query parameters", async () => {
    const { fetch, calls } = surface([...baseRoutes(), [/\/v1\/batches\?/, () => json({ data: [] })]]);
    await fetch(`${AT}/v1/batches?limit=2&after=b_9`);

    const sent = calls.find((c) => c.url.includes("/v1/batches?"));
    expect(sent?.url).toContain("limit=2");
    expect(sent?.url).toContain("after=b_9");
  });

  it("relays x-request-id and nothing else", async () => {
    const { fetch } = surface([
      ...baseRoutes(),
      [
        /\/v1\/batches\/b_1$/,
        () =>
          json({ id: "b_1" }, 200, {
            "x-request-id": "req_1",
            "x-vorq-next-offset": "100",
            "x-coordinator-internal": "leaked",
          }),
      ],
    ]);
    const response = await fetch(`${AT}/v1/batches/b_1`);

    expect(response.headers.get("x-request-id")).toBe("req_1");
    expect(response.headers.get("x-vorq-next-offset")).toBeNull();
    expect(response.headers.get("x-coordinator-internal")).toBeNull();
  });

  it("returns a file's bytes verbatim rather than re-encoding them", async () => {
    // A batch output file is JSONL, not JSON. A forward that parsed and
    // re-serialized would hand the caller a different document.
    const LINES = '{"line": 1}\n{"line": 2}\n';
    const { fetch } = surface([
      ...baseRoutes(),
      [
        /\/v1\/files\/f_1\/content$/,
        () => new Response(LINES, { status: 200, headers: { "content-type": "application/jsonl" } }),
      ],
    ]);
    const response = await fetch(`${AT}/v1/files/f_1/content`);

    expect(await response.text()).toBe(LINES);
    expect(response.headers.get("content-type")).toBe("application/jsonl");
  });

  it("drops the caller's Authorization and re-authenticates underneath", async () => {
    // Session auth rides the wallet, minted and rotated by the client, so a
    // forwarded call re-authenticates rather than replaying whatever token the
    // `openai` package was constructed with.
    const { fetch, calls } = surface();
    await fetch(`${AT}/v1/models`, { headers: { authorization: "Bearer sk-caller-secret" } });

    const sent = calls.find((c) => c.url.endsWith("/v1/models"));
    const auth = new Headers(sent?.init.headers).get("authorization");
    expect(auth).not.toBe("Bearer sk-caller-secret");
    expect(auth).toContain("t");
  });

  it("refuses a forwarded body that is not JSON rather than throwing SyntaxError", async () => {
    const { fetch } = surface();
    const response = await fetch(`${AT}/v1/batches`, { method: "POST", body: "{oops" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toContain("not valid JSON");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // -- retry suppression, which `forward` alone decides ---------------------

  it("marks a failed batch create non-retryable and a failed batch read retryable", async () => {
    // `POST /v1/batches` creates a batch, so a replay bills twice; every other
    // forwarded route is a read or an idempotent cancel. The `openai` package
    // reads `x-should-retry` ahead of the status, so its absence is what leaves
    // normal retry behaviour in place.
    const failing: Route[] = [
      ...baseRoutes(),
      [/\/v1\/batches/, () => json({ error: { message: "busy", type: "rate_limited" } }, 429)],
    ];

    const created = await surface(failing).fetch(`${AT}/v1/batches`, {
      method: "POST",
      body: JSON.stringify({ n: 1 }),
    });
    expect(created.status).toBe(429);
    expect(created.headers.get("x-should-retry")).toBe("false");

    const read = await surface(failing).fetch(`${AT}/v1/batches`);
    expect(read.status).toBe(429);
    expect(read.headers.get("x-should-retry")).toBeNull();
  });

  // -- deny -----------------------------------------------------------------

  /**
   * Every OpenAI surface that carries a prompt, plus one invented after this
   * test was written. The last row is the whole argument for a forward list:
   * the surface grows, and a list of what must NOT be sent can never be shown
   * complete.
   */
  const PROMPT_PATHS = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/moderations",
    "/v1/threads",
    "/v1/files",
    "/v1/vector_stores",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/images/variations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/threads/thread_abc/messages",
    "/v1/vector_stores/vs_abc/files",
    "/v1/realtime/sessions",
    "/v1/conversations",
    "/v1/assistants/asst_abc",
    "/v1/some/surface/invented/after/this/test",
  ];

  it.each(PROMPT_PATHS)("refuses %s without transmitting it", async (path) => {
    // The client is built over an EMPTY routing table: anything that reaches
    // `fetch` throws "no route", so a leak fails loudly rather than silently.
    const { client: c, calls } = client([]);
    const response = await sealingFetch({ client: c })(`${AT}${path}`, {
      method: "POST",
      body: JSON.stringify({ model: "m", input: "secret prompt" }),
    });

    // Asserted FIRST. A test that checks the status first still passes when the
    // body went out and the node happened to answer 400.
    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain(path);
    expect(body.error.message).toContain("was not sent");
    expect(body.error.message).toContain(
      path.startsWith("/v1/files") ? "client.batches.submit" : "/v1/responses",
    );
  });

  it.each(["/api/v1/responses", "/api/v1/chat/completions"])(
    "refuses the mount-prefixed %s, including Responses itself",
    async (path) => {
      const { client: c, calls } = client([]);
      const response = await sealingFetch({ client: c })(`${AT}${path}`, {
        method: "POST",
        body: JSON.stringify({ model: "m", input: "secret prompt" }),
      });

      expect(calls).toEqual([]);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        "was not sent",
      );
    },
  );

  /**
   * The edges of the forward table, method by method and segment by segment.
   * `POST /v1/jobs` is the row that matters: it is the submission route, and
   * forwarding it would post an unsealed order.
   */
  const BOUNDARIES: [string, string][] = [
    ["POST", "/v1/jobs"],
    ["POST", "/v1/models"],
    ["DELETE", "/v1/batches/batch_1"],
    ["GET", "/v1/batches/batch_1/cancel"],
    ["POST", "/v1/files/file_1/content"],
    ["GET", "/v1/jobs/"],
    ["GET", "/v1/batches/batch_1/extra"],
    ["GET", "/v1/files//content"],
  ];

  it.each(BOUNDARIES)("refuses %s %s", async (method, path) => {
    const { client: c, calls } = client([]);
    const response = await sealingFetch({ client: c })(`${AT}${path}`, { method });

    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "was not sent",
    );
  });

  // -- the shape of the function itself -------------------------------------

  it("accepts a string, a URL and a Request alike", async () => {
    // `Fetch` admits all three and the `openai` package happens to pass a
    // string. A caller may pass either of the others, and a `.pathname` read
    // off the wrong shape is a TypeError rather than a refusal.
    const denied = `${AT}/v1/chat/completions`;
    for (const input of [denied, new URL(denied), new Request(denied, { method: "POST" })]) {
      const { client: c, calls } = client([]);
      const response = await sealingFetch({ client: c })(input, { method: "POST" });
      expect(calls).toEqual([]);
      expect(response.status).toBe(400);
    }
  });

  it("refuses to be built with both a client and construction options", () => {
    const { client: c } = client([]);
    // A plain `Error`: argument validation of a caller-supplied value, not a
    // wire or protocol condition, so a caller catching `VorqError` around their
    // own request does not swallow their own configuration bug.
    expect(() => sealingFetch({ client: c, baseUrl: "http://elsewhere" })).toThrow(Error);
    expect(() => sealingFetch({ client: c, baseUrl: "http://elsewhere" })).not.toThrow(VorqError);
    expect(() => sealingFetch({ client: c, baseUrl: "http://elsewhere" })).toThrow(/not both/);
  });

  it("does not read the body of a request it refuses", async () => {
    // **The module's central property, and `calls` cannot see it.** A deny test
    // that only asserts nothing reached the node still passes when the body was
    // read locally first, because reading it touches no `fetch`. So the body is
    // a stream that records being pulled: refusing must leave `pulled` false.
    let pulled = false;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ input: "secret prompt" })));
          controller.close();
        },
      },
      // `highWaterMark: 0`, or the stream pulls once at construction to fill its
      // own queue and the flag is true before `sealingFetch` is even called —
      // an instrument that reports a leak nobody performed.
      { highWaterMark: 0 },
    );

    const { client: c, calls } = client([]);
    const response = await sealingFetch({ client: c })(`${AT}/v1/chat/completions`, {
      method: "POST",
      body,
    } as RequestInit);

    expect(pulled).toBe(false);
    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
  });

  it("normalizes a lowercase method before matching", async () => {
    // `Fetch` does not promise an uppercase method, and the forward table
    // compares exactly. Un-normalized, `get` matches no row and a content-free
    // read is refused for a reason that has nothing to do with the caller.
    const { fetch, calls } = surface();
    const response = await fetch(`${AT}/v1/models`, { method: "get" });

    expect(response.status).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/v1/models"))).toBe(true);
  });

  it("rethrows a TransportError rather than rendering it as a 400 (D17)", async () => {
    // D17: the authority's submit-path transport failures escape the transport
    // entirely, so the `openai` package reports `APIConnectionError` and retries
    // it. Rendered as a 400 here, a dropped connection would never be retried —
    // the package reads 400 as final.
    // The throwing route goes FIRST: `scriptedFetch` matches in order, and
    // `baseRoutes` already answers `/v1/models`, so appending would leave this
    // unreachable and the test would pass on a 200.
    const { client: c } = client([
      [
        /\/v1\/models/,
        () => {
          throw new TypeError("fetch failed");
        },
      ],
      ...baseRoutes(),
    ]);

    await expect(sealingFetch({ client: c })(`${AT}/v1/models`)).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it("reuses one client across calls rather than rebuilding it per request", async () => {
    // The session token, the chain context and the verified escrow key all
    // survive between calls only because the client does. A fresh client per
    // request would re-mint the token on every forward.
    const { fetch, calls } = surface();
    await fetch(`${AT}/v1/models`);
    await fetch(`${AT}/v1/models`);

    expect(calls.filter((c) => c.url.includes("/auth/session"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sealingFetch — the three sealed intercepts
// ---------------------------------------------------------------------------

/**
 * `create`, `retrieve` and `cancel`: the routes that do not forward, because
 * every one of them runs the native sealed-job flow underneath.
 *
 * Driven through the submission suites' own scripted node — the signing-path
 * fixtures live in `submit-harness.ts` and there is exactly one copy of each. A
 * second copy drifts, and a drifted signing-path fixture proves nothing.
 */
describe("sealingFetch — create, retrieve and cancel", () => {
  const AT = "https://compat.test";
  /** A settled job's CID, and the only name the gateway route answers to. */
  const CID = "bafyresult";
  /** A valid `bytes32`, because a cancel signs `Cancel(jobId, issuedAt)` over it. */
  const JOB = `0x${"ab".repeat(32)}`;

  /** Result bytes sealed to the harness client's own result key. */
  const sealedBlob = (body: unknown): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        enc: SEALED_RESULT_VERSION,
        ciphertext: Buffer.from(
          seal(curvePublicKey(RESULT_KEY), new TextEncoder().encode(JSON.stringify(body))),
        ).toString("base64"),
      }),
    );

  const TEXT_BODY = {
    output: [{ content: [{ type: "output_text", text: "the sealed answer" }] }],
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
  };

  interface NodeOptions {
    /** Merged over the settled row every `GET /v1/jobs/{id}` answers. */
    row?: Record<string, unknown>;
    /**
     * Answer the accepted `POST /v1/jobs` with a body that is not JSON — a
     * gateway's HTML on a 201. The job is posted and paid for either way, and
     * `Client.submit` keeps the handle with an empty row.
     */
    unreadableReceipt?: boolean;
    /** What the gateway serves under the settled job's CID. */
    blob?: Uint8Array;
    /** What `POST /v1/jobs/{id}/cancel` answers. */
    cancelReceipt?: unknown;
    /** The status every `POST /v1/jobs` answers, with an error envelope. */
    submitStatus?: number;
    /** The status every `GET /v1/jobs/{id}` answers, with an error envelope. */
    readStatus?: number;
    /** Announce a verified escrow key, so an OPEN order can rest. */
    escrow?: boolean;
  }

  /**
   * The scripted node a sealed intercept talks to: the five base routes, the
   * two-phase `POST /v1/jobs`, the job read, the signed cancel door, and the
   * gateway the settled result is fetched from.
   */
  function sealedNode(options: NodeOptions = {}) {
    const blob = options.blob ?? sealedBlob(TEXT_BODY);
    const wire = (status: number) =>
      json({ error: { message: `HTTP ${status}`, type: "coordinator_said_so" } }, status);
    const built = client(
      [
        ...(options.escrow === true
          ? ([[/\/key$/, () => json(announcement({ key: RECIPIENT_PUBLIC }))]] as Route[])
          : []),
        ...baseRoutes(),
        [
          /\/v1\/jobs$/,
          (n, body) => {
            if (options.submitStatus !== undefined) return wire(options.submitStatus);
            const order = body as { job_id: string; expires_at: number };
            const jobId = order.job_id;
            if (n === 1) return json(QUOTE(jobId, BigInt(order.expires_at)), 402);
            if (options.unreadableReceipt === true) {
              return new Response("<html>gateway</html>", {
                status: 201,
                headers: { "content-type": "text/html" },
              });
            }
            // What the coordinator actually answers a complete submission with:
            // `{job_id, task_cid, tx_hash}` at 201, and nothing else. No
            // `status`, no `created_at`, no terms.
            return json({ job_id: jobId, task_cid: "bafytask", tx_hash: "0x1" }, 201);
          },
        ],
        [
          /\/v1\/jobs\/[^/]+\/cancel$/,
          (_n, _body, url) =>
            json(
              options.cancelReceipt ?? {
                job_id: url.split("/").slice(-2)[0],
                tx_hash: "0xcafe",
              },
            ),
        ],
        [
          /\/v1\/jobs\/[^/?]+$/,
          (_n, _body, url) => {
            if (options.readStatus !== undefined) return wire(options.readStatus);
            return json({
              id: url.split("/").pop(),
              object: "job",
              status: "completed",
              result_cid: CID,
              vorq: {
                sla_secs: 3600,
                rate_in: "5",
                rate_out: "9",
                provider_id: 1,
                ended_because: 0,
                gas_fee: "0.03", fee: "0",
              },
              ...options.row,
            });
          },
        ],
        [/\/ipfs\//, () => new Response(blob as BodyInit, { status: 200 })],
      ],
      {
        gateway: "http://gw",
        ...(options.escrow === true
          ? {
              verifier: new Verifier("http://chain", {
                mode: "mock",
                wallClock: () => NOW,
                fetch: scriptedNode({ entries: () => ESCROW_ACTIVE }).fetch,
              }),
            }
          : {}),
      },
    );
    return { ...built, fetch: sealingFetch({ client: built.client }) };
  }

  /** `POST /v1/responses` with a JSON body, the way the `openai` package sends it. */
  const post = (fetch: SealingFetch, body: unknown) =>
    fetch(`${AT}/v1/responses`, { method: "POST", body: JSON.stringify(body) });

  /**
   * The container the funded submission carried, and the terms it was signed
   * under. Both are read off JSON bodies now — the challenge keeps the order's
   * own types, and the paid submission's `container` is base64, decoded back
   * to bytes here.
   */
  const submitted = (calls: Call[]) => {
    const order = posts(calls)[0]!.body as Record<string, string | number>;
    const { container } = funded(calls)[0]!.body as { container: string };
    return { order, envelope: openEnvelope(Buffer.from(container, "base64"), order.owner as string) };
  };

  // -- create ---------------------------------------------------------------

  it("takes the market in the 1h window when the create names no vorq block", async () => {
    const h = sealedNode();
    const response = await post(h.fetch, { model: "m", input: "hi" });

    expect(response.status).toBe(200);
    const { order } = submitted(h.calls);
    // marketCandidate(1): the node's first pick, at its own ask, pinned.
    expect([order.rate_in, order.rate_out, order.designated, order.sla_secs]).toEqual([
      "0.001",
      "0.002",
      1,
      3600,
    ]);
  });

  it("seals, submits and unseals a synchronous create", async () => {
    const PROMPT = "the prompt nobody upstream may read";
    const h = sealedNode();
    const response = await post(h.fetch, {
      model: "m",
      input: PROMPT,
      max_output_tokens: 64,
      temperature: 0.2,
      vorq: { provider: 1 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("m");
    expect(body.background).toBe(false);
    expect(body.output).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "the sealed answer" }],
      },
    ]);
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 22, total_tokens: 33 });
    // The settled row was rendered, not a literal stand-in: the terms are the
    // coordinator's own, and a `{id, status}` stand-in renders `vorq` as `{}`.
    expect(body.vorq).toEqual({
      sla_secs: 3600,
      rate_in: "5",
      rate_out: "9",
      provider_id: 1,
      ended_because: 0,
      gas_fee: "0.03", fee: "0",
    });

    // **The secrecy property.** Every request param is inside the container and
    // nowhere else on the body the coordinator reads.
    const { order, envelope } = submitted(h.calls);
    expect(envelope.input).toEqual({
      input: PROMPT,
      max_output_tokens: 64,
      temperature: 0.2,
    });
    // The container is excised before the scan, and not for convenience: it is
    // base64 over a random seed, so at some rate it contains any short needle,
    // and a suite that flakes on `"dek"` proves nothing about disclosure. What
    // it *is* is opaque — `openEnvelope` above needed the recipient's secret.
    const onTheWire = JSON.stringify(
      posts(h.calls).map((c) => ({ ...(c.body as object), container: "<sealed>" })),
    );
    for (const needle of [PROMPT, "max_output_tokens", "temperature", "input", "dek"]) {
      expect(onTheWire).not.toContain(needle);
    }
    // Everything the order does declare is terms, and terms are public.
    expect(order.job_id).toBe(body.id);
  });

  it("carries the vorq block's ceilings and window into the order, which signs the ask", async () => {
    const h = sealedNode();
    await post(h.fetch, {
      model: "m",
      input: "hi",
      vorq: { provider: 1, max_rate_in: "1", max_rate_out: "2.5", sla: "24h" },
    });

    const { order, envelope } = submitted(h.calls);
    expect(probes(h.calls)[0]!.body).toMatchObject({ max_rate_in: "1", max_rate_out: "2.5" });
    // Provider 1's ask, which is under both ceilings.
    expect(order.rate_in).toBe("0.001");
    expect(order.rate_out).toBe("0.002");
    // The window the block named, on the signed terms — not the "1h" default.
    expect(order.sla_secs).toBe(86400);
    expect(order.designated).toBe(1);
    // The ceilings are the coordinator's business and the payload is not: neither
    // the rates nor the SLA are inside the seal.
    expect(JSON.stringify(envelope)).not.toContain("rate_in");
    expect(envelope.input).toEqual({ input: "hi" });
  });

  it("maps a list input onto messages", async () => {
    const h = sealedNode();
    await post(h.fetch, {
      model: "m",
      input: [{ role: "user", content: "hi" }],
      vorq: { provider: 1 },
    });

    const payload = submitted(h.calls).envelope.input as Record<string, unknown>;
    expect(payload.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(payload).not.toHaveProperty("input");
  });

  it("refuses an open order without a verifier and signs nothing", async () => {
    // An open order seals to the coordinator's escrow key, and a client with no
    // verifier has no way to check that key's evidence. The refusal names the
    // remedy; discovery reads may already have happened, but nothing was signed
    // and no submission was posted.
    const h = sealedNode();
    const response = await post(h.fetch, {
      model: "m",
      input: "secret prompt",
      vorq: { max_rate_in: "0.0001", max_rate_out: "0.0001" },
    });

    expect(posts(h.calls)).toEqual([]);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("verifier");
  });

  it("rests an open order on a transport whose client has a verifier", async () => {
    const h = sealedNode({ escrow: true });
    const response = await post(h.fetch, { model: "m", input: "hi", vorq: { max_rate_in: "0.0001", max_rate_out: "0.0001" } });

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
    // `0` — the contract's own sentinel for "any provider".
    expect(submitted(h.calls).order.designated).toBe(0);
  });

  it("shapes an unopenable result into an error response rather than an exception", async () => {
    const h = sealedNode({
      blob: new TextEncoder().encode(
        JSON.stringify({ enc: SEALED_RESULT_VERSION, ciphertext: "AAAA" }),
      ),
    });
    const response = await post(h.fetch, { model: "m", input: "hi", vorq: { provider: 1 } });

    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("result_integrity");
  });

  it("renders a JobFailed as a failed response rather than throwing", async () => {
    const h = sealedNode({
      row: { status: "failed", result_cid: null, vorq: { sla_secs: 3600, ended_because: 3, gas_fee: "0.03", fee: "0" } },
    });
    const response = await post(h.fetch, { model: "m", input: "hi", vorq: { provider: 1 } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; error: { code: string } };
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("provider_fail");
  });

  // -- the local refusals, which never reach the network --------------------

  it.each([{}, { model: null }, { model: "" }, { model: 7 }])(
    "refuses a create with no usable model (%j)",
    async (over) => {
      const { client: c, calls } = client([]);
      const response = await post(sealingFetch({ client: c }), { input: "hi", ...over });

      expect(calls).toEqual([]);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        "'model' is required",
      );
    },
  );

  it.each([
    [{ stream: true }, "streaming is not available"],
    [{ metadata: { k: "v" } }, "'metadata' is not carried"],
  ])("refuses %j rather than dropping it", async (over, expected) => {
    // Rejected, not quietly dropped. Accepting `stream` would hand the `openai`
    // package a non-SSE 200, which it reads as an empty event stream; accepting
    // `metadata` and echoing `{}` back reads as stored.
    const { client: c, calls } = client([]);
    const response = await post(sealingFetch({ client: c }), { model: "m", input: "hi", ...over });

    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      expected,
    );
  });

  it.each([
    [{ sla: 3600 }, "'vorq.sla' must be a window string"],
    [{ sla: { hours: 1 } }, "'vorq.sla' must be a window string"],
    [{ provider: "1" }, "'vorq.provider' must be a provider id number"],
    [{ provider: true }, "'vorq.provider' must be a provider id number"],
  ])("refuses a vorq block carrying a wrong-typed %j (D19/D20)", async (block, expected) => {
    // Neither falls back. A defaulted `sla` signs a window the caller did not
    // ask for; a dropped `provider` re-targets the order to the coordinator's
    // escrow key instead of the provider named, which changes who can read the
    // payload. Both are refused before anything is sealed.
    const { client: c, calls } = client([]);
    const response = await post(sealingFetch({ client: c }), {
      model: "m",
      input: "secret prompt",
      vorq: block,
    });

    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      expected,
    );
  });

  it.each([{ sla: null }, { sla: "" }, { provider: null }])(
    "still defaults a falsy vorq member (%j), as Python's `or` does",
    async (block) => {
      // `None or "1h"` and `.get("provider") -> None` are the authority's own
      // answers for these, and they are falsiness rather than a type error.
      // Only a wrong *type* is refused above.
      const h = sealedNode({ escrow: true });
      const response = await post(h.fetch, { model: "m", input: "hi", vorq: block });

      expect(response.status).toBe(200);
      expect(submitted(h.calls).order.sla_secs).toBe(3600);
    },
  );

  it("accepts an empty metadata object, which Python's truthiness lets through", async () => {
    // `{}` is falsy in the authority, so `if body.get("metadata")` does not fire
    // on it. A port testing `!== undefined` would refuse a body the `openai`
    // package sends by default.
    const h = sealedNode();
    const response = await post(h.fetch, {
      model: "m",
      input: "hi",
      metadata: {},
      vorq: { provider: 1 },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
    // Dropped from the payload rather than sealed into it: it is a job param
    // this surface does not carry, in either direction.
    expect(submitted(h.calls).envelope.input).toEqual({ input: "hi" });
  });

  // -- background -----------------------------------------------------------

  it("returns queued immediately on a background create", async () => {
    // **M9's background leg is an equivalent mutant and is left as one.** The
    // coordinator's accepted `POST /v1/jobs` answers `{job_id, task_cid,
    // tx_hash}` and nothing more, and `responseObject` renders only `id` and
    // `status` off it — both of which the literal stand-in
    // `{id: handle.id, status: "queued"}` reproduces exactly, because
    // `handle.id` IS the locally computed `job_id`. So on a faithful fixture
    // the two branches are indistinguishable, and the only way to tell them
    // apart is to invent a wire field the node does not send. M9 is killed on
    // the sync leg instead, where the settled row really does carry terms.
    const h = sealedNode();
    const response = await post(h.fetch, {
      model: "m",
      input: "hi",
      background: true,
      vorq: { provider: 1 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;
    expect(body.status).toBe("queued");
    expect(body.background).toBe(true);
    // Nothing was waited on: no job read, and no gateway fetch.
    expect(h.calls.filter((c) => /\/v1\/jobs\/[^/]+$/.test(c.url))).toEqual([]);
    expect(h.calls.filter((c) => c.url.includes("/ipfs/"))).toEqual([]);
  });

  it("renders a queued response when the accepted receipt is unreadable", async () => {
    // The job is posted and **paid for**: `Client.submit` keeps the handle and
    // leaves `row` as `{}` when a 201 body is a gateway's HTML, because an
    // unreadable body "is not a reason to lose it". `{}` is falsy to the
    // authority and falls through to the literal, so the caller gets the job id
    // back and can retrieve it. Rendered with `??` instead, that `{}` reaches
    // `responseObject`, which refuses it as naming no job — a non-retryable 400
    // for a job that exists, and one the 400 cannot even name.
    const h = sealedNode({ unreadableReceipt: true });
    const response = await post(h.fetch, {
      model: "m",
      input: "hi",
      background: true,
      vorq: { provider: 1 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.id).toBe(submitted(h.calls).order.job_id);
  });

  it("retrieves a settled job and opens its result", async () => {
    const h = sealedNode();
    const created = (await (
      await post(h.fetch, { model: "m", input: "hi", background: true, vorq: { provider: 1 } })
    ).json()) as { id: string };

    const response = await h.fetch(`${AT}/v1/responses/${created.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      status: string;
      background: boolean;
      output: { content: { text: string }[] }[];
    };
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("completed");
    expect(body.background).toBe(true);
    expect(body.output[0].content[0].text).toBe("the sealed answer");
  });

  it("renders a settled media job as an image_generation_call", async () => {
    const FRAME = Buffer.from(new Uint8Array([0, 1, 2, 3])).toString("base64");
    const h = sealedNode({
      blob: sealedBlob({ images: [{ b64: FRAME, width: 8, height: 8 }] }),
    });
    const response = await h.fetch(`${AT}/v1/responses/${JOB}`);

    const body = (await response.json()) as {
      status: string;
      output: { type: string; result: string }[];
    };
    expect(body.status).toBe("completed");
    expect(body.output[0].type).toBe("image_generation_call");
    // The frame passes through as base64 — decoding to re-encode would be the
    // same string and twice the work — so it decodes to the sealed bytes.
    expect(Uint8Array.from(Buffer.from(body.output[0]!.result, "base64"))).toEqual(
      new Uint8Array([0, 1, 2, 3]),
    );
  });

  // -- retrieve -------------------------------------------------------------

  it.each(["/v1/responses/", "/v1/responses/r1/input_items", "/v1/responses/r1/extra/deep"])(
    "does not swallow the responses subroute %s",
    async (path) => {
      // The client is built over an EMPTY routing table: anything that reaches
      // `fetch` throws "no route", so a swallowed subroute fails loudly.
      const { client: c, calls } = client([]);
      const response = await sealingFetch({ client: c })(`${AT}${path}`);

      expect(calls).toEqual([]);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        "was not sent",
      );
    },
  );

  it("leaves a failed read retryable", async () => {
    // A read has no effect to duplicate, so the `openai` package's own retry
    // policy is left in place: the absence of `x-should-retry` is what leaves it
    // there.
    const h = sealedNode({ readStatus: 429 });
    const response = await h.fetch(`${AT}/v1/responses/${JOB}`);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBeNull();
  });

  // -- cancel ---------------------------------------------------------------

  it("maps responses.cancel onto the native signed cancel", async () => {
    const h = sealedNode();
    const response = await h.fetch(`${AT}/v1/responses/${JOB}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe("cancelled");
    expect(body.id).toBe(JOB);
    expect(h.calls.some((c) => c.method === "POST" && c.url.endsWith(`/v1/jobs/${JOB}/cancel`))).toBe(
      true,
    );
  });

  it("accepts a relay receipt that is not a job object", async () => {
    // The node's cancel route answers `{job_id, tx_hash}` — no `id`, no
    // `status`, no terms. `cancelled` is asserted rather than re-read, and none
    // of the receipt's own transport detail reaches the caller.
    const h = sealedNode({ cancelReceipt: { job_id: JOB, tx_hash: "0xcafe" } });
    const response = await h.fetch(`${AT}/v1/responses/${JOB}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(JOB);
    expect(body.status).toBe("cancelled");
    expect(body).not.toHaveProperty("tx_hash");
    expect(body).not.toHaveProperty("job_id");
  });

  it("refuses a 2xx cancel naming no job", async () => {
    const h = sealedNode({ cancelReceipt: { tx_hash: "0xcafe" } });
    const response = await h.fetch(`${AT}/v1/responses/${JOB}/cancel`, { method: "POST" });

    // Named as such rather than left to escape as a `TypeError`, which the
    // `openai` package wraps as `APIConnectionError` — blaming the network for a
    // coordinator that answered.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "named no job_id",
    );
  });

  it("signs the cancel body and sends nothing else", async () => {
    const h = sealedNode();
    await h.fetch(`${AT}/v1/responses/${JOB}/cancel`, { method: "POST" });

    const sent = h.calls.find((c) => c.url.endsWith("/cancel"));
    expect(Object.keys(sent!.body as object).sort()).toEqual(["issued_at", "signature"]);
  });

  // -- retry suppression and status fidelity --------------------------------

  it("marks a failed submission non-retryable", async () => {
    // A re-seal produces a fresh job id, so the coordinator's duplicate-id guard
    // cannot collapse the copies: a retried 429 here would mean paying twice for
    // one call.
    const h = sealedNode({ submitStatus: 429 });
    const response = await post(h.fetch, { model: "m", input: "hi", vorq: { provider: 1 } });

    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
  });

  it("rethrows a TransportError raised by a create rather than rendering it (D17)", async () => {
    // `create`'s own catch renders every `VorqError` as a **non-retryable** 400,
    // and a `TransportError` is a status-less `VorqError` — so without the D17
    // leg ahead of it a dropped connection would come back as a 400 the `openai`
    // package never retries, instead of the `APIConnectionError` it does.
    // The throwing route goes FIRST: `scriptedFetch` matches in order.
    const { client: c } = client([
      [
        /\/v1\/jobs$/,
        () => {
          throw new TypeError("fetch failed");
        },
      ],
      ...baseRoutes(),
    ]);
    await expect(
      post(sealingFetch({ client: c }), { model: "m", input: "hi", vorq: { provider: 1 } }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it.each([400, 401, 404, 409, 429, 500, 503])(
    "preserves the coordinator's %i on a create",
    async (status) => {
      const h = sealedNode({ submitStatus: status });
      const response = await post(h.fetch, { model: "m", input: "hi", vorq: { provider: 1 } });

      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
        "coordinator_said_so",
      );
    },
  );
});
