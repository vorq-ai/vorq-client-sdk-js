/**
 * `verifyCandidates` — the seal-target pin.
 *
 * Two properties carry this suite. A candidate is kept only if its record
 * verifies **and** the key it asks to be sealed to IS the key that record
 * attested; and a read that did not work must never be spelled as a provider
 * that failed verification, because that silently narrows — or empties — the
 * candidate field on an auth or infrastructure fault.
 */
import { describe, expect, it } from "vitest";

import { TransportError, VerificationError, VorqError } from "../src/errors.js";
import { Verifier } from "../src/verify.js";
import {
  ACTIVE,
  BOX,
  WALLET,
  evidence,
  otherRecord,
  record,
  scriptedNode,
} from "./helpers/verify-harness.js";

const withRecords = (
  records: Record<number, unknown>,
  options: { mode?: "mock" | "structural"; entries?: unknown[]; recordStatus?: () => number } = {},
) => {
  const node = scriptedNode({
    entries: () => options.entries ?? ACTIVE,
    records,
    recordStatus: options.recordStatus,
  });
  return {
    node,
    verifier: new Verifier("http://node", { mode: options.mode ?? "mock", fetch: node.fetch }),
  };
};

/** The one read `verifyCandidates` makes before it looks at any candidate. */
const ALLOWLIST_ONLY = ["/evm/allowlist"];

