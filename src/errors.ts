/**
 * The VORQ exception hierarchy.
 *
 * **The rule is about the kind of condition, not about the module raising it.**
 *
 * An error describing a **wire or protocol condition** descends from
 * `VorqError`: anything the coordinator said, anything about a container's own
 * format, a result that will not open, a job that settled badly. That is the set
 * the documented catch-all is written for —
 * `catch (e) { if (e instanceof VorqError) … }` — and it is complete for it.
 *
 * **Argument validation of a caller-supplied scalar raises a plain `Error`**: a
 * key of the wrong width, a string that is not hex, an address that is not
 * twenty bytes. There are 23 such sites across `crypto/` and `signer/`, and they
 * are plain deliberately, because **this mirrors the Python SDK**, which raises a
 * bare `ValueError` at every one of the lines they were ported from
 * (`vorq/_container.py:188, 227, 295, 316, 335, 355`). Python draws the line in
 * the same place and even inside the same function: `commitment()` raises
 * `ContainerError` for a `seed_wrap` of the wrong width — the wrap is the offset
 * every reader on the wire splits at — and a plain `ValueError` for a `ct_hash`
 * of the wrong width, which is the caller's own arithmetic. The JS reproduces
 * that split faithfully, and converting these throws would make the two SDKs
 * answer with different error types for identical input.
 *
 * Whether to unify the two under one base is a package-wide decision, and it is
 * deferred to the spec that curates the public error surface — not taken here,
 * one call site at a time.
 *
 * Wire errors are mapped 1:1 from HTTP status codes and the wire `error.type`;
 * the SDK never invents semantics.
 */

import { own } from "./own.js";

export interface VorqErrorOptions {
  type?: string | null;
  requestId?: string | null;
  statusCode?: number | null;
}

export class VorqError extends Error {
  /** The wire `error.type`, or a locally-minted one. */
  readonly type: string | null;
  /** `x-request-id` off the response that carried this error. */
  readonly requestId: string | null;
  /**
   * The HTTP status this arrived on, or `null` when the SDK raised it locally
   * without a round trip. Kept because a surface that has to restate an error
   * as HTTP needs the original — a 429 must stay a 429 and keep its retry
   * semantics.
   */
  readonly statusCode: number | null;

  constructor(message: string, options: VorqErrorOptions = {}) {
    super(message);
    // `new.target` rather than a literal, so every subclass reports its own
    // name without restating it.
    this.name = new.target.name;
    this.type = options.type ?? null;
    this.requestId = options.requestId ?? null;
    this.statusCode = options.statusCode ?? null;
  }
}

/** Bad or missing session token (401). */
export class AuthenticationError extends VorqError {}

/**
 * The request never became an HTTP response: DNS, a refused or reset
 * connection, TLS, or the transport's own timeout.
 *
 * It exists because JavaScript gives a caller nothing to catch. A dropped
 * connection surfaces from `fetch` as a bare `TypeError`, which is
 * indistinguishable from a `TypeError` thrown by a bug in this SDK, and an
 * aborted request surfaces as a `DOMException`. A Python caller writes
 * `except (httpx.TimeoutException, httpx.TransportError)`; this is that, and it
 * is why the class is JS-specific rather than a port of anything.
 *
 * `statusCode` is `null` — there was no status. The original failure is kept as
 * `cause`, so the underlying `TypeError` or `DOMException` is still readable,
 * and the message says which of the two happened: a timeout at the SDK's own
 * bound reads differently from a connection that could not be made.
 *
 * **This never enters the retry loop.** The transport retries only what the
 * coordinator marks retryable, and Python's generic `_request` does not retry
 * transport failures either — its callers opt in per site.
 */
export class TransportError extends VorqError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { type: "transport_error" });
    this.cause = options.cause;
  }
}

/** Unknown job or model id (404). */
export class NotFoundError extends VorqError {}

/** Illegal state transition (409), e.g. cancelling a terminal job. */
export class StateConflictError extends VorqError {}

/** Rejected request (400), e.g. a disallowed param or unknown model. */
export class ValidationError extends VorqError {}

/** Attestation evidence failed client-edge verification. */
export class VerificationError extends VorqError {}

