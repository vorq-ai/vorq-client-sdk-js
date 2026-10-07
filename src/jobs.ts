/**
 * `JobHandle` — the view you poll, wait on, cancel, and read a result from.
 *
 * The job on the network is the durable thing; a handle is only a view, so it
 * carries no state a rerun could not rebuild from the job id.
 */

import type { Hex } from "viem";

import { monotonicNow, wallNow } from "./clock.js";
import { JobFailed, ResultIntegrityError, ValidationError, VorqError, WaitTimeout } from "./errors.js";
import { isUsd } from "./money.js";
import { own } from "./own.js";
import { resultFromRaw, type EmbeddingResult, type MediaResult, type TextResult } from "./results.js";
import { pollInterval, slaSeconds, windowFromSeconds } from "./sla.js";
import type { Cipher, Signer } from "./signer/types.js";
import type { ChainContext } from "./terms.js";
import type { RequestOptions } from "./transport.js";

/**
 * The monotonic clock, on this module's surface where it has always been.
 *
 * It is defined in `clock.ts` now — the verifier's cache TTL needs the same
 * reading, and a second copy of "now" is a second answer to "has this expired".
 * Re-exported rather than dropped: `batches.ts:42` imports it from here, and
 * whether a symbol leaves a module's public surface is a later spec's decision
 * rather than this extraction's.
 */
export { monotonicNow } from "./clock.js";

/**
 * What a handle needs from its client. Narrow on purpose: the handle is
 * testable without a `Client`, and the client that satisfies this has a settled
 * shape to satisfy. `json` and `request` mirror `Transport`'s own signatures
 * (`transport.ts:150,210`) member for member, so a `Client` that forwards to a
 * `Transport` satisfies this by forwarding and nothing else.
 *
 * The handle's own reads go through `request` rather than `json`, because a raw
 * `Response` still carries the headers the cancel guard reads its reference
 * clock from where they are readable at all (see `dateHeaderSeconds`); `json` is
 * here because it is the shape every other read of a client wants, and it costs
 * a forwarding method.
 */
export interface JobClient {
  json<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  fetchBlob(cid: string): Promise<Uint8Array>;
  chainContext(): Promise<ChainContext>;
  readonly signer: Signer | null;
  readonly cipher: Cipher | null;
  resultCipher(): Promise<Cipher | null>;
}

