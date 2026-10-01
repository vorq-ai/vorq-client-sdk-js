/**
 * The attestation fixtures and the scripted node the verify suites share.
 *
 * The measurements are digests of a label rather than round numbers so a
 * measurement can never accidentally equal a report-data digest, a box key or
 * a zero fill — every one of those coincidences would make a comparison pass
 * for the wrong reason.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromHex, toHex } from "../../src/crypto/bytes.js";

/** `sha256("vorq-mock-cvm-image-v1")`, matching the Python suite exactly. */
export const MEASUREMENT = "3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d";
/** `sha256("vorq-mock-coordinator-image-v1")`. */
export const ESCROW_MEASUREMENT =
  "11ed7897eb27a6c940cf571f40a0c6d7203b3e05dfe448462042a62e2472cb89";

export const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const BOX = "ab".repeat(32);
export const OTHER_WALLET = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
export const OTHER_BOX = "cd".repeat(32);
export const ESCROW_BOX = "1f".repeat(32);

/**
 * The wall-clock instant every escrow fixture is stamped at. A fixed number,
 * injected, so a freshness test asserts the bound rather than the machine.
 */
export const NOW = 1_790_000_000;

/**
 * The two bindings, recomputed **from their definitions** rather than imported
 * from `src/verify.ts`.
 *
 * This is the difference between a fixture and a tautology. A fixture built by
 * calling `reportData` agrees with `reportData` however wrong `reportData` is:
 * swap the two operands, drop the address, hash the hex text instead of the
 * bytes, and every test still passes. Built here from `sha256(key ‖ payee)`
 * spelled out, the fixture disagrees the moment the implementation does.
 */
export const bindingOf = (boxKey: string, address: string): string =>
  toHex(sha256(concat(fromHex(boxKey), fromHex(address))));

export const escrowBindingOf = (key: string): string =>
  toHex(sha256(concat(fromHex(key), new TextEncoder().encode("vorq-coordinator-escrow-v1"))));

export interface EvidenceOverrides {
  measurement?: unknown;
  reportData?: unknown;
  debug?: unknown;
  svn?: unknown;
  type?: unknown;
}

/** A provider's evidence block, valid unless an override says otherwise. */
export function evidence(over: EvidenceOverrides = {}): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    type: "type" in over ? over.type : "mock-cvm-v1",
    measurement: "measurement" in over ? over.measurement : MEASUREMENT,
    report_data: "reportData" in over ? over.reportData : bindingOf(BOX, WALLET),
    debug: "debug" in over ? over.debug : false,
    tcb: { svn: "svn" in over ? over.svn : 1 },
    quote: "b3BhcXVl",
  };
  return ev;
}

/** A provider registry record in the shape `GET /evm/providers/:id` serves. */
export function record(ev: unknown = evidence(), provider = 7): Record<string, unknown> {
  return { provider, operator: WALLET, box_key: BOX, evidence: ev };
}

/**
 * A record that verifies fully **on its own**, for a different (key, payee)
 * pair. Only the seal-target pin can drop this one — its evidence binds its
 * own key and payee, so every other check passes.
 */
export function otherRecord(provider = 2): Record<string, unknown> {
  return {
    provider,
    operator: OTHER_WALLET,
    box_key: OTHER_BOX,
    evidence: { ...evidence(), report_data: bindingOf(OTHER_BOX, OTHER_WALLET) },
  };
}

export const ACTIVE: Record<string, unknown>[] = [
  { kind: "image", measurement: MEASUREMENT, release: "mock-dev", status: "active", mock: true },
];

export const ESCROW_ACTIVE: Record<string, unknown>[] = [
  { kind: "image", measurement: ESCROW_MEASUREMENT, status: "active", mock: true },
];

export interface AnnouncementOverrides extends EvidenceOverrides {
  key?: string;
  issuedAt?: unknown;
  /** Replaces the whole body after it is built, for shapes with keys removed. */
  patch?: (body: Record<string, unknown>) => void;
}

