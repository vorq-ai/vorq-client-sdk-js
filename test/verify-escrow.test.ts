import { describe, expect, it } from "vitest";
import { VerificationError } from "../src/errors.js";
import { KEY_FRESHNESS_S, Verifier, escrowReportData, reportData } from "../src/verify.js";
import {
  ESCROW_ACTIVE,
  ESCROW_BOX,
  ESCROW_MEASUREMENT,
  NOW,
  WALLET,
  announcement,
  escrowBindingOf,
  refusingFetch,
  scriptedNode,
  staticAnnouncement,
} from "./helpers/verify-harness.js";

/** A verifier over a scripted allowlist and a pinned wall clock. */
const escrowVerifier = (
  entries: unknown[] = ESCROW_ACTIVE,
  mode: "mock" | "structural" = "mock",
  minTcbSvn = 1,
) =>
  new Verifier("http://node", {
    mode,
    minTcbSvn,
    wallClock: () => NOW,
    fetch: scriptedNode({ entries: () => entries }).fetch,
  });

/**
 * A verifier whose fetch fails the test if it is called.
 *
 * The static path must read no allowlist: there is no measurement to look up,
 * and a client that reached for one would make a chain read to seal every open
 * order. A fetch that throws is how that is asserted rather than assumed — and
 * it does surface: `get()` wraps the throw in a `TransportError` and every
 * frame above it awaits, so a stray read rejects the call rather than being
 * swallowed.
 */
const refusingVerifier = (mode: "mock" | "structural" = "structural") =>
  new Verifier("http://node", { mode, wallClock: () => NOW, fetch: refusingFetch() });

describe("verifyEscrowKey — measured (mock-coordinator) evidence", () => {
  it("returns the key it announces", async () => {
    expect(await escrowVerifier().verifyEscrowKey(announcement())).toBe(ESCROW_BOX);
  });

  // One row per check on the measured path, each pinning a different one:
  // the binding, the allowlist lookup, the debug flag, the TCB floor, and the
  // three ways a tag fails to be `mock-coordinator-v1`.
  it.each<[Record<string, unknown>, RegExp]>([
    [{ reportData: "00".repeat(32) }, /does not bind/],
    [{ measurement: "00".repeat(32) }, /not on the allowlist/],
    [{ debug: true }, /debug/],
    [{ svn: 0 }, /TCB/],
    [{ type: "mock-cvm-v1" }, /unrecognized escrow evidence type/],
    [{ type: "unknown-v9" }, /unrecognized escrow evidence type/],
    [{ type: undefined }, /unrecognized escrow evidence type/],
  ])("refuses %o", async (over, match) => {
    await expect(escrowVerifier().verifyEscrowKey(announcement(over))).rejects.toThrow(match);
    await expect(escrowVerifier().verifyEscrowKey(announcement(over))).rejects.toBeInstanceOf(
      VerificationError,
    );
  });

  it("refuses the PROVIDER mock tag here — a different trust domain", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(announcement({ type: "mock-cvm-v1" })),
    ).rejects.toThrow(/unrecognized escrow evidence type/);
  });

  it("refuses mock coordinator evidence outside mock mode", async () => {
    // Mock evidence is computable by anyone and a mock node hands its whole key
    // set to any caller. That refusal must survive every later change.
    await expect(
      escrowVerifier(ESCROW_ACTIVE, "structural").verifyEscrowKey(announcement()),
    ).rejects.toThrow(/mock/);
  });

  it("refuses a revoked escrow measurement", async () => {
    await expect(
      escrowVerifier([{ ...ESCROW_ACTIVE[0], status: "revoked" }]).verifyEscrowKey(announcement()),
    ).rejects.toThrow(/revoked/);
  });

  it("checks the TCB floor on the measured path", async () => {
    await expect(
      escrowVerifier(ESCROW_ACTIVE, "mock", 4).verifyEscrowKey(announcement({ svn: 3 })),
    ).rejects.toThrow(/TCB/);
    await expect(
      escrowVerifier(ESCROW_ACTIVE, "mock", 4).verifyEscrowKey(announcement({ svn: 4 })),
    ).resolves.toBe(ESCROW_BOX);
  });
});

