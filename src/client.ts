/**
 * The client: session management, the chain context, every read, and the
 * submission path.
 *
 * The client speaks to a coordinator node and to nothing else. Batches and
 * result bytes belong to spec `06`.
 */

import type { Hex } from "viem";

import { ChainContext, OrderTerms, capFor, parseRate, paymentDomain } from "./terms.js";
// A value import, and the reason `batches.ts` may only import from here with
// `import type`: two runtime imports would be a real module cycle.
import { Batches } from "./batches.js";
import { Models } from "./models.js";
import { wallNow } from "./clock.js";
// `import type`, deliberately: nothing here constructs a `Verifier`, so this
// keeps `client.ts → verify.ts` out of the runtime graph entirely and the
// attestation module out of a bundle that never verifies anything.
import type { Verifier } from "./verify.js";
import { Transport, type TransportHooks } from "./transport.js";
import {
  EscrowKeyUnverified,
  TransportError,
  ValidationError,
  VerificationError,
  VorqError,
  errorFromWire,
} from "./errors.js";
import { buildUpload, fetchBlob, resolveGateway } from "./files.js";
import { JobHandle } from "./jobs.js";
import { PAGE_DEFAULT_LIMIT, pageAgain, pageRows, readPage } from "./paging.js";
import type { RequestOptions } from "./transport.js";
import { own } from "./own.js";
import { checkInput } from "./params.js";
import { formatUsd, isUsd, parseUsd } from "./money.js";
import { asBigInt } from "./scalars.js";
import { knownWindowSeconds, normalizeSla, slaSeconds, windowFromSeconds } from "./sla.js";
import {
  buildContainer,
  commitmentOf,
  deriveDek,
  encryptUnderDek,
  jobIdFor,
  newSeed,
  sealSeedTo,
} from "./crypto/container.js";
import { ENVELOPE_VERSION, INLINE_MAX_BYTES } from "./crypto/domains.js";
import type { Cipher, Signer } from "./signer/types.js";
import { envWalletSigner } from "./signer/private-key.js";
import { deriveResultCipher } from "./crypto/cipher.js";
import { canonicalBytes, declareUnits, toBase64 } from "./units.js";

export const DEFAULT_BASE_URL = "https://api.vorq.co";

/** Re-mint this many seconds before the token expires. */
const REFRESH_SKEW_SECONDS = 60;

/**
 * The environment, if there is one.
 *
 * Reached through `globalThis` rather than as a bare environment reference, for
 * the reason `signer/private-key.ts` spells out at length: this module is part
 * of a browser bundle, and a bare reference is what makes a bundler inject a
 * shim and smuggle a server-side lookup into a page.
 */
function envValue(name: string): string | undefined {
  // **An environment is a record, and every hop to it is read own-properties
  // only** (`own.ts`). This was missed by a sweep that drew its scope at
  // records off `JSON.parse` and never asked whether an environment is one: an
  // **unset** variable is answered by `Object.prototype`, so with the variable
  // unset — the ordinary case — a polluted prototype supplies the value this
  // function returns, on the default construction path, with no other
  // precondition.
  //
  // The `globalThis` hop is guarded for the same reason one layer up: a browser
  // realm has no own `process`, so a bare read there would let a polluted
  // prototype **manufacture an environment** where the paragraph above promises
  // there is none. Guarded, the browser answer is `undefined`, which is exactly
  // what that paragraph says it should be.
  const proc = Object.hasOwn(globalThis, "process")
    ? (globalThis as { process?: unknown }).process
    : undefined;
  if (typeof proc !== "object" || proc === null) return undefined;
  const env = own(proc as Record<string, unknown>, "env");
  if (typeof env !== "object" || env === null) return undefined;
  const value = own(env as Record<string, unknown>, name);
  return typeof value === "string" ? value : undefined;
}

/**
 * How far past the SLA window the payment authorization stays valid.
 *
 * The authorization must outlive the work, so a long `batch` (24h) order does
 * not expire before `/settle`. Configurable through `$VORQ_SETTLEMENT_MARGIN`
 * (seconds); anything that is not a whole number of seconds leaves the default
 * in place rather than becoming a `NaN` that would travel into an order's
 * `expiresAt`.
 */
export const SETTLEMENT_MARGIN_SECONDS = ((): number => {
  const raw = envValue("VORQ_SETTLEMENT_MARGIN");
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 3600;
})();

/**
 * `JobRegistry`'s own ceiling: it refuses any order expiring past `now +
 * 86400`. The `24h` window plus the margin above already exceeds it, so the
 * clamp in `expiresAt` is the ordinary case and not an edge one.
 */
export const MAX_EXPIRY_SECONDS = 86400;

/**
 * How many times one submission is re-signed against a fresh quote before it is
 * given up on.
 *
 * A gas fee drifting forever is a server this client should stop feeding
 * megabytes to, not a condition to spin on — and the bound is on *re-quotes*,
 * not on uploads of new bytes: the container is encoded once and reused
 * verbatim on every attempt.
 */
export const MAX_SUBMIT_ATTEMPTS = 3;

/**
 * How long a verified escrow key is reused. **Three hours, and the number is
 * not free — it is a cross-repo constant three definitions have to agree on.**
 *
 * The escrow mints key generations in memory and erases them on a deadline, so
 * a key has to outlive every order that could still name it. The coordinator
 * enforces that as an inequality over four windows
 * (`vorq-coordinator-node/src/escrow/keys.ts:102-142`, `soundness()`):
 *
 * ```
 * grace + maxExpiry + maxSla < retention
 * ```
 *
 * **This constant is the `grace` term** — the node's
 * `escrow/windows.ts:36` `KEY_CACHE_TTL_MS = 3 * HOUR_MS`, whose own comment
 * says it is "how long a client may serve an escrow public key out of its own
 * cache before re-fetching", stated node-side precisely because the windows
 * have to move together. At the shipped values `3 + 24 + 24 = 51 h < 72 h`, and
 * `soundness()` **refuses to boot** if that ever stops holding. Raising this
 * number is not a local decision: `keys.ts:151-152` computes the largest SLA the
 * network may allow as `(retention − grace)/1000 − maxExpiry`, so a longer
 * client cache directly shrinks the SLA ceiling curation may set.
 *
 * The authority is `_client.py:94`'s `KEY_CACHE_TTL = 3 * 3600.0` and this is
 * the same value. **Its stated reason there is stale** and is deliberately not
 * copied: it cites `KEY_CACHE_TTL + MAX_EXPIRY < DECAY_WINDOW` (3 + 24 < 48),
 * which `keys.ts:31-44` records as "missing a term and the constant it produced
 * is unsound" — an order's life does not end at expiry, because a provider
 * claims inside the expiry window and then has the whole SLA to deliver.
 * Retention is 72 h now, not 48, and the inequality has three terms.
 *
 * **`KEY_FRESHNESS_S` does not bound this and must not be read as bounding it.**
 * They answer different questions: ±600 s is how stale an *announcement* may be
 * when it is verified, and this is how long the verified *key* is reused
 * afterwards. Requiring the cache to expire inside the freshness window would
 * leave `0` as the only legal value, and the authority ships both anyway —
 * `verify.py:76`'s `KEY_FRESHNESS_S = 600.0` and `_client.py:94`'s
 * `KEY_CACHE_TTL = 3 * 3600.0` — for exactly that reason. They are two files,
 * not one: the bound belongs to verification, the cache to the client. What the
 * reuse window costs is stated
 * on `escrowRecipient` instead, where a caller can act on it.
 */
const KEY_CACHE_TTL_S = 3 * 3600;

/**
 * R6: a confidential order demands attestation, and a client with no verifier
 * has no way to demand it.
 *
 * Refused before anything is posted and before anything is read: a confidential
 * submission that cannot verify a thing must not reach the network at all.
 */
function refuseConfidential(): never {
  throw new ValidationError(
    "a confidential submission seals only to a provider whose attestation evidence " +
      "has been checked, and this client has no verifier to check it with. Nothing " +
      "was posted; submit without confidential to seal to the provider's published key",
    { type: "invalid_request_error" },
  );
}

export interface ClientOptions {
  baseUrl?: string;
  signer?: Signer;
  /**
   * A pre-minted `vorq_sess_…` token, used as-is and never proactively
   * rotated; with a signer beside it a `401` still re-mints once. Exactly
   * `Client.fromSessionToken`, as an option.
   */
  sessionToken?: string;
  /** Opens results, and its public key is sealed into every submission. */
  cipher?: Cipher;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Where `fetchBlob` reads content-addressed bytes from. Explicit argument >
   * `$VORQ_PIN_GATEWAY` > the built-in default; an empty string at either level
   * disables the read path outright rather than falling through, because "I
   * will supply my own" must be sayable.
   */
  gateway?: string;
  /**
   * Attestation verification for the two paths that need it.
   *
   * A client built with one can submit `confidential: true`, and can rest an
   * **open** order — one with no `provider` — because it has a way to check the
   * escrow key that order's payload would be sealed to. A client built without
   * one refuses both, before anything is posted.
   */
  verifier?: Verifier | null;
  /**
   * Wall clock for the escrow key cache, in **seconds**. Injected so a test can
   * advance it; the verifier keeps its own clocks and is not affected by this.
   */
  clock?: () => number;
}

export interface Ask {
  providerId: number;
  modelId: number;
  sla: number;
  /** USD per 1M units of work, a decimal string (e.g. `"0.05"`). */
  rateIn: string;
  rateOut: string;
}

/**
 * What every budgeted listing answers besides its rows.
 *
 * The coordinator pages these by row count *and* by a byte budget, and the two
 * bounds are reported separately: `truncated` is the budget's own signal, and
 * `nextOffset` is the complete answer to "is there more, and where".
 *
 * **They are not the same question, which is why both are here.** A full page
 * the budget did not cut carries `truncated: false` and still has rows behind
 * it — a 150-row table answers a default page with 100 rows and no truncation —
 * so a caller looping on the flag alone silently reads 100 of 150. `nextOffset`
 * folds in the other half (`returned === limit`) and is the member to loop on:
 * feed it back as `offset` until it is `null`.
 */
export interface PagedListing {
  /** The byte budget cut this page short of the rows the limit asked for. */
  truncated: boolean;
  /**
   * Where to resume, or `null` when this page was the last of them.
   *
   * **A walk has a hard end that arrives as an error, not as a `null`.** The
   * coordinator caps `offset` at 1 000 000 rows and answers a `400` past it, so
   * a caller paging a listing that large should be ready to catch a
   * `VorqError` and keep the rows already read. Narrowing the query is the
   * intended answer at that size — `jobs` takes `state`, `model`, `provider`,
   * `owner` and `postedBefore` for exactly this reason.
   */
  nextOffset: number | null;
}

export interface AskBook extends PagedListing {
  asks: Ask[];
  asOfBlock: bigint | null;
}

