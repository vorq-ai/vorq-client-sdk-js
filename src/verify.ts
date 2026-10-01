/**
 * Client-edge attestation verification for confidential submissions.
 *
 * Opt-in, and the flag decides: a client built with `verifier` uses it on
 * `submit({ confidential: true })` and on nothing else — model names carry no
 * confidentiality semantics. At provider-selection time the verifier checks the
 * provider's registry evidence against the on-chain measurement allowlist —
 * measurement active, report-data binding for THIS record, no debug flags, TCB
 * floor — and only then is the bid sealed to the record's key. There is no
 * verification middleman: the client reads chain state itself and dispatches on
 * the evidence type tag.
 *
 * Modes: `structural` (the default floor) runs every check except vendor-PKI
 * quote validation; `mock` additionally accepts mock-tagged evidence and mock
 * allowlist entries, and is dev only. Strict vendor-PKI validators register per
 * evidence type when real hardware lands; until then every non-mock tag is
 * unknown and refused — the verifier fails closed by construction.
 *
 * Every input here is untrusted: the record comes from a provider, the
 * allowlist from whatever chain infrastructure the client chose. Malformed
 * shapes refuse with `VerificationError` rather than crashing, and **a check
 * that cannot be evaluated counts as a failed check**.
 *
 * This module opens its own socket and imports nothing from `client.ts`. The
 * two endpoints it reads are public chain-state reads that take no session
 * token, so routing them through the client transport would buy session
 * minting it does not need at the price of an import cycle.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { monotonicNow, wallNow } from "./clock.js";
import { concat, fromHex, toHex } from "./crypto/bytes.js";
import { TransportError, VerificationError, errorFromWire } from "./errors.js";
import { own } from "./own.js";

/**
 * The provider daemon's mock tag, and the coordinator escrow's.
 *
 * They are **distinct on purpose** and each is accepted on exactly one path: a
 * verifier that took either for either would accept a provider's evidence as
 * proof about the coordinator's escrow key, which is a different trust domain
 * holding different keys. The union below is the set of tags this SDK will look
 * at at all, and it is still empty of every real vendor tag until a strict
 * validator for one lands.
 */
export const MOCK_PROVIDER_EVIDENCE_TYPE = "mock-cvm-v1";
export const MOCK_COORDINATOR_EVIDENCE_TYPE = "mock-coordinator-v1";
export const MOCK_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  MOCK_PROVIDER_EVIDENCE_TYPE,
  MOCK_COORDINATOR_EVIDENCE_TYPE,
]);

/**
 * A coordinator whose escrow key is **derived from its operator credential**
 * rather than minted inside a measured guest.
 *
 * Accepted in every mode, including the default `structural`, and deliberately
 * **not** a member of `MOCK_EVIDENCE_TYPES`. The mock tag is refused outside
 * mock mode because mock evidence is computable by anyone and a mock node hands
 * its whole key set to any caller; this tag makes a smaller and true claim —
 * the binding — and accepting it must not soften that guard.
 *
 * **Forward constraint.** This tag is the whole switch: nothing lets a client
 * say "I require measured escrow evidence" and refuse this one instead. That is
 * not a live regression today — every real vendor tag still raises, so nothing
 * can yet be downgraded to this one — but once a strict tier adds real
 * measured-evidence validators, an unconditional accept here would become a
 * silent downgrade path around it. It must be refused there.
 */
export const STATIC_COORDINATOR_EVIDENCE_TYPE = "static-coordinator-v1";

/**
 * The escrow's service id, **UTF-8 and unpadded**, stated as bytes at the one
 * place the digest is taken. A cross-language contract: a verifier that padded
 * it to 32 bytes, or encoded it UTF-16, would compute a different digest and
 * refuse every honest node.
 */
export const ESCROW_SERVICE_ID: Uint8Array = new TextEncoder().encode(
  "vorq-coordinator-escrow-v1",
);

/**
 * How far `GET /key`'s `issued_at` may be from this client's clock, either way,
 * in seconds. The same ±600 s bound the escrow applies to a release request's
 * own `issued_at` — one number for freshness across the protocol, rather than a
 * second one that could drift from it.
 */
export const KEY_FRESHNESS_S = 600;

/**
 * How long a fetched allowlist stays usable. Revocation is the control for a
 * compromised image, so a long-lived client must re-read chain state: an
 * unbounded cache would keep accepting a revoked measurement forever.
 */
export const DEFAULT_ALLOWLIST_TTL_S = 60;

const MODES = new Set(["structural", "mock"]);

