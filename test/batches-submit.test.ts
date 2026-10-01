import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { INLINE_MAX_BYTES } from "../src/crypto/domains.js";
import { EscrowKeyUnverified, ValidationError, VorqError } from "../src/errors.js";
import { isUsd } from "../src/money.js";
import { Verifier } from "../src/verify.js";
// Reuse the harness the submission suites already share — do not build a second one.
import {
  RECIPIENT_PUBLIC,
  batchHarness,
  clientWithFetch,
  json,
  manifestRows,
  openEnvelope,
  paymentSignerOf,
} from "./helpers/submit-harness.js";
import {
  ESCROW_ACTIVE,
  NOW,
  announcement,
  scriptedNode,
} from "./helpers/verify-harness.js";

/**
 * A line priced so the escrow cap is real arithmetic rather than the contract's
 * floor of 1.
 *
 * Rates are USD per 1M units: "1" and "2" are 1_000_000 and 2_000_000 atomic at
 * 6 decimals. They are *not* interchangeable:
 * `cap = ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE)`, and with
 * `unitsIn = 1` (the canonical input here is `{}`, two bytes) and `unitsOut =
 * 4096` (the default), the right way round is 8193 and the swapped way round is
 * 4098. A test at 2/3 would read the same either way, because everything
 * collapses to the floor.
 */
const PRICED = { model: "m", rate_in: "1", rate_out: "2" };

/** A hostile payee a node might name in its quote. A valid address. */
const HOSTILE_TO = "0xdeadbeef".padEnd(42, "0") as Address;