/** `GET /evm/asks/floors`: the cheapest ask per `(model, window)`, each leg minimised independently. */
export interface Floor {
  modelId: number;
  sla: number;
  /** USD per 1M units of work, a decimal string. */
  rateIn: string;
  rateOut: string;
}

export interface FloorBook extends PagedListing {
  floors: Floor[];
  asOfBlock: bigint | null;
}

export interface JobQuery {
  /** One of `Open`, `Claimed`, `Settled`, `Cancelled` — the node's own spelling. */
  state?: "Open" | "Claimed" | "Settled" | "Cancelled";
  /** An integer model id, **not** a name: the chain has no notion of a model name. */
  model?: number;
  /** An integer provider id, for the same reason. */
  provider?: number;
  owner?: string;
  postedBefore?: number;
  limit?: number;
  offset?: number;
  /** `oldest` (the default) or `newest`. An unknown posting block sorts first in both. */
  order?: "newest" | "oldest";
}

/**
 * The chain-shaped job row from `GET /evm/jobs`, passed through. `gas_fee` and
 * `fee` are checked on read: a row without a USD decimal string there is refused.
 */
export type EvmJob = Record<string, unknown> & {
  /**
   * The flat relay gas fee snapshotted at post, in USD. Pulled at claim beside
   * the cap and its protocol fee; kept by the treasury on settle, provider fail
   * and reclaim. A job that ended while open paid nothing.
   */
  gas_fee: string;
  /**
   * The protocol fee settlement took on top of the provider's charge, in USD,
   * from the chain's `Settled` event. `"0"` for a job that did not settle.
   */
  fee: string;
};

export interface JobBook extends PagedListing {
  jobs: EvmJob[];
  asOfBlock: bigint | null;
}

export interface JobsSummaryModel {
  modelId: number;
  jobs: number;
  completed: number;
  /**
   * What claims lock, summed — per job `cap + floor(cap × feeBps / 10000) +
   * gas_fee` — in USD as a decimal string.
   */
  escrowed: string;
}

/** `GET /evm/jobs/summary`: one wallet's totals, and the same per model. */
export interface JobsSummary {
  jobs: number;
  completed: number;
  /** `JobsSummaryModel.escrowed` over every row, in USD as a decimal string. */
  escrowed: string;
  byModel: JobsSummaryModel[];
  asOfBlock: bigint | null;
}

/**
 * `GET /v1/jobs/:id`. `status` is computed by the node and read, never
 * recomputed here.
 */
export interface ClientJob {
  id: string;
  object: string;
  model: string | null;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  in_progress_at: string | number | null;
  result_cid: string | null;
  /** `gas_fee` and `fee` are `EvmJob`'s, checked the same way on every read. */
  vorq: Record<string, unknown> & { gas_fee: string; fee: string };
  as_of_block?: string | number | null;
}

export interface SubmitArgs {
  model: string;
  /** A `string` is sugar for `{ input: string }`; an object is sent verbatim. */
  input: string | Record<string, unknown>;
  /** A tier name (`async` / `batch`) or a raw window (`1h` / `24h`). */
  sla?: string;
  /** USD per 1M units of work, as a decimal string: `"0.05"`. A number or bigint is refused. */
  rateIn?: string | null;
  rateOut?: string | null;
  /**
   * The provider this order is designated to. Its absence is an **open** order,
   * sealed to the coordinator's verified escrow key — which needs a client built
   * with `verifier`, and is refused before any request without one (R5).
   */
  provider?: number;
  /** Check the input against the model's published schema first. Default `true`. */
  validateParams?: boolean;
  /**
   * Demand attestation: the designated provider's registry evidence is verified
   * before its key is sealed to. Needs a client built with `verifier`, and is
   * refused before any request without one (R6).
   *
   * **It applies to `provider` and to nothing else, so on an open order it is
   * inert.** An open order has no provider record to attest — its payload goes
   * to the coordinator's escrow key, which is verified on that path whether or
   * not this flag is set. Setting both therefore adds no check beyond the one
   * an open order already makes, and does not fail closed for asking: it
   * succeeds, exactly as `_client.py:892-914` does.
   *
   * That matters most under the default `structural` mode against a
   * `static-coordinator-v1` announcement, which is accepted with **no measured
   * image and no allowlist read at all** — an operator-derived escrow key. A
   * caller who set `confidential` meaning "measured hardware only" did not get
   * it, and there is deliberately no switch that would: see `verify.ts`'s
   * forward constraint on `STATIC_COORDINATOR_EVIDENCE_TYPE`, which records
   * that nothing yet lets a client demand measured escrow evidence and that a
   * strict tier must refuse the static tag rather than let it become a silent
   * downgrade path. To pin measured hardware today, name a provider.
   */
  confidential?: boolean;
  /**
   * The out dimension, exactly. Beats every heuristic, **zero included** — an
   * embedding has no output side to buy.
   */
  unitsOut?: number;
  /** A caller's own tag, sealed inside the envelope and absent when unset. */
  customId?: string;
}

/**
 * One sealed submission, before it is paid for.
 *
 * A batch line and a single job are the same thing at this point — the same
 * order, the same container v1, the same job id — which is why this shape
 * exists rather than the sealing being inlined twice. The only difference
 * downstream is where the money comes from: a single job takes it from a
 * `402` quote, a batch line computes it from the terms it already signed
 * plus one gas fee read for the whole file.
 */
export interface SealedLine {
  url: string;
  terms: OrderTerms;
  jobId: Hex;
  /** The flat wire order: the signed members, `owner`, `job_id` and `signature`. */
  order: Record<string, unknown>;
  /**
   * The sealed bytes. Both paths base64-encode them at or under
   * `INLINE_MAX_BYTES`; a single job over that uploads them first and sends
   * `container_cid` instead.
   */
  container: Uint8Array;
}

/** Everything `sealLine` decides an order from. Named so `BatchClient` can too. */
export interface SealLineArgs {
  model: string;
  payloadInput: Record<string, unknown>;
  window: string;
  /**
   * The batch-file `url` field. Carried on a `SealedLine` because a JSONL row
   * has one; a `POST /v1/jobs` body does not, so `submit` sets it and ignores it.
   */
  url: string;
  /** USD per 1M units of work, as a decimal string. */
  rateIn?: string | null;
  rateOut?: string | null;
  provider?: number;
  /**
   * Demand attestation for this line's recipient. Set by `submit`; the batch
   * surface has no such flag in either SDK, so a batch line leaves it unset and
   * gets `false` by omission.
   */
  confidential?: boolean;
  unitsOut?: number;
  customId?: string;
  ctx: ChainContext;
}

export interface ProviderRecord {
  providerId: number;
  operator: string;
  /** A Curve25519 key, `0x`-prefixed on this route. */
  boxKey: string;
  listed: boolean;
  raw: Record<string, unknown>;
}

export interface AllowlistEntry {
  key: string;
  status: number;
  entry: unknown;
}

export interface Allowlist extends PagedListing {
  entries: AllowlistEntry[];
  asOfBlock: bigint | null;
}

export interface EscrowKeyAnnouncement {
  /** 64 lowercase hex, **no `0x`** — this route builds its key by hand. */
  escrowPublicKey: string;
  evidence: unknown;
  issuedAt: number;
}

/** OpenAI's `FileObject`, plus the two members only this network has. */
export interface VorqFile {
  id: string;
  bytes: number;
  filename: string;
  purpose: string;
  status: string;
  createdAt: number | null;
  /**
   * Unix seconds. The node always sends one — 300s from creation while
   * unattached, bumped to `FILE_RETENTION_SECONDS` once a job or batch attaches
   * the file. `null` only if this parse can't read it as a number, same as
   * `createdAt`.
   */
  expiresAt: number | null;
  /** The store's own name for the object — readable with no coordinator in the path. */
  cid: string | null;
  /** The non-blank line count the upload door made while it held the bytes. */
  lines: number | null;
  raw: Record<string, unknown>;
}

/**
 * A `FileObject` row as a `VorqFile`.
 *
 * `cid` and `lines` are `null` rather than `0`/`""` when the node did not send
 * them: a file whose object name is unknown and one whose name is the empty
 * string are different facts, and only the first is representable as absence.
 */
const fileFrom = (row: Record<string, unknown>): VorqFile => {
  // Own properties only on both levels — the package rule (`own.ts`) for a
  // record off `JSON.parse`. `cid` is the name a batch's sealed output is
  // fetched by, so a prototype-supplied one points a result read at content
  // this file never named.
  const vorq = (own(row, "vorq") ?? {}) as Record<string, unknown>;
  return {
    id: String(own(row, "id") ?? ""),
    bytes: Number(own(row, "bytes") ?? 0),
    filename: String(own(row, "filename") ?? ""),
    purpose: String(own(row, "purpose") ?? ""),
    status: String(own(row, "status") ?? ""),
    createdAt: typeof own(row, "created_at") === "number" ? (own(row, "created_at") as number) : null,
    expiresAt: typeof own(row, "expires_at") === "number" ? (own(row, "expires_at") as number) : null,
    cid: typeof own(vorq, "cid") === "string" ? (own(vorq, "cid") as string) : null,
    lines: typeof own(vorq, "lines") === "number" ? (own(vorq, "lines") as number) : null,
    raw: row,
  };
};

function asNumber(value: unknown): number {
  return Number(asBigInt(value) ?? 0);
}

/** A display listing's USD figure, `"0"` when the node sent none it could read. */
function usdOr(value: unknown): string {
  return isUsd(value) ? value : "0";
}

/**
 * The figures on the aggregate reads, refused rather than defaulted.
 *
 * A `0` standing in for an unreadable count is a plausible answer nobody would
 * question, and a `"0"` for an unreadable rate quotes a model as free — and a
 * floor is the rate an order signs, not a display figure. `countFigure` takes
 * only a JSON integer within `MAX_SAFE_INTEGER`, and `moneyFigure` only a USD
 * decimal string.
 *
 * `figureRecord` is the same rule one level up: `own()` is `Object.hasOwn`,
 * which throws a `TypeError` on a `null` or `undefined` element, and a
 * `TypeError` escapes this SDK's error taxonomy — a caller writing
 * `catch (e) { if (e instanceof VorqError) … }` mishandles it.
 *
 * `what` is the route, for the message; every read on one route names it.
 */
function refuseFigure(what: string, key: string, reason: string): never {
  throw new VorqError(`${what}: ${key} ${reason}`, { type: "api_error" });
}

function figureRecord(what: string, row: unknown, key: string): Record<string, unknown> {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : refuseFigure(what, key, "is not an object");
}

function moneyFigure(what: string, rec: Record<string, unknown>, key: string): string {
  const value = own(rec, key);
  return isUsd(value) ? value : refuseFigure(what, key, "is not a USD decimal string");
}

/** A job row whose `gas_fee` and `fee` are USD decimal strings, refused otherwise. */
function evmJobRow(what: string, row: unknown): EvmJob {
  const r = figureRecord(what, row, "job");
  moneyFigure(what, r, "gas_fee");
  moneyFigure(what, r, "fee");
  return r as EvmJob;
}