/** A `GET /key` announcement carrying measured (mock-coordinator) evidence. */
export function announcement(over: AnnouncementOverrides = {}): Record<string, unknown> {
  const key = over.key ?? ESCROW_BOX;
  const body: Record<string, unknown> = {
    escrow_public_key: key,
    issued_at: "issuedAt" in over ? over.issuedAt : NOW,
    evidence: {
      type: "type" in over ? over.type : "mock-coordinator-v1",
      measurement: "measurement" in over ? over.measurement : ESCROW_MEASUREMENT,
      report_data: "reportData" in over ? over.reportData : escrowBindingOf(key),
      debug: "debug" in over ? over.debug : false,
      tcb: { svn: "svn" in over ? over.svn : 1 },
      release: 1,
      quote: "bW9jaw==",
    },
  };
  over.patch?.(body);
  return body;
}

/**
 * An announcement from a coordinator whose escrow key is derived from its
 * operator credential. No measurement, and no `tcb` — there is no measured
 * image to floor.
 */
export function staticAnnouncement(over: AnnouncementOverrides = {}): Record<string, unknown> {
  const key = over.key ?? ESCROW_BOX;
  const body: Record<string, unknown> = {
    escrow_public_key: key,
    issued_at: "issuedAt" in over ? over.issuedAt : NOW,
    evidence: {
      type: "type" in over ? over.type : "static-coordinator-v1",
      report_data: "reportData" in over ? over.reportData : escrowBindingOf(key),
      debug: "debug" in over ? over.debug : false,
      release: 1,
    },
  };
  over.patch?.(body);
  return body;
}

export interface ScriptedNode {
  /** Pass to `new Verifier(url, { fetch })`. */
  fetch: typeof globalThis.fetch;
  /** Every path requested, in order. */
  calls: string[];
  /** Requests to `/evm/allowlist` only — the number the cache tests count. */
  allowlistReads: number;
}

export interface ScriptOptions {
  /** Mutable: a test reassigns it to model a chain-state change. */
  entries?: () => unknown;
  /** Answered instead of the entries body, for envelope tests. */
  allowlistBody?: () => unknown;
  /** HTTP status for `/evm/allowlist`. Default 200. */
  allowlistStatus?: () => number;
  /** Raw text for `/evm/allowlist`, taking precedence over the JSON bodies. */
  allowlistText?: () => string;
  /** Provider records by id, for `verifyCandidates`. */
  records?: Record<number, unknown>;
  /** Status for a provider read that has a record. Default 200. */
  recordStatus?: () => number;
  /** Called before `/evm/allowlist` answers; `await` it to suspend a read. */
  beforeAllowlist?: (n: number) => Promise<void> | void;
}

/**
 * A `fetch` that answers the two chain-state endpoints and records every path.
 *
 * Every body-producing option is a **thunk**, not a value, so a test can change
 * what the chain says between two reads. A fixture captured by value cannot
 * model a revocation, and a cache test written against one passes with the
 * cache removed.
 *
 * The response is composed **before** `beforeAllowlist` suspends the read, and
 * that ordering is load-bearing: a response carries the chain state as of the
 * moment the node answered it, so a test that revokes an image while a read is
 * parked is modelling a notice that arrives *after* this answer was composed.
 * Composing it after the gate would instead hand the parked read a future it
 * could not have seen, and the mid-read-invalidate test would be asserting the
 * opposite of what it says.
 */
export function scriptedNode(options: ScriptOptions = {}): ScriptedNode {
  const node: ScriptedNode = { fetch: null as never, calls: [], allowlistReads: 0 };
  node.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    node.calls.push(url.pathname);
    if (url.pathname === "/evm/allowlist") {
      node.allowlistReads += 1;
      const status = options.allowlistStatus?.() ?? 200;
      const text = options.allowlistText === undefined ? null : options.allowlistText();
      const body = options.allowlistBody?.() ?? { entries: options.entries?.() ?? [] };
      await options.beforeAllowlist?.(node.allowlistReads);
      if (text !== null) {
        return new Response(text, { status, headers: { "content-type": "application/json" } });
      }
      return Response.json(body, { status });
    }
    const provider = /^\/evm\/providers\/(.+)$/.exec(url.pathname);
    if (provider !== null) {
      const found = (options.records ?? {})[Number(provider[1])];
      if (found === undefined) return Response.json({}, { status: 404 });
      return Response.json(found as object, { status: options.recordStatus?.() ?? 200 });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return node;
}

/** A `fetch` that fails the test if it is called at all. */
export function refusingFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    throw new Error(`this path must make no request, got ${String(input)}`);
  }) as unknown as typeof globalThis.fetch;
}