describe("verifyEscrowKey — the binding is NOT the record binding", () => {
  it("computes a different digest from the same key", async () => {
    expect(escrowReportData(ESCROW_BOX)).not.toBe(reportData(ESCROW_BOX, WALLET));
  });

  it("cannot be routed through verifyRecord", async () => {
    // Adding the coordinator tag to the mock set would route the announcement
    // into verifyRecord. That is wrong twice: the tag belongs to a different
    // trust domain, and the record binding is sha256(box_key ‖ operator) over
    // an operator address `GET /key` does not have and never will — so it would
    // raise on every honest node, reading exactly like a verification failure.
    const body = announcement();
    expect("operator" in body).toBe(false);
    expect("address" in body).toBe(false);
    await expect(
      escrowVerifier().verifyRecord({
        box_key: body.escrow_public_key,
        operator: WALLET,
        evidence: body.evidence,
      }),
    ).rejects.toThrow(/unrecognized evidence type/);
  });

  it("refuses an announcement whose evidence binds it as a record would", async () => {
    // The precise substitution the two functions exist to prevent.
    const wrong = announcement({ reportData: reportData(ESCROW_BOX, WALLET) });
    await expect(escrowVerifier().verifyEscrowKey(wrong)).rejects.toThrow(/does not bind/);
  });

  it("accepts an uppercase report_data — hex case is a spelling, not a value", async () => {
    // The record path pins this; the escrow path did not, in either SDK. A
    // comparison that dropped `.toLowerCase()` would refuse every honest
    // announcement whose evidence hex is uppercase — every open order failing
    // closed with "does not bind the escrow key it announces", which reads like
    // an attack and is a spelling.
    const upper = announcement({ reportData: escrowBindingOf(ESCROW_BOX).toUpperCase() });
    expect(await escrowVerifier().verifyEscrowKey(upper)).toBe(ESCROW_BOX);
  });
});

describe("verifyEscrowKey — hostile shapes", () => {
  // `["a"]` is the row that pins `!Array.isArray`, which `typeof` alone would
  // let through; `null` pins the `!== null` half; the rest pin the `typeof`.
  it.each<[unknown]>([[null], [undefined], [7], ["an announcement"], [["a"]], [true]])(
    "refuses a non-object announcement %o",
    async (body) => {
      await expect(escrowVerifier().verifyEscrowKey(body)).rejects.toThrow(
        /did not answer an object/,
      );
    },
  );

  // `undefined`/`null`/`7` pin the `typeof !== "string"` half. `not-a-key` is
  // 9 characters, so it pins nothing the width does not already pin — the
  // 64-character `zz…` row is the one that pins the CHARSET, and without it a
  // regex widened to `[0-9a-zA-Z]{64}` would be caught by nothing here. That
  // row is also what keeps `BOX_KEY_RE` in front of `fromHex`: widen the
  // charset and this input reaches `fromHex`, which raises a bare
  // `Error("expected hex")` — a malformed shape escaping as something other
  // than a `VerificationError`, which is the one thing this module says it
  // never does. The 31-byte key pins the width. The trailing newline pins `$`
  // meaning end of INPUT — a regex written with the `m` flag would accept it,
  // and Python's `\Z` would not.
  it.each<[unknown]>([
    [undefined],
    [null],
    ["not-a-key"],
    ["zz".repeat(32)],
    ["ab".repeat(31)],
    [7],
    [`${ESCROW_BOX}\n`],
  ])("refuses an announcement with no usable key %o", async (key) => {
    const body = announcement();
    body.escrow_public_key = key;
    await expect(escrowVerifier().verifyEscrowKey(body)).rejects.toThrow(
      /no 32-byte hex escrow_public_key/,
    );
  });

  it("refuses an announcement with no evidence", async () => {
    const body = announcement({ patch: (b) => delete b.evidence });
    await expect(escrowVerifier().verifyEscrowKey(body)).rejects.toThrow(/no attestation evidence/);
  });

  // What comes back is the announced spelling, byte for byte — the caller seals
  // to the string it was handed. The `0x` row pins the prefix; the two
  // uppercase rows are the only ones that die if the return is normalised
  // (`return key.toLowerCase()`), and the `0X` row is the only one that pins
  // the prefix and the case together.
  it.each<[string]>([
    [`0x${ESCROW_BOX}`],
    [ESCROW_BOX.toUpperCase()],
    [`0X${ESCROW_BOX.toUpperCase()}`],
  ])("accepts %s and returns it as announced, spelling and all", async (key) => {
    expect(await escrowVerifier().verifyEscrowKey(announcement({ key }))).toBe(key);
  });
});