function countFigure(what: string, rec: Record<string, unknown>, key: string): number {
  const value = own(rec, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : refuseFigure(what, key, "is not an integer");
}

/** The SLA spellings `floors` filters by: the tier names, or their raw windows. */
export type SlaWindow = "async" | "batch" | "1h" | "24h";

export class Client {
  readonly baseUrl: string;
  readonly signer: Signer | null;
  private cipherValue: Cipher | null;
  private cipherDerivation: Promise<Cipher> | null = null;
  /**
   * One verifier for the client's lifetime — it owns the allowlist cache, and a
   * per-submission one would re-read chain state on every order.
   */
  readonly verifier: Verifier | null;
  readonly models: Models;
  readonly batches: Batches;

  private readonly transport: Transport;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** The resolved gateway, or `null` for a client with no blob read path. */
  private readonly gateway: string | null;
  private token: string | null = null;
  /** Unix seconds. `Infinity` for a token supplied rather than minted. */
  private tokenExpiresAt = 0;
  /**
   * The in-flight or settled read, not the value: two callers entering before
   * the first resolves must share one `GET /evm/chain` and one context object.
   */
  private chain: Promise<ChainContext> | null = null;
  private minting: Promise<void> | null = null;
  /** The last verified escrow key, and when it stops being reused. */
  private escrowKeyCache: string | null = null;
  private escrowKeyExpiresAt = 0;
  /** Wall clock for the escrow key cache, in seconds. */
  private readonly escrowClock: () => number;

  constructor(options: ClientOptions = {}) {
    // **Own properties only on the caller's options record** (`own.ts`), and a
    // destructuring-style default is not a substitute: `??` fires on `undefined`
    // and an inherited property is not undefined. `fetch` and `signer` are the
    // sharp ones — a polluted `Object.prototype.fetch` would carry every sealed
    // request, and a polluted `signer` would sign every order.
    const opt = <K extends keyof ClientOptions>(key: K): ClientOptions[K] =>
      own(options as Record<string, unknown>, key) as ClientOptions[K];
    this.baseUrl = (opt("baseUrl") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Node: a client with no signer signs with `$VORQ_WALLET_KEY` when it is set.
    this.signer = opt("signer") ?? envWalletSigner();
    this.cipherValue = opt("cipher") ?? null;
    this.verifier = opt("verifier") ?? null;
    this.escrowClock = opt("clock") ?? wallNow;
    this.fetchImpl = opt("fetch") ?? globalThis.fetch.bind(globalThis);
    this.gateway = resolveGateway(opt("gateway"));
    if (opt("sessionToken") !== undefined) {
      this.token = opt("sessionToken")!;
      this.tokenExpiresAt = Number.POSITIVE_INFINITY;
    }

    const hooks: TransportHooks = {
      ensureSession: () => this.ensureSession(),
      token: () => this.token,
      reauthorize: async (staleToken) => {
        if (this.signer === null) return false;
        // The token this request sent is not always the one the client holds: a
        // concurrent request's 401 may already have rotated the session while
        // this one was in flight. Re-minting on top of that would burn a second
        // one-shot nonce to arrive at a token no better than the live one, so
        // the retry just goes out with what is already here.
        if (this.token !== null && this.token !== staleToken) return true;
        // Otherwise the live token is the one that was refused. The node burns a
        // nonce on lookup, before the signature is checked, so re-minting means
        // a **fresh** nonce and not a replay of the last one.
        this.token = null;
        this.tokenExpiresAt = 0;
        await this.ensureSession();
        return this.token !== null;
      },
    };

    this.transport = new Transport({
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      maxRetries: opt("maxRetries"),
      timeoutMs: opt("timeoutMs"),
      hooks,
    });
    this.models = new Models(this.transport);
    this.batches = new Batches(this);
  }

  /**
   * The cipher results open with: the one passed in or, once `resultCipher()`
   * has derived it, the signer's.
   */
  get cipher(): Cipher | null {
    return this.cipherValue;
  }

  /**
   * The cipher results open with. Without an explicit one, the key is derived from
   * the signer on first use (`deriveResultCipher`: one wallet signature) and kept.
   */
  async resultCipher(): Promise<Cipher | null> {
    if (this.cipherValue !== null || this.signer === null) return this.cipherValue;
    this.cipherDerivation ??= deriveResultCipher(this.signer);
    try {
      this.cipherValue = await this.cipherDerivation;
    } catch (error) {
      this.cipherDerivation = null; // a declined signature can be asked again
      throw error;
    }
    return this.cipherValue;
  }

  /**
   * A client over a pre-minted `vorq_sess_…` token.
   *
   * Without a signer the token is used as-is and never rotated: a 401 is raised
   * rather than papered over, because there is no wallet to mint a new one.
   */
  static fromSessionToken(token: string, options: ClientOptions = {}): Client {
    return new Client({ ...options, sessionToken: token });
  }

  get sessionToken(): string | null {
    return this.token;
  }

  /**
   * Mint or rotate the session token from the signer's wallet as needed.
   *
   * No-op for a token-only client and while a live token has time left. Runs on
   * the raw fetch so it never recurses through the transport, and is guarded by
   * a single in-flight promise so two concurrent reads mint one token rather
   * than burning two nonces.
   */
  async ensureSession(): Promise<void> {
    if (this.signer === null) return;
    if (this.token !== null && Date.now() / 1000 < this.tokenExpiresAt - REFRESH_SKEW_SECONDS) {
      return;
    }
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(): Promise<void> {
    const signer = this.signer!;
    const { token, expiresAt } = await handshake(this.fetchImpl, this.baseUrl, signer);
    this.token = token;
    this.tokenExpiresAt = expiresAt ?? Date.now() / 1000 + 3600;
  }

  /**
   * The deployment every signature belongs to. Read once and never re-read: a
   * coordinator that changed the contract it relays to mid-session has changed
   * protocol, not configuration, and a client that quietly followed it would
   * re-sign against a registry the caller never chose.
   *
   * The **promise** is cached rather than the value, the way `minting` is above.
   * Caching the value leaves a window in which two callers both see `null`,
   * both issue the read, and walk away holding two different contexts — which
   * is the very thing the paragraph above says must not happen. A rejection
   * clears the cache so a failed read stays retryable rather than latching.
   */
  async chainContext(): Promise<ChainContext> {
    this.chain ??= this.transport
      .json("GET", "/evm/chain")
      .then((body) => ChainContext.fromWire(body))
      .catch((error: unknown) => {
        this.chain = null;
        throw error;
      });
    return this.chain;
  }

  /**
   * One page of a budgeted listing: the rows, the block it was read at, and the
   * two paging signals.
   *
   * **This reads the response rather than the body, and that is the point.**
   * The coordinator's response shapes are frozen and asserted exactly, so the
   * paging signals travel as headers instead — and `transport.json` throws the
   * headers away. Every listing that can be cut short therefore goes through
   * `transport.request` and decodes its own body.
   *
   * `nextOffset` is `pageAgain`'s answer and not the truncation header's. The
   * header is absent on a page the budget did not cut, *including a full page
   * with more rows behind it*, so a caller handed only the header would stop at
   * 100 rows of 150 and never learn it. This method is the one place in the
   * client that knows the `limit` the request carried, so it is the one place
   * that can evaluate the other half of the rule.
   */
  private async pageOf(
    path: string,
    key: string,
    query: { limit?: number; offset?: number },
    params: RequestOptions["params"],
  ): Promise<{ rows: unknown[]; asOfBlock: bigint | null } & PagedListing> {
    // Own properties only on the caller's query record and on the coordinator's
    // body alike (`own.ts`).
    const offset = (own(query, "offset") as number | undefined) ?? 0;
    // The limit the coordinator actually applied — the caller's, or its default
    // when the caller named none. Without it `returned === limit` is unaskable.
    const limit = (own(query, "limit") as number | undefined) ?? PAGE_DEFAULT_LIMIT;
    const response = await this.transport.request("GET", path, { params });
    const body = (await response.json()) as Record<string, unknown>;
    // Refuses a body it cannot find rows in rather than calling it an empty
    // listing — see `pageRows`. "No asks" is an answer a caller acts on.
    const page = readPage(response, pageRows(body, key, `GET ${path}`), offset);
    return {
      rows: page.items,
      asOfBlock: asBigInt(own(body, "as_of_block")),
      truncated: page.truncated,
      nextOffset: pageAgain(page, offset, limit),
    };
  }

  /** `GET /evm/asks`. `model` is an integer id, not a name. Paged. */
  async asks(query: { model?: number; limit?: number; offset?: number } = {}): Promise<AskBook> {
    const page = await this.pageOf("/evm/asks", "asks", query, {
      model: own(query, "model") as number | undefined,
      limit: own(query, "limit") as number | undefined,
      offset: own(query, "offset") as number | undefined,
    });
    return {
      asks: page.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          providerId: asNumber(own(r, "provider_id")),
          modelId: asNumber(own(r, "model_id")),
          sla: asNumber(own(r, "sla")),
          rateIn: usdOr(own(r, "rate_in")),
          rateOut: usdOr(own(r, "rate_out")),
        };
      }),
      asOfBlock: page.asOfBlock,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    };
  }

  /** `GET /evm/jobs` — the chain-shaped book. Paged. */
  async jobs(query: JobQuery = {}): Promise<JobBook> {
    const q = <K extends keyof JobQuery>(key: K): JobQuery[K] =>
      own(query as unknown as Record<string, unknown>, key) as JobQuery[K];
    const page = await this.pageOf("/evm/jobs", "jobs", query, {
      state: q("state"),
      model: q("model"),
      provider: q("provider"),
      owner: q("owner"),
      posted_before: q("postedBefore"),
      order: q("order"),
      limit: q("limit"),
      offset: q("offset"),
    });
    return {
      jobs: page.rows.map((row) => evmJobRow("GET /evm/jobs", row)),
      asOfBlock: page.asOfBlock,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    };
  }

  /**
   * `GET /evm/asks/floors`. `model` is an integer id, not a name. Paged.
   *
   * `sla` narrows to one window, in seconds. A push is an upsert on an
   * unvalidated `uint32`, so one provider can accumulate arbitrarily many
   * windows on a real model and make the unfiltered listing as long as it
   * likes; a caller pricing a job knows the window it wants.
   *
   * Every figure is **refused, never defaulted** — unlike `asks()`, which is a
   * display listing. The floor the server answers is the rate an order signs,
   * so a `"0"` for an unreadable rate is a model quoted as free.
   */
  async floors(
    query: { model?: number; sla?: SlaWindow; limit?: number; offset?: number } = {},
  ): Promise<FloorBook> {
    // `sla` is the tier name `submit` takes (`"async"` / `"batch"`, or the raw
    // window); the wire wants the window's seconds. An unknown name is refused
    // rather than defaulted — a floor is the rate an order signs.
    const sla = own(query, "sla");
    const seconds = sla === undefined ? undefined : knownWindowSeconds(String(sla));
    if (seconds === null) {
      throw new ValidationError(
        `floors: sla must be "async" or "batch" (or the window "1h" / "24h"), not ${JSON.stringify(sla)}`,
        { type: "invalid_request_error" },
      );
    }
    const page = await this.pageOf("/evm/asks/floors", "floors", query, {
      model: own(query, "model") as number | undefined,
      sla: seconds,
      limit: own(query, "limit") as number | undefined,
      offset: own(query, "offset") as number | undefined,
    });
    const what = "GET /evm/asks/floors";
    return {
      floors: page.rows.map((row) => {
        const r = figureRecord(what, row, "floors");
        return {
          modelId: countFigure(what, r, "model_id"),
          sla: countFigure(what, r, "sla"),
          rateIn: moneyFigure(what, r, "rate_in"),
          rateOut: moneyFigure(what, r, "rate_out"),
        };
      }),
      asOfBlock: page.asOfBlock,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    };
  }

  /**
   * `GET /evm/jobs/summary` — one wallet's counts and escrow sum.
   *
   * Every figure is refused rather than defaulted: a summary is printed as
   * money and as counts, and a `0` standing in for an unreadable value is a
   * plausible answer nobody would question.
   */
  async jobsSummary(query: { owner: string }): Promise<JobsSummary> {
    // Own properties only on the caller's record (`own.ts`). `owner` is the
    // whole filter here, so an inherited one reads a wallet this caller never
    // named — `jobs()` already drops it, and the two must not answer
    // differently for the same argument shape. Refused before anything is sent.
    const owner =
      typeof query === "object" && query !== null
        ? own(query as unknown as Record<string, unknown>, "owner")
        : undefined;
    if (typeof owner !== "string") {
      throw new ValidationError(
        "jobsSummary reads one wallet's totals and needs that wallet stated as " +
          "an own property: jobsSummary({ owner: '0x…' })",
        { type: "invalid_request_error" },
      );
    }
    const body = await this.json<Record<string, unknown>>("GET", "/evm/jobs/summary", {
      params: { owner },
    });
    const what = "GET /evm/jobs/summary";
    const rows = own(body, "by_model");
    if (!Array.isArray(rows)) refuseFigure(what, "by_model", "is not a list");
    return {
      jobs: countFigure(what, body, "jobs"),
      completed: countFigure(what, body, "completed"),
      escrowed: moneyFigure(what, body, "escrowed"),
      byModel: (rows as unknown[]).map((row) => {
        const r = figureRecord(what, row, "by_model");
        return {
          modelId: countFigure(what, r, "model_id"),
          jobs: countFigure(what, r, "jobs"),
          completed: countFigure(what, r, "completed"),
          escrowed: moneyFigure(what, r, "escrowed"),
        };
      }),
      asOfBlock: asBigInt(own(body, "as_of_block")),
    };
  }

  /**
   * Re-attach to an existing job from a persisted id — no network call.
   *
   * The handle is a view and carries no state a rerun could not rebuild, which
   * is why this costs nothing: everything it needs it reads when asked.
   */
  job(jobId: string): JobHandle {
    return new JobHandle(this, jobId);
  }

  /**
   * The two forwarding members `JobHandle` asks a client for (`jobs.ts:31,32`),
   * plus `fetchBlob` below. They are `Transport`'s own signatures verbatim, so
   * satisfying `JobClient` costs forwarding and nothing else — the handle never
   * learns there is a `Client` on the other side.
   *
   * Public rather than internal because a caller reaching a route this SDK has
   * not wrapped yet should not have to build a second HTTP client to do it, and
   * because these carry the session and the retry policy that a bare `fetch`
   * would not.
   */
  async json<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.transport.json<T>(method, path, options);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    return this.transport.request(method, path, options);
  }

  /**
   * Fetch content-addressed bytes by CID from the storage network's gateway.
   *
   * The read needs no authorization: the CID *is* the authorization. Knowing the
   * name is the whole entitlement to the bytes, and a name nobody handed you is
   * not one you can guess — so this goes out on the raw `fetch`, with neither
   * the session token nor the coordinator's base URL anywhere near it.
   *
   * The gateway is the only read path. The coordinator serves no blob endpoint,
   * so a gateway failure raises rather than falling back to one, and a client
   * built with `gateway: ""` has no read path at all until it supplies one.
   */
  async fetchBlob(cid: string): Promise<Uint8Array> {
    return fetchBlob({ cid, gateway: this.gateway, fetchImpl: this.fetchImpl });
  }

  // -- files ---------------------------------------------------------------

  /**
   * `POST /v1/files` — file the bytes and return the object the node minted.
   *
   * A multipart upload, because that is what the OpenAI files API is and what
   * every stock client sends. `purpose` is `batch` (a batch input file — the
   * JSONL of lines), `input` (a sealed container, over the submit path's
   * `INLINE_MAX_BYTES`) or `result` (a sealed result). `batch_output` is minted
   * by the node at finalization and is refused at this door. Bytes uploaded under
   * any purpose are already sealed — a container or a result carries its own
   * ciphertext, and a batch input file is a file of already-sealed lines — so the
   * file the coordinator receives holds routing terms and ciphertext and nothing
   * a reader could act on.
   *
   * `batch` travels as JSONL; `input` and `result` are opaque ciphertext and
   * travel as `application/octet-stream`.
   *
   * **No `content-type` header is set on the request.** `fetch` derives it from
   * the `FormData`, boundary parameter and all; a hand-set header would carry
   * no boundary and the multipart parser on the other side would reject the
   * body.
   *
   * `retry: false`: an upload that may have landed is never repeated. The one
   * re-send that remains is the transport's single 401 re-auth, which is safe
   * for a `FormData` — it can be serialized again — and would not be for a
   * stream, which is the reason this takes bytes rather than one.
   */
  async uploadFile(
    filename: string,
    purpose: string,
    content: Uint8Array | string,
  ): Promise<VorqFile> {
    const contentType = purpose === "batch" ? undefined : "application/octet-stream";
    // No deadline of its own: the transport's `DEFAULT_TIMEOUT_MS` is already
    // sized for the largest upload this door takes. What the door will *store*
    // is the door's business — this client does not restate `MAX_BLOB_BYTES`,
    // so there is no second copy of it to drift.
    const row = await this.transport.json<Record<string, unknown>>("POST", "/v1/files", {
      body: buildUpload(filename, purpose, content, contentType),
      retry: false,
    });
    return fileFrom(row);
  }

  /**
   * `GET /v1/files/{id}` — the file object.
   *
   * A miss and a stranger's file are the **same** answer, deliberately: a `403`
   * on someone else's id would confirm the id is real, and a file id is the
   * only thing standing between one client's batch input and another's. So this
   * raises `NotFoundError` for both and there is nothing here to tell them
   * apart with.
   */
  async file(fileId: string): Promise<VorqFile> {
    return fileFrom(
      await this.transport.json<Record<string, unknown>>(
        "GET",
        `/v1/files/${encodeURIComponent(fileId)}`,
      ),
    );
  }

  /**
   * `GET /v1/files/{id}/content` — the object's bytes as text, whole.
   *
   * Text, deliberately, where `buildUpload` is byte-exact: both files this
   * reads are JSONL this network wrote, and JSON is UTF-8 by definition — a
   * sealed line's ciphertext travels base64-encoded *inside* it, so there is
   * nothing here that a decode could lose. The asymmetry is the Python
   * client's too.
   */
  async fileContent(fileId: string): Promise<string> {
    const response = await this.transport.request(
      "GET",
      `/v1/files/${encodeURIComponent(fileId)}/content`,
    );
    return response.text();
  }

  /** `GET /evm/jobs/:job_id` — the chain shape rather than the client shape. */
  async evmJob(jobId: string): Promise<EvmJob> {
    const path = `/evm/jobs/${encodeURIComponent(jobId)}`;
    return evmJobRow(`GET ${path}`, await this.transport.json<unknown>("GET", path));
  }

  /** `GET /evm/providers/:id`. */
  async providers(id: number): Promise<ProviderRecord> {
    const row = await this.transport.json<Record<string, unknown>>(
      "GET",
      `/evm/providers/${Math.trunc(id)}`,
    );
    // **Own properties only, and `box_key` is the reason the rule exists.**
    // This row is `JSON.parse` output, and `boxKey` is handed straight to
    // `recipientFor` as the key the payload is sealed to. Read bare, a row that
    // omits `box_key` is answered by a polluted `Object.prototype.box_key` — so
    // the `provider N publishes no box_key` refusal below never fires and a
    // **non-confidential designated order seals to a key nobody published**.
    // `verifyRecord` does not catch it: it guards only the `confidential: true`
    // branch, and every batch line is `confidential: false` by construction.
    return {
      providerId: asNumber(own(row, "provider_id")),
      operator: String(own(row, "operator") ?? ""),
      boxKey: String(own(row, "box_key") ?? ""),
      listed: own(row, "listed") === true,
      raw: row,
    };
  }

  /**
   * `GET /evm/allowlist`. A revoked entry is a tombstone with `status: 2`.
   * Paged — and the listing most likely to meet the byte budget, since an
   * `entry` is arbitrary bytes the chain does not bound.
   */
  async allowlist(query: { limit?: number; offset?: number } = {}): Promise<Allowlist> {
    const page = await this.pageOf("/evm/allowlist", "entries", query, {
      limit: own(query, "limit") as number | undefined,
      offset: own(query, "offset") as number | undefined,
    });
    return {
      entries: page.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          key: String(own(r, "key") ?? ""),
          status: asNumber(own(r, "status")),
          entry: own(r, "entry"),
        };
      }),
      asOfBlock: page.asOfBlock,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    };
  }

  /**
   * `GET /key` — the coordinator's escrow key announcement, reshaped.
   *
   * **The open-order path does not go through this method, and must not be
   * refactored to.** `escrowRecipient` reads the same route and hands the
   * verifier the **raw** body, because `verifyEscrowKey` reads
   * `escrow_public_key` and `issued_at` — the names the node sends — and this
   * method renames both. Sharing the read would refuse every honest node while
   * looking exactly like a verification failure. This one is the caller-facing
   * read, and it verifies nothing.
   */
  async escrowKey(): Promise<EscrowKeyAnnouncement> {
    const body = await this.transport.json<{
      escrow_public_key?: unknown;
      evidence?: unknown;
      issued_at?: unknown;
    }>("GET", "/key");
    // Own properties only, for consistency with the rest of the file rather
    // than because anything rests on it: **this method is not on the sealing
    // path.** `escrowRecipient` reads `GET /key` separately and hands the
    // verifier the raw body, as the comment above says, so a prototype-supplied
    // key here reaches a caller's console and nothing else.
    return {
      escrowPublicKey: String(own(body, "escrow_public_key") ?? ""),
      evidence: own(body, "evidence"),
      issuedAt: asNumber(own(body, "issued_at")),
    };
  }

  // -- submission ---------------------------------------------------------------

  /**
   * Submit a job — always `POST /v1/jobs`, whatever the modality.
   *
   * A `string` input is sugar for `{ input: string }`; an object is the
   * model-owned input, sent verbatim.
   *
   * Submissions are always sealed, so a `signer` and a `cipher` are both
   * required. It takes exactly two requests. The first carries the terms and
   * nothing else and comes back a `402` with the payment requirements. The
   * client then seals the payload into **one container v1** — the bulk under a
   * DEK derived from a fresh 32-byte seed, and the **seed** sealed to the chosen
   * provider — signs the order over that container's commitment and the payment
   * authorization, and posts terms and bytes together. **The container crosses
   * the wire once.**
   *
   * Two orders take a `verifier`, and a client built without one refuses both
   * before anything is posted: an **open** order (no `provider`), whose payload
   * is sealed to the coordinator's escrow key and so needs that key's evidence
   * checked, and a **confidential** one, which needs the designated provider's.
   */
  async submit(args: SubmitArgs): Promise<JobHandle> {
    await this.resultCipher();
    const { signer } = this.sealing();
    // Before any request: a confidential submission that cannot verify anything
    // must not reach the network at all.
    //
    // **Truthy, not `=== true`.** A plain-JS caller writing `confidential: 1`
    // means it, and an R6 flag this client cannot honour must fail closed on
    // anything that is not plainly "no", rather than post the order
    // unprotected.
    //
    // `recipientFor` makes the same check, and neither is redundant. That one
    // guards `sealLine`, which is public and can be handed
    // `confidential: true` by any caller that reaches it directly; this one
    // guards the door callers actually use, and does it **before** the two
    // network reads that stand between `sealLine` and its own check.
    // **Own properties only on the caller's args record** (`own.ts`). `provider`
    // decides who the payload is sealed to and `rateIn`/`rateOut`/`sla` are
    // signed, settled terms, so a bare read lets a polluted prototype state
    // terms — and a recipient — that this SDK then signs on the caller's behalf.
    // One guard for the whole method.
    const arg = <K extends keyof SubmitArgs>(key: K): SubmitArgs[K] =>
      own(args as unknown as Record<string, unknown>, key) as SubmitArgs[K];
    if (arg("confidential") && this.verifier === null) refuseConfidential();

    const rawInput = arg("input");
    const payloadInput: Record<string, unknown> =
      typeof rawInput === "string" ? { input: rawInput } : rawInput;
    const window = normalizeSla(arg("sla") ?? "batch");

    if (arg("validateParams") !== false) {
      let schema: unknown = null;
      try {
        schema = await this.models.paramsSchema(arg("model"));
      } catch {
        schema = null; // a network hiccup on discovery never blocks a submit
      }
      // **Deliberate divergence from the authority, in mechanism only.** Python
      // raises a `UserWarning` from inside `check_input`; there is no such
      // channel here, so `checkInput` returns its warnings and the caller — this
      // one line — is what makes them visible. The set of conditions warned
      // about, and the wording, are the same in both SDKs; only the door differs.
      // A warning is never a refusal: an unknown param passes through, because
      // the serving provider may well understand it.
      for (const warning of checkInput(schema, payloadInput)) console.warn(warning);
    }

    // Local validation before the first network read, which is the order the
    // authority states (`_client.py:620-621`: `_declare_units` precedes
    // `chain_context()`). A malformed `unitsOut` is a caller mistake and
    // nothing on the chain can change the answer, so finding it after a round
    // trip only means a `TransportError` from a read that was never needed
    // reaches the caller ahead of the `ValidationError` that names the problem.
    // `declareUnits` is pure, so running it here and again inside `sealLine`
    // decides nothing twice.
    const units = declareUnits(payloadInput, arg("unitsOut"));
    const ctx = await this.chainContext();

    // **No bid named is the market.** An unsigned probe asks the node for every
    // live ask ranked; the order then bids the first candidate's own ask, pinned
    // to it. With `provider` the probe is pinned too, so the answer is that
    // provider's ask or nothing.
    let rateIn = arg("rateIn");
    let rateOut = arg("rateOut");
    let provider = arg("provider");
    if ((rateIn === undefined || rateIn === null) && (rateOut === undefined || rateOut === null)) {
      ({ rateIn, rateOut, provider } = await this.market({
        model: arg("model"),
        window,
        provider,
        confidential: Boolean(arg("confidential")),
        unitsIn: units.unitsIn,
        unitsOut: units.unitsOut,
      }));
    }

    // -- the recipient, and therefore the container --------------------------
    //
    // Both order paths converge on one container. The only difference between
    // them is who the seed is sealed to, and that choice is invisible from
    // outside the wrap. **Both verifications happen inside `sealLine`**, before
    // a byte is posted: an open order's escrow key and a confidential order's
    // provider record are each checked while the recipient is being chosen, so
    // a failure raises with nothing on the wire but the reads that made it.
    const line = await this.sealLine({
      model: arg("model"),
      payloadInput,
      window,
      // A single job is a Responses submission. The URL is a batch-file field
      // and is not on a `POST /v1/jobs` body, so it is unused on this path —
      // named rather than left blank so the two callers read the same.
      url: "/v1/responses",
      rateIn,
      rateOut,
      provider,
      confidential: arg("confidential") ?? false,
      unitsOut: arg("unitsOut"),
      customId: arg("customId"),
      ctx,
    });
    const { jobId, order } = line;

    // -- phase 1: the terms-only challenge -----------------------------------
    //
    // No bytes leave the client here. The quote is arithmetic over the signed
    // terms plus one cached gas read, so the challenge needs no payload — and a
    // client that sent one anyway would be told to sign a quote and come back,
    // uploading the same megabytes a second time.
    const challenge = await this.transport.request("POST", "/v1/jobs", {
      json: order,
      retry: false,
      allowStatuses: [402],
    });
    // A terms-only body has exactly one answer, and it is the quote. The node
    // returns `402` unconditionally when `auth_sig` is absent, and a success here
    // would mean a job posted with **no container**, which names no task and is
    // refused on chain as `EmptyTaskCid`. So a non-402 is not a shortcut, it is a
    // server this client does not know.
    if (challenge.status !== 402) {
      // `.catch`, not `void`: nothing will read this body, and under undici an
      // unread one holds its connection until the socket is collected — but a
      // `cancel()` that rejects (a body already locked, say) would become an
      // unhandled rejection thrown out of a process that is about to be told the
      // real reason below.
      challenge.body?.cancel().catch(() => {});
      throw new VorqError(
        `POST /v1/jobs answered ${challenge.status} to a terms-only body; only a 402 ` +
          "quote is a valid answer to one, because a job posted without a container " +
          "names no task and is refused on chain",
        { type: "api_error", statusCode: challenge.status },
      );
    }
    let challengeBody: unknown = {};
    try {
      challengeBody = await challenge.json();
    } catch {
      // A gateway's HTML, an empty body: `quoteFrom` reads no quote out of `{}`
      // and produces the same "no quote to sign" refusal it would for a 402
      // that was honest JSON with nothing useful in it.
    }
    let quote = this.quoteFrom(challengeBody, jobId, ctx, line.terms.expiresAt);

    // -- the container: inline, or uploaded once ahead of the post -----------
    //
    // At or under `INLINE_MAX_BYTES` the sealed bytes ride the job body as
    // base64; over it, they are filed first and referenced by cid.
    //
    // **Resolved once, on first use, and never on a re-quote.** Memoised rather
    // than computed here because *when* the bytes are filed decides how much of
    // the node's 300 s orphan window a submission spends before it can attach
    // them. Filing ahead of `signPaymentAuthorization` spends that window on a
    // wallet prompt — in a browser, a dialog waiting on a person who may have
    // changed tabs — and an upload the sweep collects is a post refused
    // `unknown_container`, which the node marks not retryable. The payment does
    // not depend on the container, so signing first costs nothing and a caller
    // who declines the prompt never uploads at all.
    //
    // The memo is what keeps it out of the attempt loop: a `409` re-quote
    // re-signs the payment and re-sends the reference, never the payload.
    let containerField: Record<string, unknown> | null = null;
    const container = async (): Promise<Record<string, unknown>> => {
      if (containerField !== null) return containerField;
      if (line.container.length <= INLINE_MAX_BYTES) {
        return (containerField = { container: toBase64(line.container) });
      }
      const upload = await this.uploadFile("container", "input", line.container);
      // Refused rather than sent on. `container_cid: null` is a body the node
      // answers `container_required` to, which reads as "this SDK forgot the
      // container" — and the real fault is an upload answer with no name in it,
      // which no re-post can put right.
      if (upload.cid === null) {
        throw new VorqError(
          `POST /v1/files answered no vorq.cid for file ${upload.id}, so there is no name to ` +
            "post this container against",
          { type: "api_error" },
        );
      }
      return (containerField = { container_cid: upload.cid });
    };

    // -- phase 2: the complete submission, bounded ---------------------------
    //
    // `retry: false`: a POST that may have had an effect is never repeated.
    //
    // The container is on this request and never on a challenge, so a `402`
    // answered to it is a protocol violation rather than a loop to run. The one
    // status that legitimately sends a complete submission back is a `409`
    // carrying a `quote` — the gas fee drifted — and it arrives in the `402`'s
    // own body shape, which is why "sign this quote" is one code path here
    // whatever status delivered it. **The two `409`s are told apart by body and
    // never by status.**
    for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt += 1) {
      // The payment first, the container second — see the memo above. Spelled as
      // two statements rather than one object literal, because the order of
      // effects is the point and property order would not enforce it.
      const authSig = await signer.signPaymentAuthorization({
        amount: quote.amount,
        jobId,
        expiresAt: line.terms.expiresAt,
        ctx,
      });
      const body: Record<string, unknown> = {
        ...order,
        ...(await container()),
        auth_sig: authSig,
        amount: formatUsd(quote.amount, ctx.decimals),
      };
      const sent = await this.sendComplete(body, jobId);
      // The pre-check found it already posted: a row, not a response.
      if (!(sent instanceof Response)) return this.handleFromJob(sent, jobId, window);
      if (sent.status === 402) {
        sent.body?.cancel().catch(() => {});
        throw new VorqError(
          "the node answered 402 to a body carrying a container. A container makes a " +
            "body a complete submission, which is never answered with a quote — " +
            "looping on this would re-upload the whole payload to be quoted again.",
          { type: "api_error", statusCode: 402 },
        );
      }
      if (sent.status === 409) {
        let refusal: unknown = {};
        try {
          refusal = await sent.json();
        } catch {
          // A gateway's HTML, an empty body: the status is still the answer, and
          // a body with no `quote` in it is the chain's refusal either way.
        }
        // `Object.hasOwn`, not `in`: `refusal` is `JSON.parse` output off the
        // wire, and this package reads such a record own-properties only (see
        // `own.ts`). A bare `in` would let a polluted `Object.prototype.quote`
        // route a plain chain refusal into the re-quote branch.
        if (typeof refusal === "object" && refusal !== null && Object.hasOwn(refusal, "quote")) {
          // Not a challenge: a refusal with the remedy attached. The terms and
          // `c` are unchanged, so the container is reused verbatim above and
          // only the payment is re-signed.
          quote = this.quoteFrom(refusal, jobId, ctx, line.terms.expiresAt);
          continue;
        }
        throw errorFromWire(sent.status, refusal, {
          requestId: sent.headers.get("x-request-id"),
        }); // the chain refused it
      }
      let accepted: Record<string, unknown> = {};
      try {
        accepted = (await sent.json()) as Record<string, unknown>;
      } catch {
        // A gateway's HTML, a truncated body: the job is already posted and
        // paid for, and the handle below is built from the locally computed
        // `jobId` rather than anything this response would have echoed, so an
        // unreadable body is not a reason to lose it.
      }
      return this.handleFromJob(accepted, jobId, window);
    }
    throw new VorqError(
      `the node re-quoted this submission ${MAX_SUBMIT_ATTEMPTS} times without accepting ` +
        "it; the gas fee is drifting faster than the order can be signed, so the " +
        "container is not uploaded again",
      { type: "api_error", statusCode: 409 },
    );
  }

  /**
   * Seal, price and sign one submission. **No network beyond discovery.**
   *
   * Every field of the order is decided here, so the commitment `c` and
   * therefore `job_id` are fixed before anything is uploaded — which is what
   * lets a dropped connection be resolved by asking rather than by re-sending,
   * and what lets a batch price itself with one gas read instead of one quote
   * per line.
   *
   * Public rather than private for the same reason `json`/`request` above are:
   * a batch client is declared in terms of this method and an interface cannot
   * name a private member. It is a low-level door and not the one to reach for
   * — a caller wanting a job should call `submit`, which does the sealing, the
   * quote and the post in one — but nothing here restricts it, and `SealLineArgs`
   * and `SealedLine` are both on the barrel so a caller assembling a batch by
   * hand can annotate every value it moves.
   */
  async sealLine(args: SealLineArgs): Promise<SealedLine> {
    await this.resultCipher();
    const { signer } = this.sealing();
    const owner = signer.address;
    // Own properties only, same rule and same stakes as `submit` above: this
    // method is public, so its args record arrives from a caller too, and
    // `provider` here is the one that chooses the seal recipient.
    const arg = <K extends keyof SealLineArgs>(key: K): SealLineArgs[K] =>
      own(args as unknown as Record<string, unknown>, key) as SealLineArgs[K];
    const { unitsIn, unitsOut } = declareUnits(arg("payloadInput"), arg("unitsOut"));
    const ctx = arg("ctx");
    const { recipient, designated } = await this.recipientFor(
      arg("provider"),
      // `false` by omission, which is the batch surface's answer: it carries no
      // confidential flag in either SDK, so a batch line never sets one.
      arg("confidential") ?? false,
    );
    const { container, c } = this.sealContainer(
      recipient,
      arg("payloadInput"),
      owner,
      arg("customId"),
    );
    const jobId = jobIdFor(owner, c);
    const terms = new OrderTerms({
      c,
      modelId: await this.modelIdFor(arg("model")),
      slaSecs: slaSeconds(arg("window")),
      rateIn: parseRate(arg("rateIn"), "rate_in", ctx.decimals),
      rateOut: parseRate(arg("rateOut"), "rate_out", ctx.decimals),
      unitsIn,
      unitsOut,
      designated,
      expiresAt: this.expiresAt(arg("window")),
    });
    return {
      url: arg("url"),
      terms,
      jobId,
      order: terms.toWire({
        owner,
        jobId,
        signature: await signer.signOrderV2(terms, ctx),
        decimals: ctx.decimals,
      }),
      container,
    };
  }

  /**
   * Authorize one sealed line and render the JSONL row.
   *
   * Separate from the sealing because the two need different things: sealing
   * needs a recipient key and produces the commitment the order signs, and this
   * needs the chain's `gasFee` and `feeBps`, which are one read for the whole
   * batch. Split that way the file is sealed **once** — a client that read the
   * fees after sealing and then re-sealed would mint a fresh seed, a fresh `c`
   * and a fresh job id for every line it had already paid to encrypt.
   *
   * **The token and the payee come from the chain context, never from a quote**
   * (R6). Every member of this authorization is client-derivable except `gasFee`
   * and `feeBps`, and deriving the rest is what keeps a node from naming what a
   * signature authorizes.
   *
   * Public for the reason `sealLine` above is, and the same advice applies:
   * prefer `submit` for a job and `batches.submit` for a file, and reach for
   * this only when assembling a batch by hand.
   */
  async payLine(
    line: SealedLine,
    gasFee: bigint,
    ctx: ChainContext,
    feeBps: bigint,
  ): Promise<Record<string, unknown>> {
    const { signer } = this.sealing();
    // **Own properties only on the sealed line** (`own.ts`). `payLine` is a
    // public `Client` member and `SealedLine` is on the package barrel, so this
    // record can arrive from a caller; it is applied here rather than because
    // any in-SDK path reaches it: `batches.ts` always passes a full `sealLine`
    // result, every key of which is own. `terms` is the sharp one —
    // `capFor(terms)` is the cap half of `amount`, which is the **value** this
    // line authorizes, and `terms.expiresAt` is the window it is valid in.
    const stated = <K extends keyof SealedLine>(key: K): SealedLine[K] =>
      own(line as unknown as Record<string, unknown>, key) as SealedLine[K];
    const terms = stated("terms");
    const cap = capFor(terms);
    // the protocol fee rides on top of the cap, floored as the chain floors it
    const amount = cap + (cap * feeBps) / 10000n + gasFee;
    // Flat, exactly the `POST /v1/jobs` fields — a line is one submission —
    // with the container base64 inside the JSON rather than as a file part.
    return {
      url: stated("url"),
      ...stated("order"),
      container: toBase64(stated("container")),
      auth_sig: await signer.signPaymentAuthorization({
        amount,
        jobId: stated("jobId"),
        expiresAt: terms.expiresAt,
        ctx,
      }),
      amount: formatUsd(amount, ctx.decimals),
    };
  }

  /**
   * POST the complete submission; on a dropped connection, **read before
   * rewriting**.
   *
   * Returns the response, or the job row when the connection dropped and the job
   * turned out to be posted after all.
   *
   * **The pre-check is the mechanism, not an optimisation, and it must not be
   * replaced by server-side idempotency later.** The coordinator investigated
   * exactly that and proved it impossible: its `jobs` table is a pure projection
   * of the `Posted` event, which carries neither signature, and every field a
   * comparison could be built from — owner, `c`, the rates, the unit counts,
   * `expiresAt`, even `task_cid`, whose mint is content-addressed — is public
   * calldata a front-runner copies verbatim out of the mempool. A server
   * comparing those columns would hand an attacker's job row back to this client
   * as its own, complete with a `job_id`, a `task_cid` and a `tx_hash`, for a job
   * whose `authSig` is garbage and which no provider can ever claim. That is
   * strictly worse than the refusal it would replace.
   *
   * What makes the client side sound is the one thing the server does not have:
   * this client knows `job_id = keccak256(owner ‖ c)` *before* it sends, because
   * it chose the seed and built the container. So it can name the job and ask. A
   * hit is its own job by construction — nobody else can produce this `c` without
   * the seed inside the wrap — and a miss is a genuine absence, which is the only
   * case where re-uploading is right.
   */
  private async sendComplete(
    body: unknown,
    jobId: Hex,
  ): Promise<Response | Record<string, unknown>> {
    // A plain object is re-serialized on every `fetch`, which is what makes
    // the one re-send below — and the transport's 401 re-auth — safe. Any
    // upload the body references by cid already happened once, ahead of this
    // call, and is never repeated here.
    const send = (): Promise<Response> =>
      this.transport.request("POST", "/v1/jobs", {
        json: body,
        retry: false,
        allowStatuses: [402, 409],
      });
    try {
      return await send();
    } catch (error) {
      // Only a connection that died: a status is an answer, and an answer is
      // never something to reconcile against a read.
      if (!(error instanceof TransportError)) throw error;
      const posted = await this.postedJob(jobId);
      if (posted !== null) return posted;
      // Genuinely absent: the bytes never landed, so send them once more. If
      // this one drops too it raises — an unbounded rewrite loop is the same
      // defect as an unbounded 402 loop wearing a different hat.
      try {
        return await send();
      } catch (again) {
        // The first failure is the one worth reporting: it is the one that
        // happened to the request that might have been received.
        throw again instanceof TransportError ? error : again;
      }
    }
  }

  /**
   * `GET /v1/jobs/{id}` — the job, or `null` if this node has no such row.
   *
   * A `404` is a genuine absence. Anything else that goes wrong here is
   * **unknown**, which is not evidence the job landed: it answers `null` too, so
   * the caller re-sends rather than swallowing a submission on a read that
   * merely failed.
   */
  private async postedJob(jobId: Hex): Promise<Record<string, unknown> | null> {
    try {
      return await this.transport.json<Record<string, unknown>>(
        "GET",
        `/v1/jobs/${encodeURIComponent(jobId)}`,
      );
    } catch (error) {
      if (error instanceof VorqError) return null;
      throw error;
    }
  }

  /** The signer and cipher a submission cannot proceed without. */
  private sealing(): { signer: Signer; cipher: Cipher } {
    if (this.signer === null || this.cipher === null) {
      throw new ValidationError(
        "submissions are always sealed: set $VORQ_WALLET_KEY or pass a signer " +
          "(new Client({ signer }))",
        { type: "invalid_request_error" },
      );
    }
    return { signer: this.signer, cipher: this.cipher };
  }

  /**
   * The `vorq-env-v1` plaintext: who ordered, where to send the result back, and
   * the model input.
   *
   * Sealing the owner and the result key alongside the payload takes them off
   * the wire entirely — whoever opens the box is the only party that learns
   * which client the task belongs to and which key to seal the result to.
   */
  private envelope(
    payloadInput: Record<string, unknown>,
    customId?: string | null,
  ): Record<string, unknown> {
    const { signer, cipher } = this.sealing();
    const envelope: Record<string, unknown> = {
      v: ENVELOPE_VERSION,
      owner: signer.address,
      result_key: cipher.publicKey,
      input: payloadInput,
    };
    if (customId !== undefined && customId !== null) {
      // Absent rather than null when unset: this object is canonicalized into
      // the commitment preimage, so a key that carries no meaning must not be
      // there — it would change `c`.
      envelope.custom_id = customId;
    }
    return envelope;
  }

  /**
   * Seal one payload into a container v1. Returns the bytes and their `c`.
   *
   * Envelope → canonical JSON → fresh **seed** → DEK derived from the seed and
   * this order's owner → secret box over the bulk → sealed box over the **seed**
   * → `version ‖ wrap ‖ ciphertext`.
   *
   * **The wrap seals the seed, not the DEK, and that is load-bearing.** The wrap
   * is public — anyone who knows a container's name can fetch it — so an
   * attacker can lift this wrap verbatim, wrap a fresh commitment around it,
   * post and claim their own dust order, and ask the escrow to open it. Every
   * field of that request is honest, and no check over public data can refuse
   * it. What refuses it is this line: the DEK is `HKDF-SHA256(seed,
   * info="vorq-dek" ‖ owner20)`, and whoever opens the wrap derives with **the
   * job's owner as the chain reports it** — so the attacker gets a key derived
   * under their own address, which does not open these bytes.
   *
   * Sealing the DEK here instead would still produce a byte-perfect container
   * and a job **no provider could ever decrypt**; nothing structural catches
   * that, which is why the suite opens a real submission's wrap and asserts what
   * came out of it.
   */
  private sealContainer(
    recipientBoxKey: string,
    payloadInput: Record<string, unknown>,
    owner: string,
    customId?: string | null,
  ): { container: Uint8Array; c: `0x${string}` } {
    const plaintext = canonicalBytes(this.envelope(payloadInput, customId));
    const seed = newSeed();
    const ciphertext = encryptUnderDek(plaintext, deriveDek(seed, owner));
    const container = buildContainer(sealSeedTo(recipientBoxKey, seed), ciphertext);
    return { container, c: commitmentOf(container) };
  }

  /**
   * Who the payload is sealed to, and what `designated` says about it.
   *
   * Two paths and one shape. A named provider is sealed to its registry
   * `box_key`; an open order is sealed to the coordinator's **verified** escrow
   * key. `designated` is the provider id or `0` — the contract's own sentinel
   * for "any provider", never a null.
   */
  private async recipientFor(
    provider: number | undefined | null,
    confidential: boolean,
  ): Promise<{ recipient: string; designated: number }> {
    if (confidential && this.verifier === null) refuseConfidential();
    if (provider === undefined || provider === null) {
      return { recipient: await this.escrowRecipient(), designated: 0 };
    }
    const record = await this.providers(provider);
    if (confidential) {
      // An unverified pin is a refusal and never a substitution: this raises
      // rather than quietly sealing to somebody else.
      //
      // The **raw** row, not the reshaped `ProviderRecord`: the verifier reads
      // `box_key` and `operator`, which are the names the node sends, and a
      // camel-cased object would refuse every honest record while looking
      // exactly like a verification failure.
      await this.verifier!.verifyRecord(record.raw);
    }
    if (record.boxKey === "") {
      throw new VerificationError(
        `provider ${provider} publishes no box_key, so there is nobody to seal this ` +
          "payload to",
      );
    }
    return { recipient: record.boxKey, designated: provider };
  }

  /**
   * The coordinator's **verified** escrow public key, for an open order.
   *
   * Fail closed: an open order's payload is sealed to this key and to nothing
   * else, so a key that cannot be shown to be what it claims raises
   * `EscrowKeyUnverified` and **nothing is posted**.
   *
   * **The guarantee is "verified within the last `KEY_CACHE_TTL_S`", not
   * "verified now", and the difference is worth stating because it is three
   * hours wide.** A key is verified once and then reused for that window with no
   * re-check, so a revocation landing mid-window does not reach an order sealed
   * inside it: the announcement stops verifying, and this client keeps sealing
   * to the key it already accepted until the window lapses.
   *
   * **`verifier.refresh()` does not shorten it.** That method drops the
   * *verifier's* allowlist cache, which is a different cache in a different
   * object; this one has no invalidation door at all. A caller acting on a
   * revocation notice should build a new client, which starts with an empty
   * cache — or name a provider, which does not consult this key.
   *
   * That is the authority's behaviour too (`_client.py:942-944, 962`, which
   * caches on the same terms and exposes no invalidation either), so narrowing
   * the window here would be a cross-SDK design change rather than a fix.
   *
   * There is deliberately no automatic fallback to a designated bid.
   * Re-targeting is the caller's decision — `submit({ provider: N })` — because
   * an SDK that picked one here would have turned a fail-closed into a
   * fail-quiet, and the caller would never learn that the order it thought was
   * escrow-protected went to a provider it did not choose.
   *
   * A client built without a verifier cannot verify anything, so it cannot post
   * an open order at all. That is not a gap in the check; it is the check:
   * "unverifiable" includes "no way to verify".
   */
  private async escrowRecipient(): Promise<string> {
    const now = this.escrowClock();
    if (this.escrowKeyCache !== null && now < this.escrowKeyExpiresAt) {
      return this.escrowKeyCache;
    }
    if (this.verifier === null) {
      throw new EscrowKeyUnverified(
        "an open order seals its payload to the coordinator's escrow key, and this " +
          "client has no verifier to check that key's evidence with. Build the client " +
          "with `verifier`, or name a provider with submit({ provider: N }). Nothing " +
          "was posted",
      );
    }
    // The raw body, **not** `escrowKey()`'s reshaped one (R8): `verifyEscrowKey`
    // reads `escrow_public_key` and `issued_at`, which are the names the node
    // sends. A camel-cased object would refuse every honest node while looking
    // exactly like a verification failure.
    const body = await this.transport.json<unknown>("GET", "/key");
    let key: string;
    try {
      key = await this.verifier.verifyEscrowKey(body);
    } catch (error) {
      // Only a verification failure becomes this. A `TransportError` from a dead
      // socket is not a key that failed to verify and must reach the caller as
      // what it is.
      if (!(error instanceof VerificationError)) throw error;
      const refusal = new EscrowKeyUnverified(
        `the coordinator's escrow key did not verify (${error.message}), so this open ` +
          "order was not posted. Name a provider with submit({ provider: N }) to " +
          "re-target it deliberately",
      );
      // Assigned rather than passed: `VorqErrorOptions` is `{type, requestId,
      // statusCode}` and carries no `cause`, and widening it for one call site
      // would put a member on every error class in the SDK. This is Python's
      // `raise … from exc`.
      refusal.cause = error;
      throw refusal;
    }
    this.escrowKeyCache = key;
    this.escrowKeyExpiresAt = now + KEY_CACHE_TTL_S;
    return key;
  }

  /**
   * Resolve a model name to the catalog's numeric id.
   *
   * The order signs a `uint32`, because that is what the registry stores. A name
   * the catalog carries no id for is an error here rather than a `0` that would
   * post an order against whatever model happens to be first.
   */
  /**
   * The market for an order that names no bid: the first candidate the node
   * ranks, and its own ask.
   *
   * The probe is `POST /v1/jobs` with no rates and no signature. It commits to
   * nothing, so it costs no wallet prompt, and the node answers `402` with the
   * live asks ranked (cheapest for this job, then least recently picked) and no
   * quote. Under `confidential` an unpinned list is filtered to candidates whose
   * record verifies. No candidate raises before anything is signed.
   */
  private async market(args: {
    model: string;
    window: string;
    provider: number | null | undefined;
    confidential: boolean;
    unitsIn: number;
    unitsOut: number;
  }): Promise<{ rateIn: string; rateOut: string; provider: number }> {
    const pinned = args.provider !== undefined && args.provider !== null;
    const response = await this.transport.request("POST", "/v1/jobs", {
      json: {
        model_id: await this.modelIdFor(args.model),
        sla_secs: slaSeconds(args.window),
        units_in: args.unitsIn,
        units_out: args.unitsOut,
        designated: pinned ? args.provider : 0,
      },
      retry: false,
      allowStatuses: [402],
    });
    if (response.status !== 402) {
      response.body?.cancel().catch(() => {});
      throw new VorqError(
        `POST /v1/jobs answered ${response.status} to a market probe; only a 402 naming the ` +
          "candidates is a valid answer to one",
        { type: "api_error", statusCode: response.status },
      );
    }
    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      // An unreadable body names no candidates, and is refused below as one.
    }
    let candidates = candidatesOf(body);
    if (candidates.length === 0) {
      throw new ValidationError(
        `${pinned ? `provider ${args.provider} is not` : "no provider is"} serving ${args.model} ` +
          `in the ${args.window} window right now; nothing was signed. Try another window or ` +
          "model, or pass rateIn and rateOut to post a bid that rests until a provider takes it",
        { type: "invalid_request_error" },
      );
    }
    // Unpinned and confidential: the node's ranking, filtered to what attests. A
    // pinned order is verified once, by `recipientFor`, which refuses rather
    // than substitutes.
    if (args.confidential && !pinned) {
      const named = candidates.length;
      // The verifier keeps the very records it was handed, filtered.
      candidates = (await this.verifier!.verifyCandidates(candidates)) as unknown as MarketCandidate[];
      if (candidates.length === 0) {
        throw new VerificationError(
          `none of the ${named} candidate(s) the challenge named verified against the ` +
            "allowlist; nothing was sealed",
        );
      }
    }
    const chosen = candidates[0]!;
    if (pinned && chosen.provider_id !== args.provider) {
      throw new VorqError(
        `the node answered a probe pinned to provider ${args.provider} with provider ` +
          `${chosen.provider_id}`,
        { type: "api_error", statusCode: 402 },
      );
    }
    return { rateIn: chosen.rate_in, rateOut: chosen.rate_out, provider: chosen.provider_id };
  }

  /**
   * The catalog's numeric id for a model name. Public so a batch client can
   * name it; an order signs this id, never the name.
   */
  async modelIdFor(model: string): Promise<number> {
    for (const entry of await this.models.list()) {
      // Own properties only on a catalog row (`own.ts`): the id this resolves is
      // signed into the order.
      const record = entry as unknown as Record<string, unknown>;
      if (own(record, "id") !== model) continue;
      // `asBigInt`, not `Number`: `Number(null)` is `0`, and `0` is exactly the
      // value this refusal exists to prevent an order from being signed over.
      const catalogVorq = own(record, "vorq");
      const modelId = asBigInt(
        typeof catalogVorq === "object" && catalogVorq !== null
          ? own(catalogVorq as Record<string, unknown>, "model_id")
          : undefined,
      );
      if (modelId !== null) return Number(modelId);
      break;
    }
    throw new ValidationError(
      `the coordinator's catalog carries no numeric model_id for ${JSON.stringify(model)}, ` +
        "and an order signs the id rather than the name",
      { type: "invalid_request_error" },
    );
  }

  /**
   * When the order stops being postable, clamped to the chain's own ceiling.
   *
   * The payment authorization must outlive the work, so the SLA window plus
   * `SETTLEMENT_MARGIN_SECONDS` is the wanted value — but `JobRegistry` refuses
   * anything past `now + 86400` and the `24h` window already reaches it.
   * Clamping here is what keeps the ordinary long-window submission from being a
   * `400` at the door.
   */
  private expiresAt(window: string): bigint {
    const now = Math.floor(Date.now() / 1000);
    return BigInt(
      now + Math.min(slaSeconds(window) + SETTLEMENT_MARGIN_SECONDS, MAX_EXPIRY_SECONDS),
    );
  }

  /**
   * Read a `402`/`409` quote, refusing one that is not about this job.
   *
   * **This client signs what it derives; the quote supplies the amount and
   * nothing else.** The quoted `authorization` block is still read member for
   * member and has to agree: a node that describes a different authorization
   * than the one this client is about to sign is a node on another deployment,
   * and signing anyway would produce an unclaimable job rather than a refusal.
   *
   * `amount` is a USD string, parsed at the token's `decimals`; the block's
   * `value` is the atomic integer the signature covers, and the two must be the
   * same figure.
   */
  private quoteFrom(
    body: unknown,
    jobId: Hex,
    ctx: ChainContext,
    expiresAt: bigint,
  ): { amount: bigint } {
    // **Own properties only on every record below** (`own.ts`), and this is the
    // second place in the package where the rule guards a *signature*: `amount`
    // is what this client signs over, and every member of the block beside it
    // is what says the node means the same job, the same token and the same
    // window. Read bare, a quote that states none of them is answered by the
    // prototype and every comparison below agrees with a page rather than with
    // the coordinator.
    const quote =
      typeof body === "object" && body !== null
        ? own(body as Record<string, unknown>, "quote")
        : undefined;
    if (typeof quote !== "object" || quote === null) {
      throw new VorqError("the node answered a challenge with no quote to sign", {
        type: "api_error",
        statusCode: 402,
      });
    }
    const fields = quote as Record<string, unknown>;
    const quoted = own(fields, "amount");
    let amount: bigint | null = null;
    try {
      amount = parseUsd(quoted as string, ctx.decimals);
    } catch {
      // An amount that is not a USD string at the token's decimals is no amount.
    }
    const member = own(fields, "authorization");
    if (amount === null || typeof member !== "object" || member === null) {
      throw new VorqError("the node's quote names no amount and authorization this client can check", {
        type: "api_error",
        statusCode: 402,
      });
    }
    const auth = member as Record<string, unknown>;
    const domainMember = own(auth, "domain");
    const domain = (
      typeof domainMember === "object" && domainMember !== null ? domainMember : {}
    ) as Record<string, unknown>;
    const want = paymentDomain(ctx);
    const same = (a: unknown, b: string): boolean =>
      typeof a === "string" && a.toLowerCase() === b.toLowerCase();
    const agrees =
      Number(own(domain, "chainId")) === ctx.chainId &&
      same(own(domain, "verifyingContract"), ctx.usdc) &&
      own(domain, "name") === want.name &&
      own(domain, "version") === want.version &&
      same(own(auth, "to"), ctx.jobRegistry) &&
      same(own(auth, "nonce"), jobId) &&
      jsonInt(own(auth, "value")) === amount &&
      jsonInt(own(auth, "valid_after")) === 0n &&
      jsonInt(own(auth, "valid_before")) === expiresAt + 1n;
    if (!agrees) {
      throw new VorqError(
        "the quoted authorization is not the one this client derives for this job and deployment",
        { type: "api_error", statusCode: 402 },
      );
    }
    return { amount };
  }

  /**
   * A handle over a job row or a post's success body.
   *
   * The two shapes differ: `GET /v1/jobs/{id}` answers a row keyed `id`, while
   * `POST /v1/jobs` answers `{job_id, task_cid, tx_hash}`. Both name the job, and
   * only the row carries terms.
   *
   * **The id is the locally computed one rather than the one the answer echoes**
   * — a deliberate divergence from the authority, which reads `id or job_id` off
   * the body. This client chose the seed and built the container, so it knows
   * `keccak256(owner ‖ c)` before it sends; a handle that followed the answer
   * would follow a node that named somebody else's job, which is precisely the
   * attack `sendComplete` above spends a paragraph refusing. For an honest node
   * the two values are the same one.
   *
   * `task_cid` is the opposite case — the storage service names the content, and
   * the client can neither compute nor predict it — so the answer that minted it
   * is the only place it comes from. `null` on a row-shaped job that carries it
   * under `vorq`.
   */
  private handleFromJob(
    row: Record<string, unknown>,
    jobId: Hex,
    window: string,
  ): JobHandle {
    // Own properties only on the answer and on its `vorq` block (`own.ts`).
    const rowVorq = own(row, "vorq");
    const terms =
      typeof rowVorq === "object" && rowVorq !== null
        ? (rowVorq as Record<string, unknown>)
        : {};
    const named = (value: unknown): string | null =>
      typeof value === "string" && value !== "" ? value : null;
    return new JobHandle(this, jobId, {
      // `vorq.sla_secs` on a row; a post receipt carries no terms at all, so the
      // window this submission asked for stands in.
      sla: windowFromSeconds(own(terms, "sla_secs")) ?? window,
      job: row,
      cipher: this.cipher,
      taskCid: named(own(row, "task_cid")) ?? named(own(terms, "task_cid")),
    });
  }
}