describe("Batches.submit — refusals before anything is sealed", () => {
  /**
   * Every refusal in this block asserts an **empty call log**, not merely that
   * no file or batch was created. That is the whole claim the ordering makes:
   * a typo on line 40 000 costs the read and nothing else. A test that only
   * checked `/v1/files` would still pass with the validation moved after the
   * sealing loop, which is a per-line encryption of the whole file.
   */
  it("refuses an empty request list", async () => {
    const h = batchHarness();
    await expect(h.client.batches.submit([], "1h", { providers: [1] })).rejects.toThrow(
      /contains no requests/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("plans unpriced lines and pins each to its allotted provider at its ask", async () => {
    const h = batchHarness({
      gasFee: 7n,
      allocation: [
        { provider_id: 7, box_key: RECIPIENT_PUBLIC, rate_in: "5", rate_out: "9", lines: 2 },
        { provider_id: 8, box_key: RECIPIENT_PUBLIC, rate_in: "6", rate_out: "9", lines: 1 },
      ],
    });
    // No verifier and no providers: unpriced lines are never open orders.
    await h.client.batches.submit(
      [{ body: { model: "m" } }, { body: { model: "m" } }, { body: { model: "m" } }],
      "24h",
      { providers: [] },
    );
    expect(h.plans).toHaveLength(1);
    expect(h.plans[0]!.completion_window).toBe("24h");
    expect((h.plans[0]!.models as { model_id: number; lines: number }[]).map((m) => [m.model_id, m.lines])).toEqual([[7, 3]]);
    // The totals are JSON integers, like every integer on the wire.
    for (const m of h.plans[0]!.models as { units_in: unknown; units_out: unknown }[]) {
      expect(Number.isInteger(m.units_in)).toBe(true);
      expect(Number.isInteger(m.units_out)).toBe(true);
    }
    const rows = manifestRows(h.uploads[0]!);
    expect(rows.map((r) => [r.designated, r.rate_in, r.rate_out])).toEqual([
      [7, "5", "9"],
      [7, "5", "9"],
      [8, "6", "9"],
    ]);
  });

  it("keeps each line's own terms when priced and unpriced lines interleave", async () => {
    const h = batchHarness({
      gasFee: 7n,
      allocation: [
        { provider_id: 7, box_key: RECIPIENT_PUBLIC, rate_in: "5", rate_out: "9", lines: 1 },
        { provider_id: 8, box_key: RECIPIENT_PUBLIC, rate_in: "6", rate_out: "9", lines: 1 },
      ],
    });
    await h.client.batches.submit(
      [{ body: { model: "m" } }, { body: PRICED }, { body: { model: "m" } }],
      "24h",
      { providers: [9] },
    );
    expect((h.plans[0]!.models as { lines: number }[]).map((m) => m.lines)).toEqual([2]);
    const rows = manifestRows(h.uploads[0]!);
    expect(rows.map((r) => [r.designated, r.rate_in])).toEqual([
      [7, "5"],
      [9, PRICED.rate_in],
      [8, "6"],
    ]);
  });

  it("refuses a batch the network cannot take, before anything is sealed", async () => {
    const h = batchHarness({
      allocation: [
        { provider_id: 7, box_key: RECIPIENT_PUBLIC, rate_in: "5", rate_out: "9", lines: 1 },
      ],
    });
    await expect(
      h.client.batches.submit([{ body: { model: "m" } }, { body: { model: "m" } }], "24h", {
        providers: [],
      }),
    ).rejects.toThrow(/can take 1 of the 2 unpriced m lines in the 24h window/);
    expect(h.termsOnlyPosts).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
  });

  it("asks for no plan when every line names its bid", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] });
    expect(h.plans).toHaveLength(0);
  });

  it("refuses an open batch on a client with NO verifier", async () => {
    const h = batchHarness();
    // `EscrowKeyUnverified`, not `VorqError`: every error class in this SDK
    // extends `VorqError`, so asserting that would be vacuous. This one says
    // the refusal is the fail-closed escrow-key policy and not, say, the
    // "batch contains no requests" check firing early.
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [] }),
    ).rejects.toThrow(EscrowKeyUnverified);
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [] }),
    ).rejects.toThrow(/no verifier to check that key with/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a duplicate custom_id, naming the line", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit(
        [
          { custom_id: "a", body: PRICED },
          { custom_id: "a", body: PRICED },
        ],
        "1h",
        { providers: [1] },
      ),
    ).rejects.toThrow(/line 2: duplicate custom_id "a"/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a custom_id that is not a 1-64 character string, naming the line", async () => {
    const h = batchHarness();
    for (const bad of ["", "x".repeat(65), 7, {}]) {
      await expect(
        h.client.batches.submit([{ body: PRICED }, { custom_id: bad, body: PRICED }], "1h", {
          providers: [1],
        }),
      ).rejects.toThrow(/line 2: custom_id must be a 1-64 character string/);
    }
    // 64 is the boundary and it is allowed, so the refusal above is the length
    // rule and not "any custom_id longer than a word".
    const priced = batchHarness({ gasFee: 7n });
    const ok = await priced.client.batches.submit(
      [{ custom_id: "x".repeat(64), body: PRICED }],
      "1h",
      { providers: [1] },
    );
    expect(ok.jobIds).toHaveLength(1);
  });

  it("refuses a line with no body.model, naming the line", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit([{ body: PRICED }, { body: {} }], "1h", { providers: [1] }),
    ).rejects.toThrow(/line 2: body.model is required/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a file that names two endpoints", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit(
        [
          { url: "/v1/responses", body: PRICED },
          { url: "/v1/embeddings", body: PRICED },
        ],
        "1h",
        { providers: [1] },
      ),
    ).rejects.toThrow(/metered differently and settle differently/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a line naming an endpoint no batch serves", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit([{ url: "/v1/chat/completions", body: PRICED }], "1h", {
        providers: [1],
      }),
    ).rejects.toThrow(/line 1: url must be one of \/v1\/responses, \/v1\/embeddings/);
    expect(h.calls).toHaveLength(0);
  });

  /**
   * `POST /v1/batches` takes `1h` and `24h` and nothing else
   * (`routes/batches.ts:45`). The SDK is what turned a tier name into a window,
   * so a window it cannot send has to be refused here — sending it would come
   * back as `invalid_completion_window` naming a value the caller never typed.
   */
  it("refuses a completion window POST /v1/batches does not accept", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit([{ body: PRICED }], "7d", { providers: [1] }),
    ).rejects.toThrow(/must be one of 1h, 24h/);
    // Both spellings are in the sentence: what was asked, and what it resolved to.
    await expect(
      h.client.batches.submit([{ body: PRICED }], "7d", { providers: [1] }),
    ).rejects.toThrow(ValidationError);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts both windows the coordinator accepts, and the tiers that name them", async () => {
    for (const [asked, sent] of [
      ["1h", "1h"],
      ["24h", "24h"],
      ["async", "1h"],
      ["batch", "24h"],
    ]) {
      const h = batchHarness({ gasFee: 7n });
      await h.client.batches.submit([{ body: PRICED }], asked, { providers: [1] });
      // The **normalized** window goes on the wire: a tier name would be a 400.
      expect(h.creates[0]!.completion_window).toBe(sent);
    }
  });

  it("refuses a client with no signer and no cipher", async () => {
    let calls = 0;
    const client = clientWithFetch(() => {
      calls += 1;
      return json({});
    });
    await expect(
      client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
    ).rejects.toThrow(/batch submissions are always sealed/);
    expect(calls).toBe(0);
  });

  /**
   * `loadRequests` promises that a line it cannot use is **named**. Reaching for
   * `.custom_id` on a JSONL `null` breaks that promise with a bare `TypeError`
   * carrying no line number — so the class is asserted as well as the text: a
   * `TypeError` would satisfy a message regex written loosely enough, and it is
   * exactly the wrong answer.
   */
  it("names a line that is not a JSON object, from either input form", async () => {
    const h = batchHarness();
    for (const [input, pattern] of [
      ['{"body":{"model":"m","rate_in":"1","rate_out":"1"}}\nnull\n', /line 2: a batch line must be a JSON object with a body, got null/],
      ["[]\n", /line 1: a batch line must be a JSON object with a body, got \[\]/],
      ['7\n', /line 1: a batch line must be a JSON object with a body, got 7/],
    ] as const) {
      await expect(h.client.batches.submit(input, "1h", { providers: [1] })).rejects.toThrow(
        ValidationError,
      );
      await expect(h.client.batches.submit(input, "1h", { providers: [1] })).rejects.toThrow(
        pattern,
      );
    }
    // The caller's own array has the same hole and the same answer.
    const lines = [{ body: PRICED }, null as unknown as Record<string, unknown>];
    await expect(h.client.batches.submit(lines, "1h", { providers: [1] })).rejects.toThrow(
      ValidationError,
    );
    await expect(h.client.batches.submit(lines, "1h", { providers: [1] })).rejects.toThrow(
      /line 2: a batch line must be a JSON object with a body/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("names the line a JSONL string cannot be parsed at", async () => {
    const h = batchHarness();
    await expect(
      h.client.batches.submit('{"body":{"model":"m"}}\n{"body":\n', "1h", { providers: [1] }),
    ).rejects.toThrow(/line 2: the batch file is JSONL and this line is not valid JSON/);
    expect(h.calls).toHaveLength(0);
  });
});

describe("Batches.submit — the happy path", () => {
  it("seals every line, prices the batch with ONE gas read, and uploads once", async () => {
    const h = batchHarness({ gasFee: 7n });
    const handle = await h.client.batches.submit(
      [{ custom_id: "one", body: PRICED }, { body: PRICED }],
      "1h",
      { providers: [1, 2] },
    );

    // Exactly one terms-only challenge for the whole batch, and one upload.
    expect(h.termsOnlyPosts).toHaveLength(1);
    expect(h.uploads).toHaveLength(1);

    const content = h.uploads[0]!;
    // JSONL: one row per line, newline-terminated, no blank rows.
    expect(content.endsWith("\n")).toBe(true);
    const rows = manifestRows(content);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.url).toBe("/v1/responses");
      expect(typeof row.container).toBe("string");
      expect(isUsd(row.amount)).toBe(true);
    }

    // Round-robin across the providers given.
    expect((rows[0]!.designated as number)).toBe(1);
    expect((rows[1]!.designated as number)).toBe(2);

    // Two lines, two containers, two job ids: each line is sealed under its own
    // fresh seed, so nothing here is one sealed line written down twice.
    expect(rows[0]!.container).not.toBe(rows[1]!.container);
    expect(handle.id).toBe("batch_test");
    expect(handle.jobIds).toHaveLength(2);
    expect(handle.jobIds![0]).not.toBe(handle.jobIds![1]);
    // The handle's ids are the manifest's, in input order.
    expect(handle.jobIds).toEqual(rows.map((r) => (r.job_id as string)));

    // The create call names the file it just uploaded and the endpoint the file
    // agreed on.
    expect(h.creates).toEqual([
      { input_file_id: "file_test", endpoint: "/v1/responses", completion_window: "1h" },
    ]);
  });

  it("spreads lines round-robin, wrapping past the end of the provider list", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ body: PRICED }, { body: PRICED }, { body: PRICED }], "1h", {
      providers: [1, 2],
    });
    expect(
      manifestRows(h.uploads[0]!).map((r) => (r.designated as number)),
    ).toEqual([1, 2, 1]);
  });

  /**
   * R9: an empty `providers` list is a batch of open orders, sealed to the
   * coordinator's **verified** escrow key — the behaviour `_batches.py:98-105`
   * describes ("Given nothing, every line is an open order: sealed to the
   * coordinator's verified escrow key … That path requires a client built with
   * `verifier=`, exactly as a single open `submit` does").
   *
   * The refusal without a verifier is asserted in the refusals block above.
   * These two are the same door from the other side.
   */
  it("rests an OPEN batch on a client with a verifier, sealed to the escrow key", async () => {
    const h = batchHarness({
      gasFee: 7n,
      // Announced as `RECIPIENT_PUBLIC` so the test can open what it sealed. A
      // key the suite holds no secret for would leave the seal target unpinned.
      escrowAnnouncement: () => announcement({ key: RECIPIENT_PUBLIC }),
      clientOptions: {
        verifier: new Verifier("http://chain", {
          mode: "mock",
          wallClock: () => NOW,
          fetch: scriptedNode({ entries: () => ESCROW_ACTIVE }).fetch,
        }),
      },
    });

    const handle = await h.client.batches.submit([{ body: PRICED }, { body: PRICED }], "1h", {
      providers: [],
    });

    const rows = manifestRows(h.uploads[0]!);
    expect(rows).toHaveLength(2);
    // `0` on every line — the contract's own sentinel for "any provider".
    expect(rows.map((r) => (r.designated as number))).toEqual([0, 0]);
    // Read **once** for the whole batch: the verified key is cached on the
    // client, so a 40 000-line file does not re-read `/key` per line.
    expect(h.calls.filter((c) => c.url.endsWith("/key"))).toHaveLength(1);
    // The seal target, pinned. This only opens for the announced key.
    for (const row of rows) {
      expect(
        openEnvelope(Uint8Array.from(Buffer.from(row.container as string, "base64")), row.owner as string)
          .input,
      ).toEqual({});
    }
    expect(handle.jobIds).toHaveLength(2);
  });

  /**
   * The one gas read prices **every** line, and the price is local arithmetic
   * over the terms each line signed plus that fee.
   *
   *   unitsIn  = max(1, floor(len(canonical({})) / 4)) = max(1, floor(2/4)) = 1
   *   unitsOut = 4096 (nothing in this input names a size)
   *   cap      = ceilDiv(1_000_000*1 + 2_000_000*4096, 1_000_000) = 8193
   *   fee      = floor(8193 * 100 / 10000) = 81 (the harness quotes 1%)
   *   amount   = cap + fee + gasFee = 8193 + 81 + 7 = 8281 atomic = "0.008281"
   *
   * Written out rather than computed with `capFor`, which would agree with any
   * answer the code gave. A gas fee dropped on the floor reads 8274; the rates
   * swapped read 4145.
   */
  it("prices every line from its own terms plus the one gas fee", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ body: PRICED }, { body: PRICED }], "1h", { providers: [1] });
    const rows = manifestRows(h.uploads[0]!);
    expect(rows.map((r) => r.amount)).toEqual(["0.008281", "0.008281"]);
  });

  // cap 8193 (derivation above) ; fee = floor(8193 * 250 / 10000) = 204 ; amount = 8193 + 204 + 7 = "0.008404"
  it("adds the protocol fee on top of every line's cap", async () => {
    const h = batchHarness({ gasFee: 7n, feeBps: 250 });
    await h.client.batches.submit([{ body: PRICED }, { body: PRICED }], "1h", { providers: [1] });
    const rows = manifestRows(h.uploads[0]!);
    expect(rows.map((r) => r.amount)).toEqual(["0.008404", "0.008404"]);
  });

  it("refuses a 402 whose quote carries no fee_bps", async () => {
    const h = batchHarness({ gasFee: 7n, feeBps: null });
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
    ).rejects.toThrow(/carries no fee_bps/);
    expect(h.uploads).toHaveLength(0);
  });

  it("seals BEFORE it reads the gas fee", async () => {
    // The ordering that keeps the file sealed once. A client that read the fee
    // first and re-sealed after would mint a fresh seed, a fresh `c` and a
    // fresh job id for every line it had already paid to encrypt.
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ body: PRICED }, { body: PRICED }], "1h", { providers: [1] });

    const rows = manifestRows(h.uploads[0]!);
    // The challenge carried the **first line's own signed order**, member for
    // member — which it could only carry if that line was already sealed. An
    // invented or empty terms body fails this outright, and a re-sealed one
    // fails it too: the second sealing mints a different `c` and a different
    // job id, so the row that shipped would no longer match the row that was
    // quoted.
    expect(rows[0]).toMatchObject(h.termsOnlyPosts[0]!);
    expect(h.termsOnlyPosts[0]!.c).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.termsOnlyPosts[0]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    // And it is the *first* line's, not the second's.
    expect(h.termsOnlyPosts[0]!.job_id).not.toBe(
      (rows[1]!.job_id as string),
    );
  });

  it("signs each payment against ctx, never against anything the node said", async () => {
    const h = batchHarness({ gasFee: 7n, quoteTo: HOSTILE_TO });
    await h.client.batches.submit([{ body: PRICED }, { body: PRICED }], "1h", { providers: [1] });
    // Cached from the submit — this costs no extra request.
    const ctx = await h.client.chainContext();
    expect(HOSTILE_TO.toLowerCase()).not.toBe(ctx.jobRegistry.toLowerCase());

    // **The load-bearing assertion is the first of the two, and only the
    // first.** `batches.ts` never reads the quote's `authorization` block at all
    // — it takes `gas_fee` and `fee_bps` and nothing else — so no mutation of
    // the source can make a signature carry the hostile payee, and the second
    // recovery is a *control*, not a pin. The fixture stays because it documents
    // the threat the design refuses, but do not "simplify" the
    // recovery-to-`owner` assertion believing the decoy covers it: the decoy
    // cannot fail, and recovery under `ctx.jobRegistry` is what dies when
    // `payLine` signs anything else.
    //
    // Recovery is also the only assertion that can tell what an authorization
    // actually authorized: `ecrecover` never fails, it returns a different
    // address, so a signature over the node's payee would be perfectly valid and
    // belong to a stranger — and the wrongness would surface as an unclaimable
    // job rather than as an error.
    for (const row of manifestRows(h.uploads[0]!)) {
      const owner = (row.owner as string).toLowerCase();
      expect((await paymentSignerOf(row, ctx, ctx.jobRegistry)).toLowerCase()).toBe(owner);
      expect((await paymentSignerOf(row, ctx, HOSTILE_TO)).toLowerCase()).not.toBe(owner);
    }
  });

  it("refuses a non-402 answer to the terms-only body, having uploaded nothing", async () => {
    const h = batchHarness({ gasStatus: 200 });
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
    ).rejects.toThrow(/only a 402 quote is a valid answer/);
    // Sealed, but never filed: the refusal costs no upload and creates no batch.
    expect(h.uploads).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });

  it("refuses a 402 whose quote carries no gas_fee", async () => {
    const h = batchHarness({ gasFee: null });
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
    ).rejects.toThrow(/carries no gas_fee/);
    expect(h.uploads).toHaveLength(0);
  });

  it("refuses a gas_fee that is not a USD decimal string", async () => {
    // Money on the wire is a USD decimal string, refused rather than rounded:
    // each of these would otherwise reach the payment arithmetic out of the
    // middle of a submit that has already sealed every one of its lines. Seven
    // fraction digits is one more than the token carries.
    for (const junk of ["0x7", "", "seven", "1e3", "-1", "0.0000001", 7, 7.5]) {
      const h = batchHarness({ gasFeeRaw: junk });
      await expect(
        h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
      ).rejects.toThrow(VorqError);
      await expect(
        h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
      ).rejects.toThrow(/carries no gas_fee/);
      // Refused before the manifest is uploaded, like every other quote refusal.
      expect(h.uploads).toHaveLength(0);
    }
    // The control: the same branch accepts a USD string at the token's full
    // precision, so the refusals above are the guard doing its job rather than
    // the branch rejecting everything.
    const ok = batchHarness({ gasFeeRaw: "0.000007" });
    await ok.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] });
    expect(ok.creates).toHaveLength(1);
    // And it was read at ctx.decimals: 8193 + 81 + 7 atomic.
    expect(manifestRows(ok.uploads[0]!)[0]!.amount).toBe("0.008281");
  });

  it("never repeats POST /v1/batches, even when the node marks the failure retryable", async () => {
    // `retry: false` on the create, pinned the way `uploadFile`'s is: a `503`
    // carrying `x-vorq-retryable: true` is exactly what the transport would send
    // again, and a create that may have landed must never be sent twice — a
    // second one is a second batch, charged and posted, that nobody asked for.
    // The default `maxRetries` is 3, so a flipped flag makes this four calls.
    const h = batchHarness({ gasFee: 7n, createStatus: 503 });
    await expect(
      h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] }),
    ).rejects.toThrow(VorqError);
    expect(h.creates).toHaveLength(1);
  });
});