// `^…$` without the `m` flag are JavaScript's `\A…\Z`: `$` matches only at end
// of input and NOT before a trailing newline. Python's `\Z` says the same
// thing, which is why these port character for character.
const BOX_KEY_RE = /^(?:0[xX])?[0-9a-fA-F]{64}$/; // 32-byte Curve25519 key
const ADDRESS_RE = /^(?:0[xX])?[0-9a-fA-F]{40}$/; // 20-byte payee address
const MEASUREMENT_RE = /^(?:0[xX])?[0-9a-fA-F]+$/; // hex digest, any width
const PROVIDER_ID_RE = /^[0-9]{1,20}$/;

/**
 * Drop a leading `0x` in **either** case.
 *
 * **Defensive, not load-bearing, and deliberately untested.** Every caller —
 * `hexKey` and `measurementOf` — lowercases its input before calling, so no
 * reachable input distinguishes this from a case-sensitive `=== "0x"`: the
 * uppercase `X` the regexes above accept is already gone by the time it arrives.
 * There is therefore no test pinning this line, because there is no test that
 * could fail if it were reverted.
 *
 * It is written case-insensitively anyway, to retire an unwritten invariant
 * ("every caller lowercases first") that currently holds only by construction.
 * A future caller that skips the lowercase would otherwise get `"0XABCD…"` back
 * with its prefix attached and drop an honest measurement on a comparison that
 * silently misses. Cheaper to be indifferent to case than to require every
 * future caller to remember.
 */
const stripPrefix = (value: string): string =>
  value.slice(0, 2).toLowerCase() === "0x" ? value.slice(2) : value;

/** A JSON object — and not an array, which `typeof` calls an object too. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A hostile value, rendered for a message, without letting it become one. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Parse a Curve25519 public key, refusing anything that is not 64 hex chars.
 *
 * The `0x` prefix is optional for the same reason it is on an address and on a
 * measurement: the node serves every `bytes` column prefixed, and a verifier
 * that refused that spelling would fail **closed** on records that are entirely
 * honest — dropping every candidate rather than raising, which is the silent
 * empty-result failure.
 */
function boxKeyBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !BOX_KEY_RE.test(value)) {
    throw new VerificationError("record box_key is not a 32-byte hex Curve25519 key");
  }
  return fromHex(value.toLowerCase());
}

/** One spelling of a hex key, for comparison. Case and `0x` are both noise. */
function hexKey(value: string): string {
  return stripPrefix(value.toLowerCase());
}

/** Parse a payee address, refusing anything that is not 40 hex chars. */
function addressBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new VerificationError("record operator is not a 20-byte hex account address");
  }
  return fromHex(value.toLowerCase());
}

/**
 * Normalize a measurement for comparison, or `null` if it cannot be one.
 *
 * Case and an optional `0x` prefix are both spellings of the same digest, so
 * normalize away both — on the evidence side and the allowlist side alike, or a
 * revocation written in one spelling would leave the other live.
 */
function measurementOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!MEASUREMENT_RE.test(value)) return null;
  return stripPrefix(value.toLowerCase()) || null;
}

function binding(boxKey: unknown, address: unknown): string {
  return toHex(sha256(concat(boxKeyBytes(boxKey), addressBytes(address))));
}

/**
 * Recompute the evidence binding `sha256(box_pub ‖ wallet)` from record fields.
 *
 * Raw bytes on both sides — the 32-byte key and the 20-byte address — so the
 * digest is byte-identical to the one the attesting daemon put in its quote.
 * Malformed inputs raise `VerificationError`, never a bare `Error`.
 */
export function reportData(boxKey: string, address: string): string {
  return binding(boxKey, address);
}

/**
 * The escrow binding: `sha256(escrow_pk32 ‖ utf8("vorq-coordinator-escrow-v1"))`.
 *
 * A **different** construction from `reportData`, and that is the point of it
 * having its own function. A provider record binds a key to a payee address;
 * the escrow announcement has no payee and no address field at all, so running
 * it through the record binding computes a digest over a missing field and
 * refuses every honest announcement. The service id is what stands in place of
 * the address: it says which flow this evidence is about, so evidence minted
 * for the key announcement cannot be presented as evidence about anything else.
 */
export function escrowReportData(escrowPublicKey: string): string {
  return toHex(sha256(concat(boxKeyBytes(escrowPublicKey), ESCROW_SERVICE_ID)));
}

/**
 * Extract a comparable TCB security-version number, or refuse.
 *
 * Refuses instead of raising on a non-object `tcb`, a missing `svn`, a
 * non-numeric `svn` and any non-finite number — an uncomparable TCB is a failed
 * TCB check. `Array.isArray` earns its line: `typeof [] === "object"`, so a JSON
 * array would otherwise pass for the object Python's `isinstance(tcb, dict)`
 * refuses.
 */