export interface JobHandleOptions {
  /** The window this job is paced by, when the caller already knows it. */
  sla?: string | null;
  /** The row the submission answered with, so `result()` need not re-read it first. */
  job?: Record<string, unknown> | null;
  /** Opens this job's result; defaults to the client's own cipher. */
  cipher?: Cipher | null;
  taskCid?: string | null;
  /**
   * Seconds from a **monotonic** source, for the `result()` deadline only. See
   * `monotonicNow` in `clock.ts` for why this is not the wall clock.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wall-clock unix seconds, the `issued_at` a cancel is stamped and signed
   * with. It has to be wall clock: the chain compares it to block time.
   */
  issuedAtNow?: () => number;
  /**
   * Unix seconds as the chain sees them, overriding the reference this handle
   * learns for itself. **A test seam.** Left unset — the normal case — the
   * reference is the coordinator's own clock, read off the `Date` header of
   * every job read that carries a readable one (see `skewSeconds` and
   * `dateHeaderSeconds` — a cross-origin browser reads none), and the cancel
   * guard is skipped until one has actually been seen. Setting this pins the
   * reference outright.
   */
  chainNow?: () => number;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/**
 * `JobView.endedBecause` → the one cause vocabulary, straight from the
 * contract's own constants (`vorq-evm-contracts/src/Types.sol`).
 *
 * **The job row carries no `error` object.** `clientJob` folds four causes into
 * two statuses — 3 and 4 become `failed`, 2 and 5 become `cancelled` — and
 * passes the cause itself through under `vorq.ended_because`. A reader that
 * looks for `job["error"]` finds nothing and reports the status as the cause,
 * which makes `provider_fail` and `reclaim` — the two a caller is told it can
 * branch on — unreachable, with no error to say so.
 *
 * 0 (none) and 1 (settled) are absent deliberately: neither reaches a failure.
 */
const ENDED_BECAUSE: Readonly<Record<number, string>> = {
  2: "cancelled", // the owner's own signed cancel
  3: "provider_fail", // the claimant reported it could not deliver
  4: "reclaim", // claimed, and never settled inside the window
  5: "expired", // nobody ever claimed it
};

/** The chain's bound on `issuedAt` against block time, in seconds. */
export const CANCEL_WINDOW_SECONDS = 600;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The wire status of a fetched job row, own-properties only (`own.ts`).
 *
 * One reader for every site that branches on it, because what they decide is
 * not a rendering: the loop test decides whether `result()` keeps polling, and
 * the `=== "completed"` test decides **whether the result is fetched at all or
 * `JobFailed` is thrown instead**. A polluted `Object.prototype.status` of
 * `"completed"` sends a queued job straight down the settled path.
 *
 * `undefined` and `null` answer `""`, which is in no terminal set and equals no
 * status — the same degrade `String(job.status)` produced for an absent key,
 * without the prototype answering for it.
 */
function statusOf(job: Record<string, unknown>): string {
  const status = own(job, "status");
  return status === undefined || status === null ? "" : String(status);
}

/**
 * The job's declared SLA seconds off `vorq.sla_secs`, own-properties only at
 * **both** levels (`own.ts`).
 *
 * It decides the window this job is polled and bounded by — and, at
 * `windowFor`, whether the zero-length-window `ValidationError` fires:
 * `Object.prototype.sla_secs = 0` would refuse `result()` for every caller over
 * a term the row never carried.
 */
function slaSecsOf(job: Record<string, unknown>): unknown {
  return own(asRecord(own(job, "vorq")), "sla_secs");
}

/**
 * The job's end cause from `vorq.ended_because`, or `null` if unnamed.
 *
 * A code this SDK does not know degrades to `null` and the caller sees the
 * status instead — guessing at an unfamiliar constant would be worse than
 * saying less.
 */
export function endCause(job: Record<string, unknown>): string | null {
  // Own properties only on both levels — the package rule (`own.ts`) for a
  // record off `JSON.parse`. Read bare, a polluted `Object.prototype.vorq` or
  // `Object.prototype.ended_because` names an end cause for a job whose row
  // named none, and `openai-compat.ts` renders it as the job's `error`.
  const raw = own(asRecord(own(job, "vorq")), "ended_because");
  if (raw === null || raw === undefined || typeof raw === "object") return null;
  const code = Number(String(raw));
  if (!Number.isInteger(code)) return null;
  return Object.hasOwn(ENDED_BECAUSE, code) ? ENDED_BECAUSE[code]! : null;
}

/**
 * The `Date` header of a response, in unix seconds, or `null` if it carried
 * none this SDK can read.
 *
 * It costs no request of its own: it rides on reads the handle already makes.
 *
 * **Readable in Node; cross-origin in a browser, only if the coordinator says
 * so.** `Date` is *not* on the CORS-safelisted response-header list — that list
 * is exactly `Cache-Control`, `Content-Language`, `Content-Length`,
 * `Content-Type`, `Expires`, `Last-Modified`, `Pragma` — so a browser hands back
 * `null` unless `date` appears in `Access-Control-Expose-Headers`, and the
 * coordinator's `EXPOSED_HEADERS` does not list it today
 * (`vorq-coordinator-node/src/api/cors.ts`). This package ships a browser-wallet
 * signer, so that is a live case and not a theoretical one: there, no skew is
 * ever observed and the cancel guard is **skipped**, exactly as it is for a
 * fresh handle with no read behind it. Skipped, not wrong — it fails safe, and
 * the chain still refuses a stale cancel as `StaleOp`.
 */
function dateHeaderSeconds(response: Response): number | null {
  const header = response.headers.get("date");
  if (header === null) return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** The default pause between two polls. Shared with `BatchHandle`, as above. */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class JobHandle {
  readonly id: string;
  /**
   * The name the coordinator's storage service minted for this job's container,
   * read off the submission's answer. The client cannot compute or predict it —
   * the service names the content, not the client — so this is the only place it
   * comes from until the post is indexed.
   */
  taskCid: string | null;

  private readonly client: JobClient;
  private sla: string | null;
  /**
   * The last row seen — the one the submission answered with, then whatever the
   * most recent read returned. Held, not read: `result()` re-reads rather than
   * trusting a row of unknown age, exactly as Python's `_job` does.
   */
  private job: Record<string, unknown> | null;
  private readonly cipher: Cipher | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly issuedAtNow: () => number;
  /** A pinned reference clock, or `null` to use the observed skew below. */
  private readonly chainNow: (() => number) | null;
  /**
   * The coordinator's clock minus this client's, in seconds, as of the last job
   * read that carried a readable `Date` header — and `null` until one has, which
   * in a cross-origin browser is always. It is the only
   * reference this handle has for the ±600 s cancel bound: the coordinator is
   * the relayer, and block time tracks real time closely enough that second
   * resolution and one round trip are both far inside a ten-minute window.
   */
  private skewSeconds: number | null = null;

  constructor(client: JobClient, id: string, options: JobHandleOptions = {}) {
    this.client = client;
    this.id = id;
    // **Own properties only on the caller's options record** (`own.ts`), and
    // `??` is not a substitute: it fires on `undefined`, and an inherited
    // property is not undefined. `JobHandle` is on the package barrel, so this
    // record arrives from a caller. Two of these are sharp: `cipher` is **the
    // key this job's sealed result is opened with**, and `chainNow` pins the
    // reference clock that decides whether the ±600 s `StaleOp` refusal fires
    // — a prototype-supplied one turns that guard into a comparison of this
    // client's clock against itself, which cannot fail.
    const stated = <K extends keyof JobHandleOptions>(key: K): JobHandleOptions[K] =>
      own(options as Record<string, unknown>, key) as JobHandleOptions[K];
    this.sla = stated("sla") ?? null;
    this.job = stated("job") ?? null;
    this.cipher = stated("cipher") ?? client.cipher ?? null;
    this.taskCid = stated("taskCid") ?? null;
    this.now = stated("now") ?? monotonicNow;
    this.sleep = stated("sleep") ?? defaultSleep;
    this.issuedAtNow = stated("issuedAtNow") ?? wallNow;
    this.chainNow = stated("chainNow") ?? null;
  }

  /**
   * One read of the job: `GET /v1/jobs/{id}` on the coordinator.
   *
   * The window is learned from `vorq.sla_secs`, which is what the row carries —
   * an integer, projected from the chain's `slaSecs`. A row that names no usable
   * one leaves `sla` at `null` and `result` falls back to its default pacing.
   *
   * @internal The SDK's own surface, not the package's. `openai-compat.ts`
   * reads the job row, the settled result and the signed cancel through this
   * member and the three below it (`row`, `settledResult`, `cancelRequest`),
   * exactly as `_openai_compat.py` reads `_fetch`, `_job`, `_settled_result`
   * and `_cancel_request`. None of the four belongs on the package barrel
   * (`src/index.ts`), and a caller who finds one in the `.d.ts` is reading an
   * implementation detail.
   */
  async fetch(): Promise<Record<string, unknown>> {
    // `request`, not `json`, so the response's `Date` header is still readable:
    // it is this handle's only reference for the cancel bound below, and it
    // rides on a read that was happening anyway.
    const response = await this.client.request("GET", `/v1/jobs/${this.id}`);
    const served = dateHeaderSeconds(response);
    if (served !== null) this.skewSeconds = served - this.issuedAtNow();
    const job = (await response.json()) as Record<string, unknown>;
    // `vorq.gas_fee` and `vorq.fee` are `ClientJob`'s checked members, refused
    // as `GET /evm/jobs` refuses a row without them.
    const vorq = asRecord(own(job, "vorq"));
    for (const key of ["gas_fee", "fee"]) {
      if (!isUsd(own(vorq, key))) {
        throw new VorqError(
          `GET /v1/jobs/${this.id}: vorq.${key} is not a USD decimal string`,
          { type: "api_error" },
        );
      }
    }
    this.job = job;
    if (this.sla === null) {
      this.sla = windowFromSeconds(slaSecsOf(job));
    }
    return job;
  }

  /** @internal The last row this handle read, or the post receipt. See `fetch`. */
  get row(): Record<string, unknown> | null {
    return this.job;
  }

  /** One `GET /v1/jobs/{id}`; returns the current wire status string. */
  async status(): Promise<string> {
    const job = await this.fetch();
    return statusOf(job);
  }

  /**
   * The window this job is polled and bounded by.
   *
   * **Deliberate divergence from Python**: a zero-length window raises rather
   * than becoming a wait. `slaSeconds("0h")` is `0`, which as the default
   * timeout polls once and raises `WaitTimeout` — which names the wrong problem.
   * A row whose `sla_secs` is a non-positive number is the same statement made
   * by the node, and `windowFromSeconds` folds it into "unknown, pace at one
   * hour"; saying so here is the difference between a broken row and a slow one.
   */
  private windowFor(job: Record<string, unknown>): string {
    const secs = slaSecsOf(job);
    if (secs !== null && secs !== undefined && typeof secs !== "object") {
      const parsed = Number(String(secs));
      if (Number.isFinite(parsed) && parsed <= 0) {
        throw new ValidationError(
          `Job ${this.id} names an SLA window of ${parsed} seconds, which is not a ` +
            "window: there is no span of time in which it could settle. Nothing " +
            "was waited on.",
          { type: "invalid_request_error" },
        );
      }
    }
    const window = this.sla ?? "1h";
    if (slaSeconds(window) <= 0) {
      throw new ValidationError(
        `SLA window ${JSON.stringify(window)} is zero-length, so there is no span ` +
          "of time in which this job could settle. Nothing was waited on.",
        { type: "invalid_request_error" },
      );
    }
    return window;
  }

  /**
   * Poll until terminal, then return the result (or raise `JobFailed`).
   *
   * A window shorter than a day is paced by the window — `slaSeconds / 60`,
   * held between 2 s and `MAX_POLL_INTERVAL_SECONDS` (60 s). A `"24h"` job is
   * paced by time spent waiting: once a minute for the first fifteen minutes,
   * every three minutes for the rest of the first hour, every ten minutes after
   * it. `timeoutSeconds` defaults to the job's SLA; on expiry raises
   * `WaitTimeout` carrying `.jobId`.
   */
  async result(timeoutSeconds?: number): Promise<TextResult | MediaResult | EmbeddingResult> {
    let job = await this.fetch();
    const window = this.windowFor(job);
    const timeout = timeoutSeconds ?? slaSeconds(window);
    const start = this.now();
    const deadline = start + timeout;
    while (!TERMINAL.has(statusOf(job))) {
      // Before the sleep, not after it: a sleep taken past the deadline is a
      // read the window paid for and never got, and it is how a job that
      // settled inside its window came back as a timeout.
      const now = this.now();
      const remaining = deadline - now;
      if (remaining <= 0) {
        throw new WaitTimeout(`Job ${this.id} did not settle within ${timeout}s.`, {
          jobId: this.id,
        });
      }
      // Clamped to what is left: an interval longer than the remaining budget
      // would sleep past the deadline this loop is about to report, so a 10 s
      // wait on a `"24h"` job would block for a minute before saying it timed
      // out at ten seconds.
      await this.sleep(Math.min(pollInterval(window, now - start), remaining) * 1000);
      job = await this.fetch();
    }
    const status = statusOf(job);
    if (status === "completed") return this.settledResult(job);
    // The cause comes off `vorq.ended_because`, because that is where the row
    // puts it — there is no `error` object on a job row at all.
    const cause = endCause(job);
    const detail = cause !== null && cause !== status ? ` (${cause})` : "";
    throw new JobFailed(`Job ${this.id} ${status}${detail}.`, {
      errorType: cause ?? status,
      jobId: this.id,
    });
  }

  /**
   * Read a completed job's result — the one place that decides how.
   *
   * A settled job names its result: the bytes are fetched by `result_cid` and
   * opened with the job's cipher.
   *
   * There is no inline fallback. A job that reports `completed` but names no
   * result named nothing to fetch — whatever `output` the coordinator put on the
   * row is a body it wrote itself, not the one the provider settled. That is a
   * broken settle, so it raises rather than returning somebody else's copy (or
   * an empty result).
   *
   * @internal Public for `openai-compat.ts` only. See `fetch`.
   */
  async settledResult(
    job: Record<string, unknown>,
  ): Promise<TextResult | MediaResult | EmbeddingResult> {
    // **Own properties only** (`own.ts`), and this is not a read-render
    // defect. `cid` is the name `fetchBlob` reads, so a polluted
    // `Object.prototype.result_cid` turns the `ResultIntegrityError` below
    // into a fetch of attacker-named bytes — and `decryptOutput` returns
    // cleartext JSON unchanged when `own(output, "enc")` is not
    // `SEALED_RESULT_VERSION`, so a fabricated answer is returned to the
    // caller as this job's result.
    const cid = own(job, "result_cid");
    if (typeof cid !== "string" || cid === "") {
      throw new ResultIntegrityError(
        `Job ${this.id} is completed but names no result (result_cid is null) — it ` +
          "settled without a named result, so there is nothing this client can " +
          "fetch or open.",
      );
    }
    const raw = await this.client.fetchBlob(cid);
    return resultFromRaw(raw, job, this.cipher ?? (await this.client.resultCipher()));
  }

  /**
   * Unix seconds as the chain is believed to see them, or `null` when this
   * handle has no reference and the ±600 s bound therefore cannot be checked.
   *
   * A pinned `chainNow` wins; otherwise it is this client's wall clock plus the
   * skew last observed off a coordinator response's `Date` header, which is
   * `null` until a job read has actually carried one.
   */
  private chainReference(): number | null {
    if (this.chainNow !== null) return this.chainNow();
    if (this.skewSeconds === null) return null;
    return this.issuedAtNow() + this.skewSeconds;
  }

  /**
   * Sign `Cancel(jobId, issuedAt)` and relay it. Returns the node's answer.
   *
   * The cancel is a **chain op the node relays**, not a state change the node
   * decides. `JobRegistry.cancel(jobId, issuedAt, signature)` never reads
   * `msg.sender` and there is no `cancelFor`, so this signature is the entire
   * authority over ending the job — which is exactly why it is made here and not
   * there. A relaying node that could author one could cancel any job that ever
   * passed through it.
   *
   * `issued_at` is unix seconds, stamped now and sent on the body: the chain
   * bounds it to ±600 s of landing, so it has to be the value that was signed
   * rather than one the relay picks. There is no nonce — a cancelled job cannot
   * be cancelled twice, so the job's one-shot state machine is the replay guard.
   *
   * A client with no wallet cannot author this at all, and it says so before the
   * request rather than letting the node answer `400` to a body with no
   * signature on it — "this client cannot cancel" and "this job cannot be
   * cancelled" are different answers.
   *
   * @internal Public for `openai-compat.ts` only. See `fetch`.
   */
  async cancelRequest(): Promise<Response> {
    const signer = this.client.signer;
    if (signer === null) {
      throw new ValidationError(
        "cancelling a job means signing Cancel(jobId, issuedAt) with the wallet " +
          "that owns it — the coordinator only relays that signature and cannot " +
          "author one. This client holds no wallet, so nothing was sent: pass " +
          "signer=... when constructing the client.",
        { type: "invalid_request_error" },
      );
    }
    // **Deliberate divergence from Python**: the context is read *before* the
    // stamp is taken. A slow `GET /evm/chain` between stamping and signing would
    // spend the stamp's budget against the ±600 s bound below for nothing.
    const ctx = await this.client.chainContext();
    const issuedAt = Math.floor(this.issuedAtNow());
    // The guard fires when, and only when, this handle holds a reference clock:
    // a `Date` header seen on a job read (the poll-then-cancel path, and the
    // ordinary one in Node), or a `chainNow` a caller pinned. Two cases hold no
    // reference and are sent unchecked — a cancel issued as the very first call
    // on a fresh handle, and any cancel from a cross-origin browser, where the
    // `Date` header is unreadable unless the coordinator exposes it (see
    // `dateHeaderSeconds`). Both skip the comparison outright rather than
    // comparing this client's clock against itself, which would be a check that
    // cannot fail — worse than no check, because it reads like one.
    const reference = this.chainReference();
    if (reference !== null) {
      const drift = issuedAt - Math.floor(reference);
      if (Math.abs(drift) > CANCEL_WINDOW_SECONDS) {
        throw new ValidationError(
          `the cancel would be stamped issued_at=${issuedAt}, which is ${Math.abs(drift)} s ` +
            `from the coordinator's clock — outside the ±${CANCEL_WINDOW_SECONDS} s the ` +
            "JobRegistry accepts, so it would be refused as StaleOp. Nothing was " +
            "sent. Usually that is a local clock that has drifted; it can also be " +
            "a stale reference, if the clock was corrected after the last read of " +
            "this job — reading it again refreshes the reference.",
          { type: "invalid_request_error" },
        );
      }
    }
    // The job id on the wire is the chain's `bytes32`, which is what the Cancel
    // struct's `jobId` member is.
    const signature = await signer.signCancel(this.id as Hex, BigInt(issuedAt), ctx);
    return this.client.request("POST", `/v1/jobs/${this.id}/cancel`, {
      json: { issued_at: issuedAt, signature },
    });
  }

  /**
   * Cancel the job: sign `Cancel` and post it to `/v1/jobs/{id}/cancel`.
   *
   * Requires the owning wallet. The node relays the signature to the chain and
   * answers with the relay receipt; a job a provider has already claimed is
   * refused there, as a `StateConflictError`.
   */
  async cancel(): Promise<void> {
    const response = await this.cancelRequest();
    // Nothing reads this body, and under undici an unread one holds its
    // connection until the socket is garbage-collected.
    void response.body?.cancel();
  }
}