/**
 * A catalog that publishes a real schema, which the stock `MODELS` fixture does
 * not — and without one `checkInput` has nothing to check, which is why
 * `validateParams` looked untestable at first and is not.
 *
 * `banned: false` is a JSON Schema `false` subschema: the network forbidding a
 * parameter outright. `checkInput` **throws** on it (`params.ts:166`), and that
 * throw is outside the `try` that swallows a failed *lookup* — so this flag
 * decides whether a submit is refused at all.
 */
const BANNING_CATALOG = {
  data: [
    {
      id: "m",
      object: "model",
      vorq: { model_id: 7, params_schema: { properties: { banned: false } } },
    },
  ],
};

describe("Batches.submit — validateParams", () => {
  it("refuses a forbidden parameter by default, before anything is sealed", async () => {
    const h = batchHarness({ gasFee: 7n, models: BANNING_CATALOG });
    await expect(
      h.client.batches.submit([{ body: { ...PRICED, banned: 1 } }], "1h", { providers: [1] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.client.batches.submit([{ body: { ...PRICED, banned: 1 } }], "1h", { providers: [1] }),
    ).rejects.toThrow(/parameter 'banned' is not supported on VORQ/);
    // Discovery happened; sealing and everything after it did not.
    expect(h.termsOnlyPosts).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });

  /**
   * The other direction, and the half that makes the branch die under mutation:
   * with the guard forced on (`if (true)`) this submit would be refused, and
   * with it forced off the test above would resolve. Both are needed.
   */
  it("submits that same line when validateParams is false", async () => {
    const h = batchHarness({ gasFee: 7n, models: BANNING_CATALOG });
    const handle = await h.client.batches.submit([{ body: { ...PRICED, banned: 1 } }], "1h", {
      providers: [1],
      validateParams: false,
    });
    expect(handle.jobIds).toHaveLength(1);
    expect(h.uploads).toHaveLength(1);

    // And the flag **skipped the check** rather than stripping the key: the
    // forbidden param is in the sealed input, on its way to the provider. A
    // client that silently dropped it would pass a "submitted successfully"
    // assertion and be signing an order for a different task than the caller
    // asked for.
    const row = manifestRows(h.uploads[0]!)[0]!;
    const envelope = openEnvelope(
      Uint8Array.from(Buffer.from(row.container as string, "base64")),
      (row.owner as string),
    );
    expect(envelope.input).toEqual({ banned: 1 });
  });

  it("still refuses a line the schema contradicts, not only a forbidden key", async () => {
    // A second refusal shape out of `checkInput`, so the test above is not
    // pinning one branch of one keyword.
    const h = batchHarness({
      gasFee: 7n,
      models: {
        data: [
          {
            id: "m",
            object: "model",
            vorq: {
              model_id: 7,
              params_schema: { properties: { temperature: { type: "number", maximum: 2 } } },
            },
          },
        ],
      },
    });
    await expect(
      h.client.batches.submit([{ body: { ...PRICED, temperature: 99 } }], "1h", {
        providers: [1],
      }),
    ).rejects.toThrow(/parameter 'temperature' is invalid/);
    expect(h.uploads).toHaveLength(0);
  });
});

describe("Batches.submit — what the manifest carries", () => {
  /**
   * `custom_id` travels **sealed inside its line's container** and is never on
   * the wire in the clear. The value is hyphenated on purpose: the standard
   * base64 alphabet has no hyphen, so it cannot appear by accident inside a
   * container and the substring search below cannot pass for the wrong reason.
   */
  it("seals custom_id into the container and puts it nowhere on the wire", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ custom_id: "secret-tag-4f2a", body: PRICED }], "1h", {
      providers: [1],
    });
    const content = h.uploads[0]!;
    expect(content).not.toContain("secret-tag-4f2a");
    expect(JSON.stringify(h.creates)).not.toContain("secret-tag-4f2a");

    // And it really is in there: opened as the recipient, the envelope carries
    // it. Without this half, deleting the tag entirely would pass.
    const row = manifestRows(content)[0]!;
    const container = Uint8Array.from(Buffer.from(row.container as string, "base64"));
    const envelope = openEnvelope(container, (row.owner as string));
    expect(envelope.custom_id).toBe("secret-tag-4f2a");
    expect(envelope.result_key).toBeTypeOf("string");
    // The routing keys are the order's, not the model's: they must not reach
    // the provider as input it would try to serve.
    expect(envelope.input).toEqual({});
  });

  it("writes a line past INLINE_MAX_BYTES inline, base64, with no cap", async () => {
    // No container size cap remains, in a single job or in a batch line: a
    // line is always sealed and written into the manifest inline.
    const h = batchHarness({ gasFee: 7n });
    const big = { ...PRICED, input: "x".repeat(INLINE_MAX_BYTES + 1024) };
    await h.client.batches.submit([{ body: big }], "1h", { providers: [1] });
    expect(h.creates).toHaveLength(1);
    const row = manifestRows(h.uploads[0]!)[0]!;
    expect(typeof row.container).toBe("string");
    expect(row.container_cid).toBeUndefined();
    expect(Buffer.from(row.container as string, "base64").length).toBeGreaterThan(INLINE_MAX_BYTES);
  });

  it("leaves the model-owned input in the envelope and the routing keys out of it", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit(
      [{ body: { ...PRICED, input: "hello", temperature: 0.5, units_out: 12 } }],
      "1h",
      { providers: [1] },
    );
    const row = manifestRows(h.uploads[0]!)[0]!;
    const container = Uint8Array.from(Buffer.from(row.container as string, "base64"));
    const envelope = openEnvelope(container, (row.owner as string));
    expect(envelope.input).toEqual({ input: "hello", temperature: 0.5 });
    // `units_out` is a routing key and it reached the order rather than the input.
    expect((row.units_out as number)).toBe(12);
  });

  /**
   * `declareUnits` refuses a `units_out` that is not an integer **by type** —
   * "an order is not the place to guess". A `Number(...)` on the way in would
   * defeat that silently: `true` is a perfectly good `1` and `"5"` a perfectly
   * good `5`, and this SDK would then sign an order the Python one rejects.
   */
  it("refuses a units_out that is not an integer rather than coercing it", async () => {
    for (const bad of [true, "5", 1.5, -1]) {
      const h = batchHarness({ gasFee: 7n });
      await expect(
        h.client.batches.submit([{ body: { ...PRICED, units_out: bad } }], "1h", {
          providers: [1],
        }),
      ).rejects.toThrow(/units_out must be a non-negative integer/);
    }
    // `null` is absence, not zero: `Number(null)` is `0`, which would escrow no
    // output leg at all. It falls through to the 4096 default.
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit([{ body: { ...PRICED, units_out: null } }], "1h", {
      providers: [1],
    });
    const row = manifestRows(h.uploads[0]!)[0]!;
    expect((row.units_out as number)).toBe(4096);
    // Zero survives as zero — an embedding has no output side to buy.
    const z = batchHarness({ gasFee: 7n });
    await z.client.batches.submit([{ body: { ...PRICED, units_out: 0 } }], "1h", {
      providers: [1],
    });
    expect(
      (manifestRows(z.uploads[0]!)[0]!.units_out as number),
    ).toBe(0);
  });

  it("carries the embeddings endpoint onto every row and onto the create call", async () => {
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit(
      [
        { url: "/v1/embeddings", body: PRICED },
        { url: "/v1/embeddings", body: PRICED },
      ],
      "24h",
      { providers: [1] },
    );
    expect(manifestRows(h.uploads[0]!).map((r) => r.url)).toEqual([
      "/v1/embeddings",
      "/v1/embeddings",
    ]);
    expect(h.creates[0]!.endpoint).toBe("/v1/embeddings");
  });

  it("sends metadata when given and omits the key entirely when not", async () => {
    const withMeta = batchHarness({ gasFee: 7n });
    await withMeta.client.batches.submit([{ body: PRICED }], "1h", {
      providers: [1],
      metadata: { run: "nightly" },
    });
    expect(withMeta.creates[0]!.metadata).toEqual({ run: "nightly" });

    const without = batchHarness({ gasFee: 7n });
    await without.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] });
    expect("metadata" in without.creates[0]!).toBe(false);

    // An **empty** map is the same request as an absent one, which is what the
    // authority's `if metadata:` says. Sending `{}` would be a gratuitous
    // divergence for the coordinator to parse back into the `{}` it defaults to.
    const empty = batchHarness({ gasFee: 7n });
    await empty.client.batches.submit([{ body: PRICED }], "1h", {
      providers: [1],
      metadata: {},
    });
    expect("metadata" in empty.creates[0]!).toBe(false);
  });
});

