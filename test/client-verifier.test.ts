/**
 * The two submission paths a `verifier` opens, and the two that stay shut
 * without one.
 *
 * Every fixture here comes from one of the two harnesses. `submit-harness`
 * owns the signing path — the key, the chain context, the cipher, the recipient
 * whose secret opens a container — and `verify-harness` owns the attestation
 * fixtures. Neither is restated: a second copy of a signing-path fixture drifts,
 * and a drifted one proves nothing.
 *
 * **The two announced/registered keys are `RECIPIENT_PUBLIC` rather than the
 * verify harness's own `BOX`/`ESCROW_BOX`, and that is what makes "sealed to
 * the verified key" assertable at all.** The test holds `RECIPIENT_SECRET`, so
 * `openEnvelope` either opens the container the client uploaded or it does not,
 * and only the right recipient makes it open. Asserting on a key the test
 * cannot open would leave the seal target unpinned.
 */
import { describe, expect, it, vi } from "vitest";

import {
  EscrowKeyUnverified,
  TransportError,
  ValidationError,
  VerificationError,
} from "../src/errors.js";
import { Verifier, type VerifierOptions } from "../src/verify.js";
import {
  ACTIVE,
  ESCROW_ACTIVE,
  NOW,
  WALLET,
  announcement,
  bindingOf,
  evidence,
  record,
  refusingFetch,
  scriptedNode,
  staticAnnouncement,
  type ScriptOptions,
} from "./helpers/verify-harness.js";
import {
  QUOTE,
  RECIPIENT_PUBLIC,
  type Call,
  type Route,
  baseRoutes,
  client,
  funded,
  json,
  openEnvelope,
  posts,
} from "./helpers/submit-harness.js";

/**
 * A verifier over a scripted node, in `mock` mode and on a stopped wall clock.
 *
 * `mock` because both measured fixtures carry mock tags, and `wallClock` because
 * `issued_at` is stamped at the harness's fixed `NOW`: a real clock would make
 * the freshness bound decide the test.
 */
function verifier(script: ScriptOptions = {}, options: VerifierOptions = {}): Verifier {
  return new Verifier("http://chain", {
    mode: "mock",
    wallClock: () => NOW,
    fetch: scriptedNode(script).fetch,
    ...options,
  });
}

/** A provider record that verifies, whose key the test can open a container to. */
const verifiableRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...record(evidence({ reportData: bindingOf(RECIPIENT_PUBLIC, WALLET) })),
  box_key: RECIPIENT_PUBLIC,
  ...over,
});

/** An announcement whose key the test can open a container to. */
const openable = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...announcement({ key: RECIPIENT_PUBLIC }),
  ...over,
});

/** Where a submission's uploaded container and signed `vorq` block land. */
/** Both are JSON now: the order off the challenge, and `container` off the
 * paid body — base64, decoded back to bytes as it lands. */
interface Captured extends Record<string, unknown> {
  container?: Uint8Array;
}

/**
 * `POST /v1/jobs`: a `402` quote to the terms-only challenge, the job to the
 * funded body, and so on for a second submission.
 *
 * Odd/even rather than a count of one, because the cache test submits twice
 * through one client and the second submission opens with its own challenge.
 */
const jobsRoute = (captured: Captured): Route => [
  /\/v1\/jobs$/,
  (n, body) => {
    if (n % 2 === 1) Object.assign(captured, body as object);
    else captured.container = Buffer.from((body as { container: string }).container, "base64");
    const order = body as { job_id: string; expires_at: number };
    const jobId = order.job_id;
    return n % 2 === 1
      ? json(QUOTE(jobId, BigInt(order.expires_at)), 402)
      : json({ job_id: jobId, task_cid: "bafy", tx_hash: "0x1" });
  },
];

/** Every `GET /key` in a call log. */
const keyReads = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === "GET" && c.url.endsWith("/key"));

/** Every provider-registry read in a call log. */
const providerReads = (calls: Call[]): Call[] =>
  calls.filter((c) => c.url.includes("/evm/providers/"));

/** The envelope the client sealed, opened as the recipient it sealed to. */
const opened = (captured: Captured): Record<string, unknown> =>
  openEnvelope(captured.container!, captured.owner as string);