function tcbSvn(evidence: Record<string, unknown>): number {
  // `own`, never `evidence.tcb`: every record this module reads is untrusted,
  // so it is read own-properties only (see `own.ts`). A bare `.` walks the
  // prototype chain, and `Object.create(honestEvidence)` — an object with zero
  // own properties — would answer this check with a TCB it never stated.
  const tcb = own(evidence, "tcb");
  if (tcb === null || tcb === undefined) {
    throw new VerificationError("evidence carries no TCB version");
  }
  if (!isPlainObject(tcb)) {
    throw new VerificationError("evidence TCB block is not an object");
  }
  const svn = own(tcb, "svn");
  if (typeof svn !== "number") {
    throw new VerificationError("evidence TCB version is not a number");
  }
  if (!Number.isFinite(svn)) {
    throw new VerificationError("evidence TCB version is not a finite number");
  }
  return svn;
}

/**
 * What counts as an image entry.
 *
 * Two spellings, because the curation contract's entry blob says `cvm-image`
 * and the flat form this verifier has always read says `image`. They name the
 * same thing, and a verifier that knew only one of them would silently match
 * nothing at all.
 */
const IMAGE_KINDS: ReadonlySet<unknown> = new Set(["image", "cvm-image"]);

/**
 * The curation status vocabulary as the chain writes it — `setAllowlistEntry`
 * takes `{1 active, 2 revoked}`. Anything else normalizes to a status that is
 * neither, which is refused: a status this client cannot read is not a status
 * it may treat as active.
 */
const NUMERIC_STATUS = new Map<number, string>([
  [1, "active"],
  [2, "revoked"],
]);

interface NormalEntry {
  kind: unknown;
  measurement: unknown;
  status: unknown;
  mock: unknown;
}

/**
 * One allowlist entry in the shape the checks read, whichever shape it arrived in.
 *
 * Two shapes exist on the wire and both are real. The chain-projected one is
 * `{key, status: <int>, entry: {kind, measurement, …}}` — the row the node
 * serves, where `status` is the contract's integer and everything descriptive
 * is inside the opaque blob curation filed. The flat one carries the same
 * fields at the top level.
 *
 * Reading only the flat one is a silent failure: no exception, no diagnostic,
 * just an allowlist that matches nothing and a verifier that refuses every
 * honest provider. So the nested form is normalized rather than assumed away,
 * and an unreadable status becomes `"unknown"`, which is neither `active` nor
 * `revoked` and is therefore refused by the checks that follow.
 *
 * The descriptive fallback fires on key **absence**, never on an explicit
 * `null` — `??` would conflate the two and match an entry the authority
 * refuses (R7). `status` is the one field where the fallback *does* take a
 * null, matching Python's `entry.get("status")`, which cannot tell an absent
 * key from a null one: a null status is unreadable either way and normalizes
 * to something neither active nor revoked.
 */
function normalizeEntry(entry: Record<string, unknown>): NormalEntry {
  // Own-properties only on both levels, the package rule for an untrusted
  // record (see `own.ts`), and **load-bearing here** rather than defensive.
  //
  // An entry can only arrive through `readAllowlist`, which calls `JSON.parse`
  // on the response text itself — so a hostile `fetch` cannot duck-type a
  // prototype-bearing object in, and none of `entry`/`kind`/`measurement`/
  // `status`/`mock` is a name `Object.prototype` supplies **as shipped**. That
  // is not the end of the argument: `Object.prototype` is writable, and a
  // polluted realm supplies any name at all. Read with the bare forms, a chain
  // that serves `[{}]` — or `{}` — combined with `Object.prototype.kind =
  // "image"` and a polluted `measurement` yields an allowlist entry fabricated
  // entirely out of the prototype, and `verifyRecord` then accepts a
  // measurement that was never on any allowlist. Every one of these reads is
  // pinned by a test in `test/prototype-reads.test.ts`.
  const inner = own(entry, "entry");
  const blob = isPlainObject(inner) ? inner : {};
  const pick = (key: string): unknown =>
    Object.hasOwn(entry, key) ? entry[key] : own(blob, key);
  const status = own(entry, "status");
  let normalized: unknown;
  if (typeof status === "boolean") {
    normalized = "unknown";
  } else if (typeof status === "number" && Number.isInteger(status)) {
    normalized = NUMERIC_STATUS.get(status) ?? "unknown";
  } else {
    normalized = status ?? own(blob, "status");
  }
  return {
    kind: pick("kind"),
    measurement: pick("measurement"),
    status: normalized,
    mock: pick("mock"),
  };
}