/** A JSON integer as a `bigint`, or `null` for anything else (a digit string included). */
function jsonInt(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
}

/** One market candidate: who, the key to seal to, and its ask. */
interface MarketCandidate {
  provider_id: number;
  box_key: string;
  /** USD per 1M units of work. */
  rate_in: string;
  rate_out: string;
}

/**
 * The candidates a market probe names, in the node's order.
 *
 * Own properties only (`own.ts`): the ask is signed as this order's rates.
 * Entries that cannot be sealed to or bid — no positive integer
 * `provider_id`, no `box_key` string, a rate that is not a USD string — are
 * dropped. A `candidates` member that is not a list is a node this client does
 * not understand.
 */
function candidatesOf(body: unknown): MarketCandidate[] {
  const raw =
    typeof body === "object" && body !== null
      ? own(body as Record<string, unknown>, "candidates")
      : undefined;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new VorqError("the 402 challenge carried a `candidates` field that is not a list", {
      type: "api_error",
      statusCode: 402,
    });
  }
  const kept: MarketCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const pid = asBigInt(own(record, "provider_id"));
    const boxKey = own(record, "box_key");
    const rateIn = own(record, "rate_in");
    const rateOut = own(record, "rate_out");
    if (pid === null || pid <= 0n || typeof boxKey !== "string" || boxKey === "") continue;
    if (!isUsd(rateIn) || !isUsd(rateOut)) continue;
    kept.push({ provider_id: Number(pid), box_key: boxKey, rate_in: rateIn, rate_out: rateOut });
  }
  return kept;
}

