import { describe, expect, it, vi } from "vitest";
import { VerificationError, VorqError } from "../src/errors.js";
import { Verifier } from "../src/verify.js";
import { ACTIVE, BOX, MEASUREMENT, WALLET, evidence, scriptedNode } from "./helpers/verify-harness.js";

const REVOKED = [{ ...ACTIVE[0], status: "revoked" }];

/** A verifier over a hand-cranked clock and mutable chain state. */
function ttlVerifier(state: { entries: unknown[] }, ttl = 60) {
  const now = { t: 1000 };
  const node = scriptedNode({ entries: () => state.entries });
  const verifier = new Verifier("http://node", {
    mode: "mock",
    allowlistTtlS: ttl,
    clock: () => now.t,
    fetch: node.fetch,
  });
  return { verifier, now, node };
}

describe("construction", () => {
  it("refuses an unknown mode with a plain Error (R6)", () => {
    // Argument validation of a caller-supplied scalar is a plain Error in this
    // package, mirroring Python's bare ValueError. A VorqError here would be
    // swallowed by a caller's `catch (e) { if (e instanceof VorqError) }`,
    // which is written for wire conditions and not for its own config bug.
    expect(() => new Verifier("http://node", { mode: "strict" as never })).toThrow(/mode/);
    try {
      new Verifier("http://node", { mode: "strict" as never });
      expect.unreachable("construction must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(VorqError);
    }
  });

  it("accepts both modes", () => {
    expect(() => new Verifier("http://node", { mode: "structural" })).not.toThrow();
    expect(() => new Verifier("http://node", { mode: "mock" })).not.toThrow();
    expect(() => new Verifier("http://node")).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, "1" as never, null as never, true as never])(
    "refuses a TCB floor of %o",
    (floor) => {
      expect(() => new Verifier("http://node", { minTcbSvn: floor })).toThrow(/minTcbSvn/);
    },
  );

  it("accepts a floor of 0", () => {
    expect(() => new Verifier("http://node", { minTcbSvn: 0 })).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "60" as never, null as never])(
    "refuses an allowlist TTL of %o",
    (ttl) => {
      expect(() => new Verifier("http://node", { allowlistTtlS: ttl })).toThrow(/allowlistTtlS/);
    },
  );

  // Anchored on the option name, and each on its own: a bare /clock/ matches
  // "wallClock must be …" as readily as "clock must be …", so it would pass on
  // an implementation that validated one option and reported the other.
  it.each([null as never, "now" as never, 123 as never])("refuses a clock of %o", (clock) => {
    expect(() => new Verifier("http://node", { clock })).toThrow(/^clock must be a function/);
    expect(() => new Verifier("http://node", { wallClock: clock })).toThrow(
      /^wallClock must be a function/,
    );
  });

  it("strips a trailing slash from the base url so paths do not double it", async () => {
    const node = scriptedNode({ entries: () => ACTIVE });
    await new Verifier("http://node/", { mode: "mock", fetch: node.fetch }).allowlist();
    expect(node.calls).toEqual(["/evm/allowlist"]);
  });
});

describe("the allowlist envelope", () => {
  it("reads the entries out of {entries, as_of_block} and ignores the rest", async () => {
    // Unsigned on purpose: the chain read is itself the root of trust, so
    // re-checking a curation signature would buy nothing here.
    const node = scriptedNode({ allowlistBody: () => ({ entries: ACTIVE, as_of_block: 4096 }) });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    expect(await verifier.allowlist()).toEqual(ACTIVE);
  });

  it("reads a missing entries key as an EMPTY allowlist, not as a malformed one", async () => {
    const node = scriptedNode({ allowlistBody: () => ({ as_of_block: 1 }) });
    expect(await new Verifier("http://node", { fetch: node.fetch }).allowlist()).toEqual([]);
  });

  it.each([
    [() => [] as unknown, /expected an object/],
    [() => "entries", /expected an object/],
    [() => ({ entries: "malformed" }), /entries is not a list/],
    [() => ({ entries: [ACTIVE[0], "a-bare-string"] }), /entry is not an object/],
    [() => ({ entries: [["kind", "image"]] }), /entry is not an object/],
  ])("refuses a malformed envelope %#", async (body, match) => {
    const node = scriptedNode({ allowlistBody: body });
    const verifier = new Verifier("http://node", { fetch: node.fetch });
    await expect(verifier.allowlist()).rejects.toThrow(match);
    await expect(verifier.allowlist()).rejects.toBeInstanceOf(VerificationError);
  });

  it("refuses a body that is not JSON at all", async () => {
    const node = scriptedNode({ allowlistText: () => "<html>502</html>" });
    await expect(new Verifier("http://node", { fetch: node.fetch }).allowlist()).rejects.toThrow(
      /not JSON/,
    );
  });

  it("raises an HTTP failure LOUDLY, and never as a VerificationError (R2)", async () => {
    // Chain state we could not read must never masquerade as "this provider
    // failed verification" — that would silently narrow the candidate field on
    // an auth or infrastructure fault.
    const node = scriptedNode({ entries: () => ACTIVE, allowlistStatus: () => 503 });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    const error = await verifier.allowlist().then(
      () => expect.unreachable("a 503 must not resolve"),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VorqError);
    expect(error).not.toBeInstanceOf(VerificationError);
    expect((error as VorqError).statusCode).toBe(503);
  });

  it("wraps a fetch that never became a response in TransportError", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const error = await new Verifier("http://node", { fetch: dead }).allowlist().then(
      () => expect.unreachable("a dead socket must not resolve"),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VorqError);
    expect(error).not.toBeInstanceOf(VerificationError);
  });
});