/** Validate the allowlist envelope shape before anything trusts its contents. */
function parseAllowlist(body: unknown): Record<string, unknown>[] {
  if (!isPlainObject(body)) {
    throw new VerificationError("malformed allowlist response: expected an object");
  }
  // Own-properties only, on the same footing as `normalizeEntry` above: the
  // rule, applied even where the envelope can only have come from `JSON.parse`.
  const entries = own(body, "entries");
  if (entries === null || entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new VerificationError("malformed allowlist: entries is not a list");
  }
  for (const entry of entries) {
    // A bare string would turn membership tests into substring tests, and a
    // non-mapping entry has no fields to check at all.
    if (!isPlainObject(entry)) {
      throw new VerificationError("malformed allowlist: entry is not an object");
    }
  }
  return entries as Record<string, unknown>[];
}

/**
 * Return a URL-safe provider id, or `null` if it cannot be one.
 *
 * Interpolating an untrusted value into the request path would let a hostile
 * challenge point the record fetch at another endpoint or host.
 */
function providerPathId(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    // **Safe** integers, not merely integral ones. `Number.isInteger(1e21)`
    // holds and `String(1e21)` is `"1e+21"`, and every whole number past 2^53
    // stands for a range of ids rather than one — `9007199254741001` reads back
    // as `…000`. Both would put a path on the wire naming an id the caller did
    // not ask for. Below 2^53 `String` is always plain digits, at most 16 of
    // them, so no exponent and no separator can reach the path from here.
    //
    // Python's int branch takes an id of any width, so an id past 2^53 is
    // reachable there and not here. A `number` in JavaScript cannot carry one
    // faithfully at all, and the string branch — capped identically in both
    // SDKs — is how such an id is passed in either language.
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === "string" && PROVIDER_ID_RE.test(value)) return value;
  return null;
}

export interface VerifierOptions {
  /** `structural` is the default floor; `mock` is dev only. */
  mode?: "structural" | "mock";
  minTcbSvn?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  allowlistTtlS?: number;
  /** Elapsed-time source for the cache TTL. Monotonic, in seconds. */
  clock?: () => number;
  /** Wall-clock source for the `issued_at` freshness bound. Unix seconds. */
  wallClock?: () => number;
}

/**
 * Client-edge attestation verifier over the public chain-state endpoints.
 *
 * The allowlist signature is deliberately not a dependency: the client reads
 * chain state through infrastructure it chose, so the read itself is the root
 * of trust and re-checking a curation signature buys nothing here.
 */
export class Verifier {
  readonly baseUrl: string;

  private readonly mode: "structural" | "mock";
  private readonly minTcbSvn: number;
  private readonly ttl: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  /**
   * Two clocks, because they answer two different questions. The cache TTL is
   * an elapsed-time question and must not move when the system clock is
   * stepped, so it is monotonic. `issued_at` is a wall-clock instant the node
   * stamped, so comparing it needs a wall clock — a monotonic reading is a
   * number of seconds since an arbitrary origin and would refuse every
   * announcement ever made.
   */
  private readonly clock: () => number;
  private readonly wallClock: () => number;

  private entries: Record<string, unknown>[] | null = null;
  private fetchedAt = 0;
  /**
   * Bumped by `invalidate()`; a read that started before the bump must not
   * write its answer back as the new cache.
   */
  private generation = 0;
  /**
   * The in-flight read, not its value: two callers arriving before it resolves
   * share one chain read rather than opening two sockets for one answer (R3).
   *
   * **It is not a lock, and the difference is the whole reason `invalidate()`
   * clears this field too.** Python holds an `asyncio.Lock` and re-evaluates
   * `self._entries is None` on the far side of it, so a caller that queued
   * behind a read observes whatever `invalidate()` did while it waited. A
   * joined promise re-evaluates nothing — it can only replay the answer it was
   * created with. Leaving it set across an invalidation therefore hands a
   * caller arriving inside the window the **pre-revocation** allowlist, and
   * makes `refresh()` — the API for exactly that event — perform no read at
   * all. That is a fail-open on the one property this module exists to enforce.
   *
   * What is deliberately **not** reproduced is the serialization: after an
   * `invalidate()` the superseded read and its replacement may be on the wire
   * at once, where Python would run them one after the other. That costs one
   * request and changes no answer.
   */
  private inflight: Promise<Record<string, unknown>[]> | null = null;