describe("verifyEscrowKey — freshness", () => {
  // The two ±KEY_FRESHNESS_S rows are the boundary: they die if `>` becomes
  // `>=`. The 0 row is the happy path.
  it.each([0, KEY_FRESHNESS_S, -KEY_FRESHNESS_S])("accepts a skew of %ds", async (offset) => {
    expect(await escrowVerifier().verifyEscrowKey(announcement({ issuedAt: NOW + offset }))).toBe(
      ESCROW_BOX,
    );
  });

  // `+601` dies if the bound is dropped; `-601` dies if `Math.abs` is dropped,
  // which is the only mutation the positive row cannot see.
  it.each([KEY_FRESHNESS_S + 1, -(KEY_FRESHNESS_S + 1)])(
    "refuses a skew of %ds — a replay, or a wrong clock",
    async (offset) => {
      await expect(
        escrowVerifier().verifyEscrowKey(announcement({ issuedAt: NOW + offset })),
      ).rejects.toThrow(/freshness bound/);
    },
  );

  // Each row asserts the message of the guard it targets, not just the string
  // `issued_at`. The freshness message contains `issued_at` too, so a loose
  // match would let `null`, `true` and `Infinity` pass with their own guard
  // deleted — the check would have run, produced the wrong answer, and still
  // matched.
  it.each<[unknown, RegExp]>([
    [undefined, /states no numeric issued_at/],
    [null, /states no numeric issued_at/],
    ["1790000000", /states no numeric issued_at/],
    [true, /states no numeric issued_at/],
    [Number.POSITIVE_INFINITY, /states a non-finite issued_at/],
    [Number.NaN, /states a non-finite issued_at/],
  ])("refuses an unusable issued_at %o", async (issuedAt, match) => {
    await expect(escrowVerifier().verifyEscrowKey(announcement({ issuedAt }))).rejects.toThrow(
      match,
    );
  });

  it("checks freshness BEFORE any chain read, so a replay costs no traffic", async () => {
    // Measured evidence on purpose: the static path reads no allowlist at all,
    // so it could not tell a check that moved from one that did not.
    const node = scriptedNode({ entries: () => ESCROW_ACTIVE });
    const v = new Verifier("http://node", {
      mode: "mock",
      wallClock: () => NOW,
      fetch: node.fetch,
    });
    await expect(v.verifyEscrowKey(announcement({ issuedAt: 1 }))).rejects.toThrow(
      /freshness bound/,
    );
    expect(node.allowlistReads).toBe(0);
  });

  it("uses the WALL clock, not the monotonic one", async () => {
    // A monotonic reading is a count of seconds since an arbitrary origin. A
    // verifier that compared issued_at against it would refuse every
    // announcement ever made.
    const v = new Verifier("http://node", {
      mode: "mock",
      wallClock: () => NOW,
      clock: () => 5, // a plausible monotonic reading, seconds into the process
      fetch: scriptedNode({ entries: () => ESCROW_ACTIVE }).fetch,
    });
    await expect(v.verifyEscrowKey(announcement())).resolves.toBe(ESCROW_BOX);
  });
});