describe("the cache", () => {
  it("reads chain state once and serves the second call from the cache", async () => {
    const node = scriptedNode({ entries: () => ACTIVE });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    expect(await verifier.allowlist()).toEqual(ACTIVE);
    expect(await verifier.allowlist()).toEqual(ACTIVE);
    expect(node.allowlistReads).toBe(1);
  });

  it("re-reads once the TTL lapses, and not a second before", async () => {
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, now, node } = ttlVerifier(state, 60);
    await verifier.allowlist();
    now.t += 59;
    await verifier.allowlist();
    expect(node.allowlistReads).toBe(1);
    now.t += 2;
    await verifier.allowlist();
    expect(node.allowlistReads).toBe(2);
  });

  it("applies a revocation once the TTL lapses — the whole reason it expires", async () => {
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, now } = ttlVerifier(state, 30);
    expect(await verifier.allowlist()).toEqual(ACTIVE);
    state.entries = REVOKED;
    expect(await verifier.allowlist()).toEqual(ACTIVE); // cached: the old answer
    now.t += 30;
    expect(await verifier.allowlist()).toEqual(REVOKED);
  });

  it("re-reads every time at a zero TTL", async () => {
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, node } = ttlVerifier(state, 0);
    await verifier.allowlist();
    await verifier.allowlist();
    expect(node.allowlistReads).toBe(2);
  });

  it("counts a backwards clock as expired rather than pinning the cache", async () => {
    // A clock that steps backwards would make `now - fetchedAt` shrink forever
    // and pin a stale — possibly revoked — allowlist for good.
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, now, node } = ttlVerifier(state, 60);
    await verifier.allowlist();
    state.entries = REVOKED;
    now.t -= 5000;
    expect(await verifier.allowlist()).toEqual(REVOKED);
    expect(node.allowlistReads).toBe(2);
  });

  it("does NOT extend the stale window when the re-read fails", async () => {
    const status = { code: 200 };
    const state = { entries: ACTIVE as unknown[] };
    const now = { t: 0 };
    const node = scriptedNode({ entries: () => state.entries, allowlistStatus: () => status.code });
    const verifier = new Verifier("http://node", {
      mode: "mock",
      allowlistTtlS: 10,
      clock: () => now.t,
      fetch: node.fetch,
    });
    await verifier.allowlist();
    status.code = 503;
    now.t += 11;
    await expect(verifier.allowlist()).rejects.not.toBeInstanceOf(VerificationError);
    // and a malformed 200 is a verification failure, not a stale accept
    status.code = 200;
    state.entries = "malformed" as never;
    await expect(verifier.allowlist()).rejects.toThrow(/entries is not a list/);
  });

  it("refresh() re-reads immediately and applies a revocation on the spot", async () => {
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, node } = ttlVerifier(state, 3600);
    await verifier.allowlist();
    state.entries = REVOKED;
    expect(await verifier.refresh()).toEqual(REVOKED);
    expect(node.allowlistReads).toBe(2);
    expect(await verifier.allowlist()).toEqual(REVOKED); // and it is now the cache
    expect(node.allowlistReads).toBe(2);
  });

  it("invalidate() forces the NEXT read to go to the chain", async () => {
    const state = { entries: ACTIVE as unknown[] };
    const { verifier, node } = ttlVerifier(state, 3600);
    await verifier.allowlist();
    state.entries = REVOKED;
    verifier.invalidate();
    expect(await verifier.allowlist()).toEqual(REVOKED);
    expect(node.allowlistReads).toBe(2);
  });

  it("shares one read between two callers that arrive together (R3)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node = scriptedNode({
      entries: () => ACTIVE,
      beforeAllowlist: (n) => (n === 1 ? gate : undefined),
    });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    const both = Promise.all([verifier.allowlist(), verifier.allowlist()]);
    release();
    expect(await both).toEqual([ACTIVE, ACTIVE]);
    expect(node.allowlistReads).toBe(1);
  });

  it("does not cache an answer that an invalidate() overtook mid-read", async () => {
    // The NARROW half of the notice-mid-read contract, and only that half: the
    // answer the in-flight read brings back predates the invalidation, so it
    // must not be cached — and restamped for another full TTL — on top of it.
    // This says nothing about a caller that arrives *inside* the window; that
    // is the wider half, and the two tests below are what pin it. Reading this
    // one as covering both is how a fail-open lived here through a review.
    const state = { entries: ACTIVE as unknown[] };
    let release: () => void = () => {};
    const started = { fired: false };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node = scriptedNode({
      entries: () => state.entries,
      beforeAllowlist: (n) => {
        if (n !== 1) return undefined;
        started.fired = true;
        return gate;
      },
    });
    const verifier = new Verifier("http://node", {
      mode: "mock",
      allowlistTtlS: 3600,
      fetch: node.fetch,
    });
    const first = verifier.allowlist();
    await vi.waitFor(() => expect(started.fired).toBe(true));
    state.entries = REVOKED; // the chain revokes the image
    verifier.invalidate(); // the notice arrives mid-read
    release();
    expect(await first).toEqual(ACTIVE); // that read still answers
    expect(await verifier.allowlist()).toEqual(REVOKED); // but nothing was pinned
    expect(node.allowlistReads).toBe(2);
  });

  /**
   * A verifier whose first read is parked mid-flight, with the chain state
   * already revoked behind it. `release()` lets that first read answer.
   *
   * The gate holds open the window a joined promise cannot see out of — between
   * a read going out and its answer coming back — so a test can put a caller
   * *inside* it. Every assertion below is about that interior.
   */
  async function parkedRead() {
    const state = { entries: ACTIVE as unknown[] };
    let release: () => void = () => {};
    const started = { fired: false };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node = scriptedNode({
      entries: () => state.entries,
      beforeAllowlist: (n) => {
        if (n !== 1) return undefined;
        started.fired = true;
        return gate;
      },
    });
    const verifier = new Verifier("http://node", {
      mode: "mock",
      allowlistTtlS: 3600,
      fetch: node.fetch,
    });
    const first = verifier.allowlist();
    await vi.waitFor(() => expect(started.fired).toBe(true));
    state.entries = REVOKED; // the chain revokes the image
    return { verifier, node, first, release };
  }

  it("refresh() during an in-flight read does a REAL read, not a join onto the stale one", async () => {
    // `refresh()` is the documented API for a revocation notice, so a notice
    // landing while a read happens to be open is its CENTRAL case, not an edge
    // one. Joining the parked read would make it a silent no-op at precisely
    // the moment it is being relied on.
    const { verifier, node, first, release } = await parkedRead();
    const refreshed = verifier.refresh();
    release();
    expect(await first).toEqual(ACTIVE); // the parked read still answers its own caller
    expect(await refreshed).toEqual(REVOKED);
    expect(node.allowlistReads).toBe(2);
  });

  it("a caller joining after an invalidate() sees the revocation, not the parked answer", async () => {
    // Notice lands, and a check arrives before the read that predates it has
    // come back. `matchImageEntry` reaches chain state through this same
    // `cachedEntries()`, so what is pinned here is what a confidential
    // submission is checked against.
    const { verifier, node, first, release } = await parkedRead();
    verifier.invalidate(); // the notice
    const joiner = verifier.allowlist(); // a check arriving INSIDE the window
    release();
    expect(await first).toEqual(ACTIVE);
    expect(await joiner).toEqual(REVOKED);
    expect(node.allowlistReads).toBe(2);
  });

  it("hands out a COPY: mutating the result cannot rewrite the cache", async () => {
    const node = scriptedNode({ entries: () => ACTIVE });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    const entries = await verifier.allowlist();
    entries[0]!.status = "revoked";
    entries.push({ kind: "image", measurement: "00".repeat(32), status: "active", mock: true });
    expect(await verifier.allowlist()).toEqual(ACTIVE);
  });
});