  constructor(baseUrl: string, options: VerifierOptions = {}) {
    // Every validated option defaults on `undefined` **only**, never with `??`.
    // Python's keyword defaults apply to an omitted argument and an explicit
    // `None` still reaches the validator; `??` would swallow a `null` here and
    // silently substitute the default for a value the caller stated wrongly —
    // a config bug that then goes unreported until something downstream is odd.
    //
    // **Own properties only on that record** (`own.ts`), and this is the
    // sharpest options guard in the package: `Verifier` is on the barrel,
    // `options` defaults to `{}`, and `new Verifier(baseUrl)` therefore reads
    // whatever `Object.prototype` holds. `mode` is the one that matters —
    // `"mock"` disables three separate `VerificationError`s below (mock
    // provider evidence, mock escrow evidence, a mock allowlist entry), so a
    // prototype-supplied `mode` turns this whole module off for a caller who
    // asked for the default floor. `minTcbSvn` is the firmware floor, `fetch`
    // is the transport **every piece of attestation evidence is read
    // through**, `wallClock` is the reference the `issued_at` freshness bound
    // is measured against, and `allowlistTtlS` is how long a revoked
    // measurement keeps being served out of cache. Every one of them decides
    // whether a refusal fires.
    //
    // `=== undefined` is kept over `??` for the reason the paragraph above
    // gives; `own` is what makes that test read the caller's record rather
    // than the prototype's.
    const stated = <K extends keyof VerifierOptions>(key: K): VerifierOptions[K] =>
      own(options as Record<string, unknown>, key) as VerifierOptions[K];
    const statedMode = stated("mode");
    const mode = statedMode === undefined ? "structural" : statedMode;
    if (!MODES.has(mode)) {
      throw new Error(`unknown verifier mode: ${describe(mode)} (use 'structural' or 'mock')`);
    }
    const statedTcb = stated("minTcbSvn");
    const minTcbSvn = statedTcb === undefined ? 1 : statedTcb;
    if (typeof minTcbSvn !== "number" || !Number.isInteger(minTcbSvn) || minTcbSvn < 0) {
      throw new Error(`minTcbSvn must be a non-negative integer, got ${describe(minTcbSvn)}`);
    }
    const statedTtl = stated("allowlistTtlS");
    const ttl = statedTtl === undefined ? DEFAULT_ALLOWLIST_TTL_S : statedTtl;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) {
      throw new Error(`allowlistTtlS must be a finite non-negative number, got ${describe(ttl)}`);
    }
    const statedClock = stated("clock");
    const clock = statedClock === undefined ? monotonicNow : statedClock;
    const statedWallClock = stated("wallClock");
    const wallClock = statedWallClock === undefined ? wallNow : statedWallClock;
    if (typeof clock !== "function") {
      throw new Error(`clock must be a function, got ${describe(clock)}`);
    }
    if (typeof wallClock !== "function") {
      throw new Error(`wallClock must be a function, got ${describe(wallClock)}`);
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.mode = mode;
    this.minTcbSvn = minTcbSvn;
    this.ttl = ttl;
    // `timeoutMs` and `fetch` default with `??` on purpose: neither is
    // validated, so a `null` there must land on the safe fallback rather than
    // on `AbortSignal.timeout(null)` or a missing transport.
    this.timeoutMs = stated("timeoutMs") ?? 30_000;
    this.fetchImpl = stated("fetch") ?? globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.wallClock = wallClock;
  }

  /**
   * The measurement allowlist, re-reading chain state once the TTL lapses.
   *
   * A transport or HTTP failure propagates loudly — nothing was verified. A
   * malformed envelope is a verification failure: chain state we cannot read is
   * chain state we do not trust. The caller gets a **deep** copy, so nothing it
   * does to the result — including mutating an entry in place — can rewrite
   * what later checks compare against.
   */
  async allowlist(): Promise<Record<string, unknown>[]> {
    return structuredClone(await this.cachedEntries());
  }

  /**
   * Drop the cached allowlist and re-read it now, e.g. on a revocation notice.
   *
   * "Now" includes the case where a read is already in flight. That read was
   * composed before the notice arrived, so this does not join it — it starts
   * its own.
   */
  async refresh(): Promise<Record<string, unknown>[]> {
    this.invalidate();
    return this.allowlist();
  }

  /**
   * Forget the cached allowlist; the next check re-reads chain state.
   *
   * Three pieces of state, and the third is not optional. Clearing `entries`
   * alone leaves a caller that arrives while a read is in flight joining that
   * read and receiving the answer this invalidation was meant to discard.
   * Dropping `inflight` costs the running read nothing — it holds its own
   * promise in a local through `await read`, and its `finally` re-checks
   * identity before clearing, so it can neither be cancelled by this nor
   * clobber the read that replaces it.
   */
  invalidate(): void {
    this.entries = null;
    this.fetchedAt = 0;
    this.generation += 1;
    this.inflight = null;
  }