describe("verifyCandidates", () => {
  it("keeps only the candidate that verifies AND whose key IS the record key", async () => {
    const { verifier } = withRecords({
      1: record(evidence(), 1), // verifies; box_key matches
      2: otherRecord(2), // verifies on its own; box_key differs → the pin drops it
      3: record(evidence({ debug: true }), 3), // fails verification → dropped
    });
    const kept = await verifier.verifyCandidates([
      { provider: 1, box_key: BOX },
      { provider: 2, box_key: BOX },
      { provider: 3, box_key: BOX },
    ]);
    expect(kept.map((c) => c.provider)).toEqual([1]);
  });

  it("returns the candidates themselves, not the records they were checked against", async () => {
    // The caller's own challenge entry comes back untouched, extra fields and
    // all — it is what carries the price the 402 quoted. Returning the record
    // instead would look identical to every `provider`-only assertion in this
    // file while silently changing the public contract.
    const candidate = { provider: 1, box_key: BOX, price_wei: "1234" };
    const { verifier } = withRecords({ 1: record(evidence(), 1) });
    const kept = await verifier.verifyCandidates([candidate]);
    expect(kept).toEqual([candidate]);
    expect(kept[0]).toBe(candidate);
  });

  it("returns [] for an empty input without reading anything", async () => {
    const { verifier, node } = withRecords({});
    expect(await verifier.verifyCandidates([])).toEqual([]);
    expect(node.calls).toEqual([]);
  });

  it.each([[null], [undefined], ["candidates"], [7], [{ 0: { provider: 1 } }]])(
    "refuses a candidate list that is not a list (%o), never answering []",
    async (candidates) => {
      // The list arrives in a `402` body, so this is `challenge.candidates` and
      // the `unknown[]` annotation is not a runtime guard. `[]` here would be
      // read as "every candidate was refused" — the silent narrowing the whole
      // method is written against — so it refuses instead, and refuses before
      // opening a socket, since there is nothing yet to check chain state for.
      const { verifier, node } = withRecords({ 1: record(evidence(), 1) });
      const error = await verifier
        .verifyCandidates(candidates as unknown as unknown[])
        .then(
          () => expect.unreachable("a malformed candidate list must not resolve"),
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VorqError).message).toMatch(/candidates is not a list/);
      expect(node.calls).toEqual([]);
    },
  );

  it("preserves input order", async () => {
    const { verifier } = withRecords({
      1: record(evidence(), 1),
      2: record(evidence(), 2),
      3: record(evidence(), 3),
    });
    const kept = await verifier.verifyCandidates([
      { provider: 3, box_key: BOX },
      { provider: 1, box_key: BOX },
      { provider: 2, box_key: BOX },
    ]);
    expect(kept.map((c) => c.provider)).toEqual([3, 1, 2]);
  });

  it("resolves chain state UP FRONT, so an unreadable allowlist surfaces", async () => {
    // An unreadable allowlist must not masquerade as "every provider failed
    // verification" — that empties the field silently. The node below serves no
    // provider records at all, so without the up-front read every candidate
    // takes the 404 drop and this resolves `[]` instead of raising.
    const node = scriptedNode({ allowlistBody: () => ({ entries: "malformed" }) });
    const verifier = new Verifier("http://node", { mode: "mock", fetch: node.fetch });
    await expect(verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).rejects.toThrow(
      /entries is not a list/,
    );
  });

  it.each([401, 403, 500, 503])(
    "raises on an unreadable record (%d) rather than dropping the candidate",
    async (status) => {
      const { verifier } = withRecords(
        { 1: record(evidence(), 1) },
        { recordStatus: () => status },
      );
      const error = await verifier.verifyCandidates([{ provider: 1, box_key: BOX }]).then(
        () => expect.unreachable("an unreadable record must not resolve"),
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VorqError).message).toMatch(/unreadable/);
    },
  );

  it("drops a candidate with NO record and lets the others stand", async () => {
    // A 404 means this candidate has nothing to attest, but the read itself
    // worked — the other candidates are unaffected.
    const { verifier } = withRecords({ 1: record(evidence(), 1) });
    const kept = await verifier.verifyCandidates([
      { provider: 9, box_key: BOX },
      { provider: 1, box_key: BOX },
    ]);
    expect(kept.map((c) => c.provider)).toEqual([1]);
  });

  it.each([
    [null],
    ["a candidate"],
    [7],
    [{ box_key: BOX }],
    [{ provider: null, box_key: BOX }],
    [{ provider: true, box_key: BOX }],
    [Object.assign([], { provider: 1, box_key: BOX })],
    [{ provider: -1, box_key: BOX }],
    [{ provider: 1.5, box_key: BOX }],
    [{ provider: 1e21, box_key: BOX }],
    [{ provider: Number.MAX_SAFE_INTEGER + 10, box_key: BOX }],
    [{ provider: "../key", box_key: BOX }],
    [{ provider: "1e3", box_key: BOX }],
    [{ provider: "1".repeat(21), box_key: BOX }],
  ])("drops a hostile candidate shape %o, reading no provider record", async (candidate) => {
    // Interpolating an untrusted value into the request path would let a
    // hostile challenge point the record fetch at another endpoint or host, so
    // the assertion is on the whole call log, not on a `/evm/providers/`
    // prefix: `../key` is the one shape that leaves that prefix behind — the
    // URL normalizes it away to `/evm/key` — and a prefix filter would not see
    // the very traversal this guard exists to stop.
    //
    // Three rows are about a path that is merely *wrong* rather than hostile.
    // The array carries its own `provider` and `box_key`, so only the array arm
    // of `isPlainObject` refuses it — weaken that guard to a null check and it
    // is read, and kept. `1e21` stringifies to `1e+21`, and every whole number
    // past 2^53 stands for a range of ids rather than one, so both would name
    // an id the caller never asked for. Provider 1 is on this node, which is
    // what makes any of those reads observable.
    const { verifier, node } = withRecords({ 1: record(evidence(), 1) });
    expect(await verifier.verifyCandidates([candidate])).toEqual([]);
    expect(node.calls).toEqual(ALLOWLIST_ONLY);
  });

  it("drops a record that answers for a DIFFERENT provider id", async () => {
    // A misrouted read. Confidentiality does not rest on this — the box-key pin
    // below does — but a lying reader should not be used. This record verifies
    // and its key matches, so the echo check is the only thing dropping it.
    const { verifier } = withRecords({ 1: record(evidence(), 5) });
    expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toEqual([]);
  });

  it.each([
    ["omitted", { operator: WALLET, box_key: BOX, evidence: evidence() }],
    ["explicitly null", { ...record(evidence(), 1), provider: null }],
  ])("keeps a candidate whose record echo is %s", async (_label, rec) => {
    // Two arms, because in JavaScript they are two values. Python reads the
    // echo with `.get()`, which collapses an absent key and a null one into
    // `None`, so its `echoed is not None` cannot be half-removed; here the
    // guard is `!== null && !== undefined` and either half can be dropped
    // alone. A node that serializes an unset column as `null` rather than
    // omitting it would then have every one of its records dropped — the
    // silently emptied candidate field this method exists to prevent — so both
    // spellings are pinned rather than the one the fixture happened to build.
    const { verifier } = withRecords({ 1: rec });
    expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toHaveLength(1);
  });

  it.each([[null], ["a record"], [["a record"]], [7]])(
    "drops a candidate whose record body is not an object (%o)",
    async (body) => {
      const { verifier } = withRecords({ 1: body });
      expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toEqual([]);
    },
  );

  it("drops a candidate whose record body is not JSON at all", async () => {
    // The `response.json()` rejection has no other test: a gateway's HTML in
    // place of a record must drop that candidate, not escape as a SyntaxError.
    const node = scriptedNode({ entries: () => ACTIVE });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/evm/providers/")) {
        return new Response("<html>nope</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return node.fetch(input, init);
    }) as unknown as typeof globalThis.fetch;
    const verifier = new Verifier("http://node", { mode: "mock", fetch: fetchImpl });
    expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toEqual([]);
  });

  it("compares the two keys after normalizing BOTH, never as strings", async () => {
    // A prefixed record against a bare challenge is the same key.
    const prefixed = { ...record(evidence(), 1), box_key: `0x${BOX}` };
    const { verifier } = withRecords({ 1: prefixed });
    const kept = await verifier.verifyCandidates([{ provider: 1, box_key: BOX.toUpperCase() }]);
    expect(kept).toHaveLength(1);
  });

  it.each([[undefined], [null], [7], ["not-a-key"], ["ab".repeat(31)]])(
    "drops a candidate whose own box_key is unusable (%o)",
    async (boxKey) => {
      // The record here verifies, so every row reaches the challenge-key check
      // rather than tripping something earlier.
      const { verifier } = withRecords({ 1: record(evidence(), 1) });
      expect(await verifier.verifyCandidates([{ provider: 1, box_key: boxKey }])).toEqual([]);
    },
  );

  it("drops a candidate whose record carries no usable box_key — at the binding", async () => {
    // Named for where it actually fails, and the second assertion is what
    // makes that name checkable rather than asserted. `verifyRecord` computes
    // the binding over `record.box_key`, so an unusable one raises *there* and
    // never reaches the pin — which is why the pin's own
    // `typeof recordKey !== "string"` guard is unreachable through this method
    // and no test in this file can distinguish it from a bare cast.
    const keyless = { provider: 1, operator: WALLET, evidence: evidence() };
    const { verifier } = withRecords({ 1: keyless });
    expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toEqual([]);
    await expect(verifier.verifyRecord(keyless)).rejects.toThrow(
      /box_key is not a 32-byte hex/,
    );
  });

  it("surfaces a transport fault raised inside verifyRecord, never dropping the candidate", async () => {
    // The `catch` around `verifyRecord` narrows on `VerificationError`. A dead
    // socket mid-loop is a `TransportError` and must propagate: a bare
    // `catch { continue }` would spell an infrastructure fault as "this
    // provider failed verification", which is the failure this method exists
    // against. The fault has to come from *inside* `verifyRecord` to test that
    // catch, so the allowlist TTL is zero and the re-read `matchImageEntry`
    // makes is the read that fails.
    const node = scriptedNode({ entries: () => ACTIVE, records: { 1: record(evidence(), 1) } });
    let allowlistReads = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/evm/allowlist") {
        allowlistReads += 1;
        if (allowlistReads === 2) throw new Error("socket closed");
      }
      return node.fetch(input, init);
    }) as unknown as typeof globalThis.fetch;
    const verifier = new Verifier("http://node", {
      mode: "mock",
      fetch: fetchImpl,
      allowlistTtlS: 0,
    });
    await expect(
      verifier.verifyCandidates([{ provider: 1, box_key: BOX }]),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("surfaces a transport fault on a later provider read, never dropping the candidate", async () => {
    // The record read sits outside the `verifyRecord` try, so this pins a
    // different line from the test above: a `this.get` wrapped in a swallowing
    // catch would drop candidate 2 and keep candidate 1. It does NOT exercise
    // the `instanceof` narrowing — verified by mutation, see the report.
    const node = scriptedNode({
      entries: () => ACTIVE,
      records: { 1: record(evidence(), 1), 2: record(evidence(), 2) },
    });
    let providerReads = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/evm/providers/")) {
        providerReads += 1;
        if (providerReads === 2) throw new Error("socket closed");
      }
      return node.fetch(input, init);
    }) as unknown as typeof globalThis.fetch;
    const verifier = new Verifier("http://node", { mode: "mock", fetch: fetchImpl });
    await expect(
      verifier.verifyCandidates([
        { provider: 1, box_key: BOX },
        { provider: 2, box_key: BOX },
      ]),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("drops a mock-tagged candidate in structural mode, where mock evidence is refused", async () => {
    // Named for the branch it actually takes, and the second assertion is what
    // makes that name checkable. `verifyRecord` tests the evidence tag before
    // it resolves a measurement, so a mock-tagged record in structural mode
    // stops at "mock evidence is refused outside mock mode" — the arm where a
    // validator *does* exist. It never reaches "no validator for it", and it
    // never reaches the allowlist, which is why this fixture leaves the entries
    // alone: an override there would be inert setup that reads as deliberate.
    const rec = record(evidence(), 1);
    const { verifier } = withRecords({ 1: rec }, { mode: "structural" });
    expect(await verifier.verifyCandidates([{ provider: 1, box_key: BOX }])).toEqual([]);
    await expect(verifier.verifyRecord(rec)).rejects.toThrow(
      /^mock evidence is refused outside mock mode$/,
    );
  });
});