/**
 * `GET /auth/nonce` → sign → `POST /auth/session`, on the raw fetch.
 *
 * Shared by `Client` and `mintSessionToken`, and deliberately outside the
 * transport: the handshake is what the transport's 401 path calls, so routing it
 * back through would recurse.
 */
async function handshake(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  signer: Signer,
): Promise<{ token: string; expiresAt: number | null }> {
  const raise = async (response: Response): Promise<never> => {
    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      /* the status is still the answer */
    }
    throw errorFromWire(response.status, body, {
      requestId: response.headers.get("x-request-id"),
    });
  };

  /**
   * A `200` is not yet an answer.
   *
   * An absent field would otherwise become `undefined` and travel: a session
   * with no `token` stores `undefined`, `reauthorize`'s `this.token !== null` is
   * *true* for it, and the transport retries with no `Authorization` header at
   * all — taking a second 401 and telling the caller their signature was
   * rejected, when what actually happened is that the coordinator returned a
   * malformed session. The condition is named where it occurs instead.
   */
  const required = (body: unknown, field: string, route: string, status: number): string => {
    // Own properties only (`own.ts`): a bare dynamic index would let a polluted
    // `Object.prototype.token` satisfy this check, so a malformed session
    // response would be accepted and its inherited value stored and sent as this
    // client's bearer token.
    const value = body === null || typeof body !== "object" ? undefined
      : own(body as Record<string, unknown>, field);
    if (typeof value !== "string" || value === "") {
      throw new VorqError(
        `${route} answered ${status} with no usable \`${field}\`: the handshake cannot ` +
          "continue against a malformed session response",
        { type: "invalid_response", statusCode: status },
      );
    }
    return value;
  };

  const nonceResponse = await fetchImpl(
    `${baseUrl}/auth/nonce?address=${encodeURIComponent(signer.address)}`,
    { method: "GET" },
  );
  if (!nonceResponse.ok) await raise(nonceResponse);
  const nonceBody: unknown = await nonceResponse.json().catch(() => null);
  const nonce = required(nonceBody, "nonce", "GET /auth/nonce", nonceResponse.status);
  // The chain the session domain is bound to: the node's, not a pin, because a
  // browser wallet only signs a domain on the chain it is switched to.
  const chainId =
    nonceBody !== null && typeof nonceBody === "object"
      ? own(nonceBody as Record<string, unknown>, "chain_id")
      : undefined;
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
    throw new VorqError(
      `GET /auth/nonce answered ${nonceResponse.status} with no usable \`chain_id\`: the ` +
        "session domain is bound to the deployment's chain and the handshake cannot continue without it",
      { type: "invalid_response", statusCode: nonceResponse.status },
    );
  }

  const sessionResponse = await fetchImpl(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: signer.address,
      nonce,
      signature: await signer.signNonce(nonce, chainId),
    }),
  });
  if (!sessionResponse.ok) await raise(sessionResponse);
  const payload = (await sessionResponse.json().catch(() => null)) as {
    expires_at?: number;
  } | null;
  const token = required(payload, "token", "POST /auth/session", sessionResponse.status);
  return {
    token,
    expiresAt:
      payload !== null && typeof own(payload as Record<string, unknown>, "expires_at") === "number"
        ? (own(payload as Record<string, unknown>, "expires_at") as number)
        : null,
  };
}

/**
 * Run the handshake once and return a `vorq_sess_…` token.
 *
 * The standalone helper for pointing another HTTP client at VORQ: mint a token
 * here and pass it as that client's API key.
 *
 * Deliberate divergence: Python builds a signer from `$VORQ_WALLET_KEY` when
 * none is passed; here the signer is explicit — construct
 * `new PrivateKeySigner()` for the environment path.
 */
export async function mintSessionToken(args: {
  signer: Signer;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  // Own properties only on the caller's args (`own.ts`): a polluted
  // `Object.prototype.fetch` here would carry the handshake — and the signature
  // it puts on the wire — for a caller who named no transport.
  // One guard for all three reads, so there is one thing to keep true — and so
  // no read can be masked by another test's own property.
  const stated = <K extends "signer" | "baseUrl" | "fetch">(key: K): unknown =>
    own(args as unknown as Record<string, unknown>, key);
  const fetchImpl =
    (stated("fetch") as typeof globalThis.fetch | undefined) ?? globalThis.fetch.bind(globalThis);
  const baseUrl = ((stated("baseUrl") as string | undefined) ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const { token } = await handshake(fetchImpl, baseUrl, stated("signer") as Signer);
  return token;
}