  /** Verify one provider registry record. Rejects with `VerificationError`. */
  async verifyRecord(record: unknown): Promise<void> {
    if (!isPlainObject(record)) {
      throw new VerificationError("provider record is not an object");
    }

    // **Every field below is read with `own`, never with `.`** — the package
    // rule for a record that came off the network or from a caller (see
    // `own.ts`). This method is public surface taking an arbitrary object, so
    // the shape is reachable, not theoretical: `Object.create(honestRecord)`
    // has zero own properties, states nothing at all, and would satisfy every
    // check on this path if a single one of them read through the prototype. An
    // inherited property must not be able to satisfy a check here.
    const ev = own(record, "evidence");
    if (!isPlainObject(ev)) {
      throw new VerificationError("provider record carries no attestation evidence");
    }

    const evType = own(ev, "type");
    if (evType === MOCK_PROVIDER_EVIDENCE_TYPE) {
      if (this.mode !== "mock") {
        throw new VerificationError("mock evidence is refused outside mock mode");
      }
    } else {
      // No validator is registered for this tag — including every real vendor
      // tag, until the strict tier lands, and including the two coordinator
      // tags this module also declares, which are evidence about a different
      // trust domain holding different keys. Fail closed.
      throw new VerificationError(
        `unrecognized evidence type ${describe(evType)}: no validator for it`,
      );
    }

    await this.matchImageEntry(own(ev, "measurement"));

    // `operator`, which is what the record actually carries. The registry's
    // payee is `operatorOf(id)` on chain and `operator` on
    // `GET /evm/providers/:id`; there is no `address` key on that wire, and a
    // verifier that read one computed the binding over `undefined` and refused
    // every honest record — so no confidential designated submission could
    // succeed at all.
    const expected = binding(own(record, "box_key"), own(record, "operator"));
    const got = own(ev, "report_data");
    if (typeof got !== "string" || got.toLowerCase() !== expected) {
      throw new VerificationError("evidence does not bind this record's box key and payee");
    }
    // A check that cannot be evaluated is a failed check: evidence that never
    // states its debug status has not shown the payload is production-locked,
    // exactly as a missing TCB block below is not a passing TCB.
    const debug = own(ev, "debug");
    if (typeof debug !== "boolean") {
      throw new VerificationError("evidence does not state a boolean debug flag");
    }
    if (debug) {
      throw new VerificationError("evidence carries a debug flag");
    }
    if (tcbSvn(ev) < this.minTcbSvn) {
      throw new VerificationError("TCB is below the required floor");
    }
  }

  /**
   * Verify `GET /key` and return the escrow public key it announces.
   *
   * **Its own path, with its own binding.** Routing this through `verifyRecord`
   * would compute `sha256(box_key ‖ operator)` over an operator address the
   * announcement does not carry — and never will, because the escrow has no
   * payee — so it would raise on every honest node while looking like a
   * verification failure. What the two paths do share is shared: `debug` on
   * every tag, and the allowlist and the TCB floor on measured evidence only —
   * the static tag claims no image and no platform, so neither question has an
   * answer to check there.
   *
   * Rejects with `VerificationError`. **Its caller is `Client`'s open-order
   * path**, which hands it the raw `GET /key` body and turns that rejection
   * into the fail-closed `EscrowKeyUnverified` — the same class that path
   * raises when there is no verifier at all — because "this key did not verify"
   * and "so nothing was posted" are two different statements and the second is
   * the one that matters to somebody holding a wallet.
   *
   * The **raw** body, and that is a contract rather than a convenience: this
   * method reads `escrow_public_key` and `issued_at`, which are the names the
   * node sends. `Client.escrowKey()` renames both, so an announcement routed
   * through it would be refused here on every honest node.
   */
  async verifyEscrowKey(announcement: unknown): Promise<string> {
    if (!isPlainObject(announcement)) {
      throw new VerificationError("GET /key did not answer an object");
    }

    // Own-properties only, for the reason `verifyRecord` states above: this is
    // public surface over an arbitrary object, and an `Object.create(honest)`
    // announcement — zero own properties, stating nothing — must fail every
    // check below rather than inherit its way past them.
    const key = own(announcement, "escrow_public_key");
    if (typeof key !== "string" || !BOX_KEY_RE.test(key)) {
      throw new VerificationError(
        "GET /key announced no 32-byte hex escrow_public_key, so an open order has " +
          "nobody to seal its payload to",
      );
    }

    const ev = own(announcement, "evidence");
    if (!isPlainObject(ev)) {
      throw new VerificationError("GET /key carries no attestation evidence");
    }

    const evType = own(ev, "type");
    let measured: boolean;
    if (evType === STATIC_COORDINATOR_EVIDENCE_TYPE) {
      // An operator-keyed escrow. There is no measured image, so there is no
      // allowlist entry to resolve and no TCB level to floor: both are
      // questions about hardware this node does not claim to have, and a
      // verifier that asked them of evidence that never answered them would
      // refuse every honest static node. What is left — the binding, the
      // freshness bound and `debug` — is checked below exactly as it is for
      // every other tag.
      measured = false;
    } else if (evType === MOCK_COORDINATOR_EVIDENCE_TYPE) {
      if (this.mode !== "mock") {
        throw new VerificationError("mock evidence is refused outside mock mode");
      }
      measured = true;
    } else {
      // Every real vendor tag included, until the strict tier lands — and the
      // provider mock, which is evidence about a different trust domain and
      // must not be accepted here.
      throw new VerificationError(
        `unrecognized escrow evidence type ${describe(evType)}: no validator for it`,
      );
    }

    // A key announcement is a claim about *now*. Checked before the allowlist
    // read so a replayed announcement costs no chain traffic.
    //
    // One guard fewer than Python, which must reject `bool` explicitly because
    // `isinstance(True, int)` holds there. `typeof true` is `"boolean"`, so a
    // boolean lands on this refusal already.
    const issuedAt = own(announcement, "issued_at");
    if (typeof issuedAt !== "number") {
      throw new VerificationError("GET /key states no numeric issued_at");
    }
    if (!Number.isFinite(issuedAt)) {
      throw new VerificationError("GET /key states a non-finite issued_at");
    }
    const skew = issuedAt - this.wallClock();
    if (Math.abs(skew) > KEY_FRESHNESS_S) {
      throw new VerificationError(
        `GET /key issued_at is ${skew > 0 ? "+" : ""}${skew.toFixed(0)}s from this clock, ` +
          `outside the ±${KEY_FRESHNESS_S}s freshness bound: this announcement is a replay, ` +
          "or one of the two clocks is wrong",
      );
    }

    if (measured) {
      await this.matchImageEntry(own(ev, "measurement"));
    }

    const expected = escrowReportData(key);
    const got = own(ev, "report_data");
    if (typeof got !== "string" || got.toLowerCase() !== expected) {
      throw new VerificationError("GET /key evidence does not bind the escrow key it announces");
    }
    const debug = own(ev, "debug");
    if (typeof debug !== "boolean") {
      throw new VerificationError("escrow evidence does not state a boolean debug flag");
    }
    if (debug) {
      throw new VerificationError("escrow evidence carries a debug flag");
    }
    if (measured && tcbSvn(ev) < this.minTcbSvn) {
      throw new VerificationError("escrow TCB is below the required floor");
    }
    return key;
  }