/**
 * The coordinator's escrow key could not be shown to be what it claims.
 *
 * Raised **before** anything is posted, and it is the whole fail-closed
 * contract for an open order: an open order's payload is sealed to that key and
 * to nothing else. There is deliberately no fallback — re-targeting the order
 * at a named provider is the caller's decision, because an SDK that quietly
 * picked one would have turned a fail-closed into a fail-quiet.
 */
export class EscrowKeyUnverified extends VerificationError {}

/**
 * A settled job's result is not readable as a result: the bytes do not decode,
 * or the seal does not open, or a `completed` job names no result at all.
 *
 * Python makes this a `ValueError` as well. JavaScript has no multiple
 * inheritance, so callers discriminate on the class or on `type`.
 */
export class ResultIntegrityError extends VorqError {
  constructor(message: string, options: { requestId?: string | null } = {}) {
    super(message, { type: "result_integrity", requestId: options.requestId ?? null });
  }
}

/**
 * A `result()` bound elapsed. Carries `jobId` so the caller can persist it and
 * re-attach; the work continues on the network and timing out cancels nothing.
 */
export class WaitTimeout extends VorqError {
  readonly jobId: string | null;
  constructor(
    message: string,
    options: { jobId?: string | null; requestId?: string | null } = {},
  ) {
    super(message, { type: "wait_timeout", requestId: options.requestId ?? null });
    this.jobId = options.jobId ?? null;
  }
}

/**
 * A job settled as `failed` or `cancelled`.
 *
 * `errorType` is the canonical cause — `provider_fail` or `reclaim`. A job that
 * was cancelled or that expired is not a failure and carries no cause, so
 * `errorType` is its status, `cancelled`.
 */
export class JobFailed extends VorqError {
  readonly errorType: string;
  readonly jobId: string | null;
  constructor(
    message: string,
    options: { errorType: string; jobId?: string | null; requestId?: string | null },
  ) {
    super(message, { type: options.errorType, requestId: options.requestId ?? null });
    this.errorType = options.errorType;
    this.jobId = options.jobId ?? null;
  }
}

/**
 * A batch ended `failed` — its **input file** was refused. Per-line failures
 * are rows in the error file and never reach a caller as this.
 */
export class BatchFailed extends VorqError {
  readonly batchId: string | null;
  constructor(
    message: string,
    options: { batchId?: string | null; requestId?: string | null } = {},
  ) {
    super(message, { type: "batch_failed", requestId: options.requestId ?? null });
    this.batchId = options.batchId ?? null;
  }
}

const STATUS_MAP: ReadonlyMap<number, new (m: string, o?: VorqErrorOptions) => VorqError> =
  new Map([
    [400, ValidationError],
    [401, AuthenticationError],
    [404, NotFoundError],
    [409, StateConflictError],
  ]);

/**
 * Build the mapped error from a wire response.
 *
 * `body` is the parsed envelope `{"error": {message, type, ...}}`; a missing or
 * malformed one degrades to `HTTP <status>` rather than throwing while building
 * an error, which would replace a diagnosable failure with an opaque one.
 */
export function errorFromWire(
  statusCode: number,
  body: unknown,
  { requestId }: { requestId: string | null },
): VorqError {
  // Own properties only on the wire envelope and on the error record inside it
  // (`own.ts`). Neither read decides which error *class* is thrown — that comes
  // from `STATUS_MAP` keyed on the HTTP status, so a caller's `catch` is
  // unaffected — but read bare, a polluted `Object.prototype.error` attaches a
  // message and a `type` to a response whose body carried neither, and
  // `VorqError.type` is a value callers do branch on.
  const envelope =
    typeof body === "object" && body !== null
      ? own(body as Record<string, unknown>, "error")
      : undefined;
  let message = `HTTP ${statusCode}`;
  let type: string | null = null;
  if (typeof envelope === "object" && envelope !== null) {
    const record = envelope as Record<string, unknown>;
    const stated = own(record, "message");
    const statedType = own(record, "type");
    if (typeof stated === "string" && stated !== "") message = stated;
    if (typeof statedType === "string") type = statedType;
  }
  const cls = STATUS_MAP.get(statusCode) ?? VorqError;
  return new cls(message, { type, requestId, statusCode });
}