describe("Batches.submit — JSONL input", () => {
  it("parses a JSONL string, ignoring blank lines and a trailing newline", async () => {
    const h = batchHarness({ gasFee: 7n });
    const jsonl =
      `${JSON.stringify({ body: PRICED })}\n` + "\n" + `${JSON.stringify({ body: PRICED })}\n`;
    const handle = await h.client.batches.submit(jsonl, "1h", { providers: [1] });
    expect(handle.jobIds).toHaveLength(2);
    expect(manifestRows(h.uploads[0]!)).toHaveLength(2);
  });

  /**
   * The caller's array is the caller's. Python copies each body before popping
   * the routing keys off it; the equivalent mistake here is a `delete` over
   * `line.body`, which would hand back lines missing their model — and would
   * only surface the second time a caller submitted the same array.
   */
  it("does not mutate the lines it was handed", async () => {
    const lines = [
      { custom_id: "one", body: { ...PRICED, input: "hello", units_out: 12 } },
      { body: { ...PRICED, input: "world" } },
    ];
    const before = structuredClone(lines);
    const h = batchHarness({ gasFee: 7n });
    await h.client.batches.submit(lines, "1h", { providers: [1] });
    expect(lines).toEqual(before);
  });
});

describe("Batches.get", () => {
  it("re-attaches to a batch id with no network call", async () => {
    const h = batchHarness();
    expect(h.client.batches.get("batch_abc").id).toBe("batch_abc");
    expect(h.calls).toHaveLength(0);
  });
});

describe("client.batches", () => {
  /**
   * `client.ts` imports `Batches` as a value and `batches.ts` imports back with
   * `import type`, which is erased. A plain import there is a real runtime
   * cycle, and under `NodeNext` it surfaces as an undefined class at
   * construction — so constructing a client and reaching the namespace is the
   * test for it.
   */
  it("is wired on the client and sealed to the provider the harness publishes", async () => {
    const h = batchHarness({ gasFee: 7n });
    expect(h.client.batches).toBeDefined();
    await h.client.batches.submit([{ body: PRICED }], "1h", { providers: [1] });
    const row = manifestRows(h.uploads[0]!)[0]!;
    // The seed is sealed to the provider's published box key: `openEnvelope`
    // opens it with the matching secret, which no other key would.
    expect(
      openEnvelope(
        Uint8Array.from(Buffer.from(row.container as string, "base64")),
        (row.owner as string),
      ).owner,
    ).toBe((row.owner as string));
  });
});