describe("Client without a verifier — unchanged", () => {
  it("refuses a confidential submission before ANY request goes out", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client([...baseRoutes(), jobsRoute(captured)]);

    await expect(
      c.submit({ model: "m", input: "hi", provider: 1, confidential: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Not "nothing was posted" — nothing was *read* either. The guard stands
    // ahead of the session handshake, so the call log is empty.
    expect(calls).toHaveLength(0);
  });

  it("refuses `confidential: 1` from plain JS the same way", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client([...baseRoutes(), jobsRoute(captured)]);

    await expect(
      // Truthy, not `=== true`: the shape a plain-JS caller writes.
      c.submit({ model: "m", input: "hi", provider: 1, confidential: 1 as unknown as boolean }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an open order with EscrowKeyUnverified and posts nothing", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client([...baseRoutes(), jobsRoute(captured)]);

    await expect(c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" })).rejects.toBeInstanceOf(
      EscrowKeyUnverified,
    );
    expect(posts(calls)).toHaveLength(0);
    expect(keyReads(calls)).toHaveLength(0);
  });

  it("still submits a designated non-confidential order end to end", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client([...baseRoutes(), jobsRoute(captured)]);

    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });

    expect(handle.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(funded(calls)).toHaveLength(1);
    expect(opened(captured).input).toEqual({ input: "hi" });
  });
});

describe("Client with a verifier — the confidential designated path", () => {
  it("verifies the record and seals to its box_key", async () => {
    const captured: Captured = {};
    const v = verifier({ entries: () => ACTIVE });
    // Calls through to the real implementation — the assertion is that this
    // path reaches the verifier at all, and the submission below only completes
    // if the real check passed.
    const spy = vi.spyOn(v, "verifyRecord");
    const { client: c, calls } = client(
      [
        [/\/evm\/providers\/\d+/, () => json(verifiableRecord())],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      { verifier: v },
    );

    const handle = await c.submit({
      model: "m",
      input: "hi",
      provider: 7,
      confidential: true,
    });

    expect(handle.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(providerReads(calls).map((r) => new URL(r.url).pathname)).toEqual([
      "/evm/providers/7",
    ]);
    // The seal target, pinned: this only opens for the record's own key.
    expect(opened(captured).input).toEqual({ input: "hi" });
    expect(captured.designated).toBe(7);
  });

  it("REFUSES rather than substituting when a pinned provider does not verify", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [
        // Honest shape and a key this client could perfectly well seal to —
        // evidence that binds a *different* key. `record()` unmodified verifies
        // fully, so the override is what makes this a refusal rather than a
        // submission.
        [
          /\/evm\/providers\/\d+/,
          () => json(verifiableRecord({ evidence: evidence({ reportData: "00".repeat(32) }) })),
        ],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      { verifier: verifier({ entries: () => ACTIVE }) },
    );

    await expect(
      c.submit({ model: "m", input: "hi", provider: 7, confidential: true }),
    ).rejects.toBeInstanceOf(VerificationError);
    // Both halves. "It raised" alone is satisfied by a client that raised
    // *after* posting the order to somebody else.
    expect(posts(calls)).toHaveLength(0);
  });

  it("does not verify at all when `confidential` is absent", async () => {
    const captured: Captured = {};
    const v = verifier({ entries: () => ACTIVE });
    const spy = vi
      .spyOn(v, "verifyRecord")
      .mockRejectedValue(new VerificationError("this must never be reached"));
    const { client: c } = client([...baseRoutes(), jobsRoute(captured)], { verifier: v });

    // The premise, asserted rather than assumed: this client **holds** the
    // verifier. Without it "the spy was never called" is true of a client that
    // never had one, and the test asserts nothing at all.
    expect(c.verifier).toBe(v);
    // Model names carry no confidentiality semantics; the flag is the only
    // trigger, so a client holding a verifier submits exactly as one without.
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).resolves.toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * `recipientFor`'s own no-verifier guard, reached through the door that makes
   * it non-redundant with `submit`'s.
   *
   * `sealLine` is public-with-`@internal` — `BatchClient` names it, so an
   * interface can — and it takes `confidential`. A caller reaching it directly
   * bypasses `submit` entirely, so the guard inside `recipientFor` is the only
   * one standing between `confidential: true` on a verifier-less client and
   * `this.verifier!.verifyRecord(...)` dereferencing `null`. Without this test,
   * deleting that line as an "already checked in `submit`" tidy-up passes the
   * whole suite and turns a fail-closed refusal into a bare `TypeError` — not a
   * `VorqError`, so nothing catching this SDK's classes would even see it.
   */
  it("refuses confidential at sealLine's own door, with no verifier", async () => {
    const { client: c, calls } = client([...baseRoutes()]);
    const ctx = await c.chainContext();
    const before = calls.length;

    const refusal = await c
      .sealLine({
        model: "m",
        payloadInput: { input: "hi" },
        window: "24h",
        url: "/v1/responses",
        provider: 7,
        confidential: true,
        ctx,
      })
      .catch((e: unknown) => e);

    // A `ValidationError`, which is a `VorqError` — never a `TypeError` out of
    // a `null` dereference.
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/no verifier to check it with/);
    // And it fires before the registry read, not after it.
    expect(providerReads(calls)).toHaveLength(0);
    expect(calls.length).toBe(before);
  });

  it("passes the RAW record to verifyRecord, not the reshaped ProviderRecord", async () => {
    const captured: Captured = {};
    const seen: unknown[] = [];
    const v = verifier({ entries: () => ACTIVE });
    vi.spyOn(v, "verifyRecord").mockImplementation(async (r: unknown) => {
      seen.push(r);
    });
    const { client: c } = client(
      [
        [/\/evm\/providers\/\d+/, () => json(verifiableRecord())],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      { verifier: v },
    );

    await c.submit({ model: "m", input: "hi", provider: 7, confidential: true });

    expect(seen).toHaveLength(1);
    // The wire spelling, which is what `verifyRecord` reads. `ProviderRecord`
    // carries `boxKey` and no `evidence` at all, so a reshaped argument would
    // refuse every honest record while looking like a verification failure.
    expect(seen[0]).toHaveProperty("box_key", RECIPIENT_PUBLIC);
    expect(seen[0]).toHaveProperty("operator", WALLET);
    expect(seen[0]).toHaveProperty("evidence");
    expect(seen[0]).not.toHaveProperty("boxKey");
  });
});

describe("Client with a verifier — the open path", () => {
  it("verifies GET /key and seals an open order to the announced key", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }) },
    );

    const handle = await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });

    expect(handle.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keyReads(calls)).toHaveLength(1);
    // `0`, the contract's own sentinel for "any provider" — never a null.
    expect(captured.designated).toBe(0);
    expect(opened(captured).input).toEqual({ input: "hi" });
  });

  it("passes the RAW announcement to verifyEscrowKey, not EscrowKeyAnnouncement (R8)", async () => {
    const captured: Captured = {};
    const seen: unknown[] = [];
    const v = verifier({ entries: () => ESCROW_ACTIVE });
    vi.spyOn(v, "verifyEscrowKey").mockImplementation(async (a: unknown) => {
      seen.push(a);
      return RECIPIENT_PUBLIC;
    });
    const { client: c } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: v },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });

    expect(seen).toHaveLength(1);
    // `escrowKey()` renames these two; `verifyEscrowKey` reads the wire
    // spelling, so the reshaped object refuses every honest node.
    expect(seen[0]).toHaveProperty("escrow_public_key", RECIPIENT_PUBLIC);
    expect(seen[0]).toHaveProperty("issued_at", NOW);
    expect(seen[0]).not.toHaveProperty("escrowPublicKey");
    expect(seen[0]).not.toHaveProperty("issuedAt");
  });

  it("turns a VerificationError into EscrowKeyUnverified and posts nothing", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [
        // Binds a key it does not announce.
        [/\/key$/, () => json(announcement({ key: RECIPIENT_PUBLIC, reportData: "00".repeat(32) }))],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }) },
    );

    const refusal = await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(EscrowKeyUnverified);
    expect((refusal as Error).message).toMatch(/did not verify/);
    expect((refusal as Error).cause).toBeInstanceOf(VerificationError);
    // The second statement, and the one that matters to somebody holding a
    // wallet: nothing was posted.
    expect(posts(calls)).toHaveLength(0);
  });

  it("does NOT fall back to a designated bid", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [
        [/\/key$/, () => json(announcement({ key: RECIPIENT_PUBLIC, reportData: "00".repeat(32) }))],
        // A perfectly good provider stands right here, and it must not be used.
        [/\/evm\/providers\/\d+/, () => json(verifiableRecord())],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      { verifier: verifier({ entries: () => [...ACTIVE, ...ESCROW_ACTIVE] }) },
    );

    const refusal = await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(EscrowKeyUnverified);
    // The refusal is the *verification* one, not "this client has no verifier":
    // without this the test is equally satisfied by a client that never looked
    // at the key at all, which is not the property under test.
    expect((refusal as Error).message).toMatch(/did not verify/);
    // Re-targeting is the caller's decision, so the registry is never even read.
    expect(providerReads(calls)).toHaveLength(0);
    expect(posts(calls)).toHaveLength(0);
  });

  it("caches the verified key and does not re-read GET /key per submission", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }) },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });
    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "again" });

    expect(funded(calls)).toHaveLength(2);
    expect(keyReads(calls)).toHaveLength(1);
  });

  /**
   * The two below **bracket** `KEY_CACHE_TTL_S` rather than merely showing that
   * some expiry happens, and the bracket is the point.
   *
   * A single "advance an hour, expect a re-read" test pins no value at all: it
   * passes for any TTL under an hour, so it would sit green over a constant that
   * silently diverged from the coordinator's, and would report a *correct*
   * restoration of the authority's 3 h as a failure. Together these two admit
   * only a TTL in `(10799, 10801]`.
   *
   * The number is not local. `escrow/windows.ts:36` holds the same 3 h as
   * `KEY_CACHE_TTL_MS`, and `escrow/keys.ts:238` passes it to `soundness()` as
   * the `grace` term of `grace + maxExpiry + maxSla < retention`; the node
   * refuses to boot if that breaks.
   */
  it("reuses the verified key just UNDER the 3-hour TTL", async () => {
    const captured: Captured = {};
    let clock = NOW;
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }), clock: () => clock },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });
    clock += 3 * 3600 - 1;
    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "again" });

    expect(funded(calls)).toHaveLength(2);
    expect(keyReads(calls)).toHaveLength(1);
  });

  it("re-reads GET /key once the 3-hour key cache expires", async () => {
    const captured: Captured = {};
    let clock = NOW;
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }), clock: () => clock },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });
    // Past the cache's own TTL. The verifier's wall clock is stopped at `NOW`,
    // so the announcement is still fresh — only the cache aged.
    clock += 3 * 3600 + 1;
    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "again" });

    expect(funded(calls)).toHaveLength(2);
    expect(keyReads(calls)).toHaveLength(2);
  });

  /**
   * The bracket above pins the TTL's magnitude and nothing about the comparison
   * that reads it: both `<` and `<=` pass at `∓1`, because neither probe lands
   * on the boundary itself. This one does. `_client.py:943` is `now <`, so the
   * instant the cache turns 3 h old is already outside it — an exclusive bound,
   * not an inclusive one.
   */
  it("treats the TTL boundary itself as expired, like the authority's `<`", async () => {
    const captured: Captured = {};
    let clock = NOW;
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      { verifier: verifier({ entries: () => ESCROW_ACTIVE }), clock: () => clock },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });
    // Exactly `now === escrowKeyExpiresAt`. Under `<=` this would be a cache hit.
    clock += 3 * 3600;
    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "again" });

    expect(funded(calls)).toHaveLength(2);
    expect(keyReads(calls)).toHaveLength(2);
  });

  it("expires the cache on the DEFAULT clock, which is the wall clock", async () => {
    const captured: Captured = {};
    // No `clock` option. `Date.now` is spied rather than faked with timers: the
    // default is `wallNow`, which reads `Date.now()` at call time, and a frozen
    // default would mean the escrow key cache never expires for every client
    // that does not inject one — which is every real client.
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    try {
      const { client: c, calls } = client(
        [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
        { verifier: verifier({ entries: () => ESCROW_ACTIVE }) },
      );

      await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });
      now.mockReturnValue((NOW + 4 * 3600) * 1000);
      await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "again" });

      expect(funded(calls)).toHaveLength(2);
      expect(keyReads(calls)).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  /**
   * A dead chain socket is not a key that failed attestation.
   *
   * `verifyEscrowKey` reads the allowlist to resolve a measured announcement's
   * image, and a transport failure there surfaces as `TransportError`. Widening
   * `escrowRecipient`'s catch to every error would relabel that as
   * `EscrowKeyUnverified: the coordinator's escrow key did not verify (GET
   * /evm/allowlist never became a response)` — telling a user their coordinator
   * failed attestation when what actually happened is their chain RPC is down.
   * Same narrowing `verifyCandidates` carries for the same reason.
   */
  it("lets a TransportError through rather than calling it a failed verification", async () => {
    const captured: Captured = {};
    const dead = (async () => {
      throw new TypeError("socket hang up");
    }) as unknown as typeof globalThis.fetch;
    const { client: c, calls } = client(
      [[/\/key$/, () => json(openable())], ...baseRoutes(), jobsRoute(captured)],
      {
        // The announcement is measured and honest; only the allowlist read dies.
        verifier: verifier({}, { fetch: dead }),
      },
    );

    const raised = await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" }).catch((e: unknown) => e);

    expect(raised).toBeInstanceOf(TransportError);
    expect(raised).not.toBeInstanceOf(EscrowKeyUnverified);
    expect((raised as Error).message).not.toMatch(/did not verify/);
    // Fail-closed either way: nothing was posted.
    expect(posts(calls)).toHaveLength(0);
  });

  /**
   * `confidential` is inert on an open order — parity with `_client.py:892-914`,
   * pinned so nobody "fixes" it in one SDK only.
   *
   * The flag verifies a *provider record*, and an open order has none. Under the
   * default `structural` mode a `static-coordinator-v1` announcement is accepted
   * with no measured image and no allowlist read at all, so this submission
   * completes having attested an operator-derived key — which is what
   * `SubmitArgs.confidential`'s doc now says, and what `verify.ts`'s forward
   * constraint on the static tag anticipates.
   */
  it("accepts `confidential` on an open order and does not verify a record for it", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [
        [/\/key$/, () => json(staticAnnouncement({ key: RECIPIENT_PUBLIC }))],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      {
        verifier: new Verifier("http://chain", {
          wallClock: () => NOW,
          // No chain read happens on this path at all — not even the allowlist.
          fetch: refusingFetch(),
        }),
      },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi", confidential: true });

    expect(captured.designated).toBe(0);
    expect(providerReads(calls)).toHaveLength(0);
    expect(opened(captured).input).toEqual({ input: "hi" });
  });

  it("accepts a static-coordinator announcement under the DEFAULT structural mode", async () => {
    const captured: Captured = {};
    const { client: c, calls } = client(
      [
        [/\/key$/, () => json(staticAnnouncement({ key: RECIPIENT_PUBLIC }))],
        ...baseRoutes(),
        jobsRoute(captured),
      ],
      {
        // No `mode`, and a `fetch` that fails the test if it is called: a static
        // coordinator claims no measured image, so there is no allowlist to
        // read. A user of a static fleet configures nothing.
        verifier: new Verifier("http://chain", {
          wallClock: () => NOW,
          fetch: refusingFetch(),
        }),
      },
    );

    await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" });

    expect(keyReads(calls)).toHaveLength(1);
    expect(captured.designated).toBe(0);
    expect(opened(captured).input).toEqual({ input: "hi" });
  });
});