  /**
   * Filter challenge candidates to those whose record verifies **and** whose
   * challenge box key IS the verified record key — the seal target is pinned.
   *
   * `submit` runs it on the market probe's candidates for a confidential order.
   * The pin below is the reason it exists: a candidate that verifies while
   * offering a *different* key to seal to is the substitution the whole module
   * is built to refuse.
   */
  async verifyCandidates(candidates: unknown[]): Promise<Record<string, unknown>[]> {
    // The list itself is untrusted. It arrives in a `402` challenge body, so
    // `verifyCandidates(challenge.candidates)` is the intended call and the
    // `unknown[]` annotation guards nothing at all at runtime: a node answering
    // `"candidates": null` would otherwise escape as a raw `TypeError`, against
    // this module's rule that a malformed shape refuses rather than crashes.
    //
    // It **refuses** rather than answering `[]`, and that is the same rule the
    // rest of this method is built on: an empty result must mean "every
    // candidate was read and refused", never "the input could not be read".
    // Python answers `[]` for `None` as a side effect of `if not candidates`
    // and still raises a bare `TypeError` on a non-iterable, so there is no
    // considered contract there to port — only a truthiness test whose purpose
    // is the empty-list short circuit on the line below.
    if (!Array.isArray(candidates)) {
      throw new VerificationError(
        `candidates is not a list of challenge entries: got ${describe(candidates)}. A challenge ` +
          "this client cannot read is not a challenge with no candidates",
      );
    }
    if (candidates.length === 0) return [];
    // Resolve chain state up front: an unreadable allowlist must surface, not
    // masquerade as "every provider failed verification".
    await this.cachedEntries();

    const kept: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      if (!isPlainObject(candidate)) continue;
      // Own-properties only, here and on the fetched record below (see
      // `own.ts`). The candidate list arrives in a `402` body and the record
      // over a socket; a field either of them merely inherits is a field it did
      // not state, and neither the path id nor the seal-target pin may be
      // satisfied by one.
      // `provider_id` is what the node sends; `provider` is the older spelling.
      const pid = providerPathId(own(candidate, "provider_id") ?? own(candidate, "provider"));
      if (pid === null) continue;
      const response = await this.get(`/evm/providers/${pid}`);
      if (response.status === 404) {
        // No such record: this candidate has nothing to attest, but the read
        // itself worked — the other candidates still stand.
        response.body?.cancel().catch(() => {});
        continue;
      }
      if (response.status !== 200) {
        // Chain state we cannot read is chain state we do not trust — and an
        // unreadable record must never masquerade as "this provider failed
        // verification", which would silently narrow the field (or empty it)
        // on an auth or infrastructure fault.
        response.body?.cancel().catch(() => {});
        throw new VerificationError(
          `provider record for ${pid} is unreadable (HTTP ${response.status}): chain state ` +
            "could not be read",
        );
      }
      let rec: unknown;
      try {
        rec = await response.json();
      } catch {
        continue;
      }
      if (!isPlainObject(rec)) continue;
      // Transport sanity: a record that answers for a different provider id
      // means the read was misrouted. Confidentiality does not rest on this
      // (the box-key pin below does), but a lying reader should not be used.
      const echoed = own(rec, "provider");
      if (echoed !== null && echoed !== undefined && providerPathId(echoed) !== pid) continue;
      try {
        await this.verifyRecord(rec);
      } catch (error) {
        // Only that class, exactly as Python's `except VerificationError`. A
        // `TransportError` from a dead socket mid-loop is not a provider that
        // failed verification and must propagate.
        if (error instanceof VerificationError) continue;
        throw error;
      }
      const challengeKey = own(candidate, "box_key");
      // **`recordKey` is masked by `verifyRecord` above**, which reads
      // `box_key` with `own` itself and raises when the binding does not check
      // out — so a prototype-supplied key never reaches here as things stand.
      // Nothing enforces that ordering: move this comparison above the
      // `verifyRecord` call, or relax that check, and a bare read here would
      // let an inherited key satisfy the pin. `challengeKey` is not masked —
      // the challenge list is verified by nothing but the two lines below.
      const recordKey = own(rec, "box_key");
      if (typeof challengeKey !== "string" || !BOX_KEY_RE.test(challengeKey)) continue;
      // Two spellings of one key, compared after normalizing both — never as
      // strings. A prefixed record against a bare challenge is the same key.
      if (typeof recordKey !== "string" || hexKey(challengeKey) !== hexKey(recordKey)) continue;
      kept.push(candidate);
    }
    return kept;
  }

  /**
   * Whether the cached allowlist has aged out at `now`.
   *
   * Negative elapsed time counts as expired: a clock that steps backwards would
   * otherwise make `now - fetchedAt` shrink forever and pin a stale — possibly
   * revoked — allowlist for good.
   */
  private isExpired(now: number): boolean {
    const elapsed = now - this.fetchedAt;
    return elapsed < 0 || elapsed >= this.ttl;
  }

  private async cachedEntries(): Promise<Record<string, unknown>[]> {
    if (this.inflight !== null) return this.inflight;
    const now = this.clock();
    if (this.entries !== null && !this.isExpired(now)) return this.entries;
    const generation = this.generation;
    const read = this.readAllowlist().then((entries) => {
      // Only a well-formed answer replaces the cache; a failed re-read rejects
      // rather than silently extending the stale window. And if `invalidate()`
      // landed while this read was in flight, the answer predates the
      // revocation that prompted it: it serves this caller but is not cached,
      // so the next check reads chain state again.
      if (generation === this.generation) {
        this.entries = entries;
        this.fetchedAt = now;
      }
      return entries;
    });
    this.inflight = read;
    try {
      return await read;
    } finally {
      if (this.inflight === read) this.inflight = null;
    }
  }

  private async readAllowlist(): Promise<Record<string, unknown>[]> {
    const response = await this.get("/evm/allowlist");
    const text = await response.text();
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // a gateway's HTML degrades to `HTTP <status>`
      }
      throw errorFromWire(response.status, body, {
        requestId: response.headers.get("x-request-id"),
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VerificationError("allowlist response is not JSON");
    }
    return parseAllowlist(body);
  }

  /** One chain-state GET. A dead socket is a `TransportError`, never a `VerificationError`. */
  private async get(path: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new TransportError(`GET ${path} never became a response`, { cause });
    }
  }

  /**
   * Resolve an evidence measurement to its allowlist image entry.
   *
   * Every matching entry must clear the check, not just the first one: a list
   * that re-lists a revoked measurement as active must not resurrect it, and a
   * mock entry must not be shadowed by a non-mock duplicate.
   */
  private async matchImageEntry(measurement: unknown): Promise<NormalEntry> {
    const wanted = measurementOf(measurement);
    if (wanted === null) {
      throw new VerificationError("evidence carries no usable measurement");
    }
    const matches = (await this.cachedEntries())
      .map(normalizeEntry)
      .filter((n) => IMAGE_KINDS.has(n.kind) && measurementOf(n.measurement) === wanted);
    if (matches.length === 0) {
      throw new VerificationError("measurement is not on the allowlist");
    }
    if (matches.some((e) => e.status === "revoked")) {
      throw new VerificationError("measurement is revoked");
    }
    if (matches.some((e) => e.status !== "active")) {
      throw new VerificationError("measurement is not active on the allowlist");
    }
    if (matches.some((e) => Boolean(e.mock)) && this.mode !== "mock") {
      throw new VerificationError("mock allowlist entry is refused outside mock mode");
    }
    return matches[0]!;
  }
}