describe("entry normalization", () => {
  const withEntries = (entries: unknown[], mode: "mock" | "structural" = "mock") =>
    new Verifier("http://node", { mode, fetch: scriptedNode({ entries: () => entries }).fetch });

  /** `matchImageEntry` has no public door, so the record path is how it is reached. */
  const check = async (entries: unknown[], mode: "mock" | "structural" = "mock") =>
    withEntries(entries, mode).verifyRecord({
      provider: 7,
      operator: WALLET,
      box_key: BOX,
      evidence: evidence(),
    });

  it("reads the chain-projected shape {key, status:int, entry:{…}}", async () => {
    // A verifier that read only the flat form would match nothing at all: no
    // exception, no diagnostic, just an allowlist refusing every honest node.
    await expect(
      check([
        {
          key: `0x${"aa".repeat(32)}`,
          status: 1,
          entry: { kind: "cvm-image", measurement: MEASUREMENT, mock: true },
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it("reads a status-2 row as a TOMBSTONE, not as an absence", async () => {
    await expect(
      check([
        {
          key: `0x${"aa".repeat(32)}`,
          status: 2,
          entry: { kind: "cvm-image", measurement: MEASUREMENT, mock: true },
        },
      ]),
    ).rejects.toThrow(/revoked/);
  });

  it("treats an unreadable status as neither active nor revoked", async () => {
    await expect(
      check([
        {
          key: `0x${"aa".repeat(32)}`,
          status: 99,
          entry: { kind: "cvm-image", measurement: MEASUREMENT, mock: true },
        },
      ]),
    ).rejects.toThrow(/not active/);
  });

  it("does NOT fall through to the blob on an explicit null (R7)", async () => {
    // Python's dict.get(key, default) uses the default only when the key is
    // ABSENT. `??` would treat this null as absence and match an entry the
    // authority refuses — a divergence on the accepting side.
    await expect(
      check([
        { kind: null, entry: { kind: "image", measurement: MEASUREMENT, mock: true }, status: 1 },
      ]),
    ).rejects.toThrow(/not on the allowlist/);
  });

  it("knows both image spellings", async () => {
    for (const kind of ["image", "cvm-image"]) {
      await expect(
        check([{ kind, measurement: MEASUREMENT, status: "active", mock: true }]),
      ).resolves.toBeUndefined();
    }
  });

  it("does not treat a policy entry as an image", async () => {
    await expect(
      check([{ kind: "policy", measurement: MEASUREMENT, status: "active", mock: true }]),
    ).rejects.toThrow(/not on the allowlist/);
  });

  it("lets a revocation win over a duplicate active entry", async () => {
    // Every matching entry must clear the check, not just the first: a list
    // that re-lists a revoked measurement as active must not resurrect it.
    await expect(
      check([
        { kind: "image", measurement: MEASUREMENT, status: "revoked", mock: true },
        { ...ACTIVE[0] },
      ]),
    ).rejects.toThrow(/revoked/);
    await expect(
      check([{ ...ACTIVE[0] }, { kind: "image", measurement: MEASUREMENT, status: "revoked" }]),
    ).rejects.toThrow(/revoked/);
  });

  it("refuses a mock record outside mock mode, whatever the list is padded with", async () => {
    // Renamed to what it asserts. It used to claim it pinned the ENTRY-level
    // mock gate under a shadowing non-mock duplicate, and it never reached it:
    // in structural mode `verifyRecord` refuses the `mock-cvm-v1` tag before
    // `matchImageEntry` is called, so the evidence gate answers every time and a
    // bare `/mock/` could not tell which one had. The entry gate is pinned in
    // `verify-record.test.ts`, with this same shadowed pair, by calling
    // `matchImageEntry` directly — the only door it has. The message is pinned
    // here so this test can no longer be satisfied by the gate it does not test.
    await expect(
      check(
        [
          { kind: "image", measurement: MEASUREMENT, status: "active" },
          { ...ACTIVE[0] },
        ],
        "structural",
      ),
    ).rejects.toThrow(/mock evidence is refused outside mock mode/);
  });
});