describe("verifyEscrowKey — static-coordinator-v1", () => {
  it.each(["structural", "mock"] as const)("is accepted in %s mode", async (mode) => {
    // Accepted under the default mode, so a user of a static fleet configures
    // nothing. Unlike the mock tag it claims nothing beyond the binding itself,
    // and that smaller, true claim is exactly what is checked.
    expect(await refusingVerifier(mode).verifyEscrowKey(staticAnnouncement())).toBe(ESCROW_BOX);
  });

  it("reads NO allowlist — the fetch would throw if it did", async () => {
    expect(await refusingVerifier().verifyEscrowKey(staticAnnouncement())).toBe(ESCROW_BOX);
  });

  it("reads no allowlist even when a measurement is there to look up", async () => {
    // The test above goes red on "no usable measurement" if the static branch
    // is made measured — it never reaches the transport, so the refusing fetch
    // asserts nothing on its own. This one hands the static path a hostile node
    // that volunteers every measured field, so the branch would sail through
    // `matchImageEntry` and the TCB floor and the ONLY surviving assertion is
    // the read count. That is what makes "reads no allowlist" a claim about
    // the code rather than about the fixture.
    const node = scriptedNode({ entries: () => ESCROW_ACTIVE });
    const v = new Verifier("http://node", {
      mode: "mock",
      wallClock: () => NOW,
      fetch: node.fetch,
    });
    const body = staticAnnouncement({
      patch: (b) => {
        const ev = b.evidence as Record<string, unknown>;
        ev.measurement = ESCROW_MEASUREMENT;
        ev.tcb = { svn: 1 };
      },
    });
    expect(await v.verifyEscrowKey(body)).toBe(ESCROW_BOX);
    expect(node.allowlistReads).toBe(0);
  });

  it("floors no TCB, because there is no measured image to floor", async () => {
    const v = new Verifier("http://node", {
      minTcbSvn: 9,
      wallClock: () => NOW,
      fetch: refusingFetch(),
    });
    expect(await v.verifyEscrowKey(staticAnnouncement())).toBe(ESCROW_BOX);
  });

  // The checks the static path keeps: the binding, the debug flag, the
  // freshness bound and a usable `issued_at`. One row each; every one of them
  // dies if the static branch returns early instead of falling through.
  it.each<[Record<string, unknown>, RegExp]>([
    [{ reportData: "00".repeat(32) }, /does not bind/],
    [{ debug: true }, /debug/],
    [{ issuedAt: NOW + KEY_FRESHNESS_S + 1 }, /freshness bound/],
    [{ issuedAt: undefined }, /states no numeric issued_at/],
  ])("still refuses %o", async (over, match) => {
    await expect(refusingVerifier().verifyEscrowKey(staticAnnouncement(over))).rejects.toThrow(
      match,
    );
  });

  it("still needs a boolean debug flag", async () => {
    const body = staticAnnouncement({
      patch: (b) => delete (b.evidence as Record<string, unknown>).debug,
    });
    await expect(refusingVerifier().verifyEscrowKey(body)).rejects.toThrow(/debug/);
  });

  it("does not soften the mock guard it sits beside", async () => {
    // The reason for a second tag rather than reusing the mock one.
    await expect(
      escrowVerifier(ESCROW_ACTIVE, "structural").verifyEscrowKey(announcement()),
    ).rejects.toThrow(/mock/);
  });

  it("is refused on the RECORD path — it is not a provider's evidence", async () => {
    const body = staticAnnouncement();
    await expect(
      escrowVerifier().verifyRecord({
        box_key: ESCROW_BOX,
        operator: WALLET,
        evidence: body.evidence,
      }),
    ).rejects.toThrow(/unrecognized evidence type/);
  });
});