describe("batch lines (R9)", () => {
  it("seals an open batch line to the verified escrow key", async () => {
    const { client: c, calls } = client([[/\/key$/, () => json(openable())], ...baseRoutes()], {
      verifier: verifier({ entries: () => ESCROW_ACTIVE }),
    });
    const ctx = await c.chainContext();

    // `sealLine` with no `provider` is exactly what a batch line with no
    // designation is — the surface `batches.ts` calls.
    const line = await c.sealLine({
      model: "m",
      payloadInput: { input: "hi" },
      window: "24h",
      url: "/v1/responses",
      ctx,
    });

    expect(line.terms.designated).toBe(0);
    expect(keyReads(calls)).toHaveLength(1);
    expect(
      openEnvelope(line.container, line.order.owner as string).input,
    ).toEqual({ input: "hi" });
  });

  it("does not mark a batch line confidential — the batch surface has no such flag", async () => {
    const v = verifier({ entries: () => ACTIVE });
    const spy = vi
      .spyOn(v, "verifyRecord")
      .mockRejectedValue(new VerificationError("this must never be reached"));
    const { client: c } = client(
      [[/\/evm\/providers\/\d+/, () => json(verifiableRecord())], ...baseRoutes()],
      { verifier: v },
    );
    const ctx = await c.chainContext();

    const line = await c.sealLine({
      model: "m",
      payloadInput: { input: "hi" },
      window: "24h",
      url: "/v1/responses",
      provider: 7,
      ctx,
    });

    expect(line.terms.designated).toBe(7);
    // The premise, for the reason spelled out above: a client that never held a
    // verifier satisfies "the spy was never called" for free.
    expect(c.verifier).toBe(v);
    // `confidential` defaults to `false` by omission, so the verifier is never
    // asked about a designated batch line.
    expect(spy).not.toHaveBeenCalled();
  });
});
