import { describe, expect, it } from "vitest";
import { resultFromRaw, resultFromBatchLine, openResultBytes, formatCost, TextResult, MediaResult, EmbeddingResult, JobError } from "../src/results.js";
import { ResultIntegrityError, VorqError } from "../src/errors.js";

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/**
 * Every cost path is `Σ units × rate`, divided exactly by 1e6: a rate is USD per
 * 1M units of work, so the cost is USD, rendered as its shortest exact decimal.
 */
describe("cost", () => {
  const job = (rateIn: unknown, rateOut: unknown, extra = {}) => ({
    id: "j", vorq: { rate_in: rateIn, rate_out: rateOut, provider_id: 42, gas_fee: "0.03", fee: "0", ...extra },
  });

  it.each([
    // [input_tokens, output_tokens, rate_in, rate_out, expected]
    [1000, 500, "50", "150", "0.125"],
    [0, 0, "0", "0", "0"],
    [1, 0, "1", "0", "0.000001"],
    [18, 8, "220000", "750000", "9.96"],
    [2_000_000, 0, "50", "0", "100"],
    [20_000_000, 0, "50", "0", "1000"],
    [1000, 500, "0.05", "0.15", "0.000125"],
    [2_000_000, 1_000_000, "0.05", "0.4", "0.5"],
    [1, 0, "0.000001", "0", "0.000000000001"],
    [1_000_000, 1_000_000, "2.50", "10", "12.5"],
  ])("text: (%i*%i + %i*%i)/1e6 = %s", (inTok, outTok, rIn, rOut, expected) => {
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: inTok, output_tokens: outTok },
    });
    const r = resultFromRaw(raw, { ...job(rIn, rOut), result_cid: "c" }, null);
    expect(r.cost).toBe(expected);
  });

  it("surfaces the signed rates as USD strings, and an absent one as null", () => {
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(resultFromRaw(raw, { ...job("0.05", "0.15"), result_cid: "c" }, null).rates)
      .toEqual({ rateIn: "0.05", rateOut: "0.15" });
    expect(resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { gas_fee: "0.03", fee: "0" } }, null).rates)
      .toEqual({ rateIn: null, rateOut: null });
  });

  it.each([0.05, 50, "-1", "1e3", "0x10", "01", ".5", " 1"])("refuses a rate that is not a USD string: %s", (rate) => {
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(() => resultFromRaw(raw, { ...job(rate, "0"), result_cid: "c" }, null))
      .toThrow(VorqError);
  });

  it.each([
    [2_000_000, "50", "100"],
    [2_000_000, "0.02", "0.04"],
  ])("embeddings: %i prompt tokens at rate_in %s = %s", (promptTok, rIn, expected) => {
    const raw = bytes({
      object: "list", data: [{ embedding: "AAAA" }], usage: { prompt_tokens: promptTok }, model: "m",
    });
    const r = resultFromRaw(raw, { ...job(rIn, "9990000"), result_cid: "c" }, null);
    expect(r.cost).toBe(expected);
  });

  it("truncates a non-integer token count rather than throwing a bare RangeError", () => {
    // `BigInt(1.5)` is a RangeError, which is not a VorqError and would walk
    // through the one `catch` this module promises over the read path — on a
    // sealed body, which is exactly the untrusted input it defends against.
    // A count is a count, so it truncates: 1.5 bills as 1.
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1.5, output_tokens: 0 },
    });
    const r = resultFromRaw(raw, { ...job("50000", "0"), result_cid: "c" }, null);
    expect(r.cost).toBe("0.05");
  });

  it("survives a token count that is not a finite number", () => {
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: "many", output_tokens: null },
    });
    const r = resultFromRaw(raw, { ...job("50000", "150000"), result_cid: "c" }, null);
    expect(r.cost).toBe("0");
  });

  it("media unscales by RATE_SCALE like every other modality (R1)", () => {
    // JobRegistry._atomicCharge has one code path and no media exception.
    // 1024x768 px at rate_out "2" USD per 1M px.
    const raw = bytes({ images: [{ b64: "", content_type: "image/png", width: 1024, height: 768 }] });
    const r = resultFromRaw(raw, { ...job(null, "2"), result_cid: "c" }, null);
    expect(r).toBeInstanceOf(MediaResult);
    expect(r.cost).toBe("1.572864");
  });

  it("costs a result on the settled units it states", () => {
    // Frames are labelled with what was delivered and `units_out` caps what is
    // charged. When a render comes back larger than its cap the two differ, and
    // the charge is the smaller — which only the provider's stamp says.
    const raw = bytes({
      images: [{ b64: "", content_type: "image/png", width: 1024, height: 768 }],
      units: 500000,
    });
    const r = resultFromRaw(raw, { ...job(null, "2"), result_cid: "c" }, null);
    expect(r.cost).toBe("1");
  });

  it("video bills pixel-seconds", () => {
    const raw = bytes({ video: { b64: "", content_type: "video/mp4", width: 1024, height: 1024, duration_secs: 5 }, seed: 7 });
    const r = resultFromRaw(raw, { ...job(null, "20"), result_cid: "c" }, null);
    expect(r.cost).toBe("104.8576");
  });

  it("embeddings bill the input side only", () => {
    // An input-only ask may still publish a nonzero rate_out — it is inert,
    // multiplied by zero units — and reading it would display a charge nobody
    // was ever billed.
    const raw = bytes({ object: "list", data: [{ embedding: "AAAA" }], usage: { prompt_tokens: 10 }, model: "m" });
    const r = resultFromRaw(raw, { ...job("20000", "9990000"), result_cid: "c" }, null);
    expect(r).toBeInstanceOf(EmbeddingResult);
    expect(r.cost).toBe("0.2");
  });
});

/**
 * The exported formatter, probed directly.
 */
describe("formatCost", () => {
  it.each([
    // [mantissa, scale, expected]
    [0n, 6, "0"],
    [0n, -5, "0"],
    [1000000n, 6, "1"],
    [1n, 6, "0.000001"],
    [5000n, 2, "50"],
    [50n, 0, "50"],
    [-125000n, 6, "-0.125"],
    [5n, -3, "5000"],
    [-1n, -2, "-100"],
    [10000000n, 8, "0.1"],
    [125000n, 6, "0.125"],
  ])("formatCost(%s, %i) = %s", (mantissa, scale, expected) => {
    expect(formatCost(mantissa, scale)).toBe(expected);
  });
});

describe("openResultBytes", () => {
  it("names the CID when the bytes are not JSON", () => {
    expect(() => openResultBytes(new TextEncoder().encode("not json"), "bafyx", null))
      .toThrow(/bafyx/);
  });

  it("refuses bytes that decode to something other than a result object", () => {
    expect(() => openResultBytes(bytes([1, 2, 3]), "bafyx", null))
      .toThrow(ResultIntegrityError);
  });

  it("refuses a sealed result with no cipher to open it", () => {
    expect(() => openResultBytes(bytes({ enc: "vorq-sealed-v1", ciphertext: "AAAA" }), "c", null))
      .toThrow(/no cipher/);
  });

  it("wraps a cipher failure rather than letting it escape", () => {
    // A caller holding one `catch` over the read path should not have to know
    // which crypto library opened the box.
    const cipher = { publicKey: "00", encrypt: () => new Uint8Array(), decrypt: () => { throw new Error("bad key"); } };
    const err = (() => { try { openResultBytes(bytes({ enc: "vorq-sealed-v1", ciphertext: "AAAA" }), "c", cipher); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ResultIntegrityError);
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it("passes cleartext through untouched", () => {
    expect(openResultBytes(bytes({ hello: "world" }), "c", null)).toEqual({ hello: "world" });
  });
});

describe("gasFee", () => {
  // The row's gas fee, beside `cost` and never inside it. Breaks caught: not
  // surfacing it, reading it from anywhere but the row, and folding it into cost.
  const row = (gasFee: unknown) => ({
    id: "j", result_cid: "c", vorq: { rate_in: "50", rate_out: "150", provider_id: 42, gas_fee: gasFee, fee: "0" },
  });
  const bodies: [string, Uint8Array, string][] = [
    ["text", bytes({ output: [], usage: { input_tokens: 1000, output_tokens: 500 } }), "0.125"],
    ["media", bytes({ images: [{ b64: "", width: 1000, height: 1000 }] }), "150"],
    ["embedding", bytes({ object: "list", data: [], usage: { prompt_tokens: 1000 }, model: "m" }), "0.05"],
  ];

  it.each(bodies)("surfaces the job row's gas fee on a %s result, outside cost", (_kind, raw, cost) => {
    const r = resultFromRaw(raw, row("0.021"), null);
    expect(r.gasFee).toBe("0.021");
    expect(r.cost).toBe(cost);
    expect(resultFromRaw(raw, row("0"), null).cost).toBe(cost);
  });

  it.each([1, undefined, null, "1e30", "-1", "$0.03"])("refuses a job row whose gas_fee is %s", (gasFee) => {
    expect(() => resultFromRaw(bodies[0]![1], row(gasFee), null)).toThrow(VorqError);
  });

  it("surfaces a batch line's own gas fee, outside cost", () => {
    const line = (gasFee: string) =>
      resultFromBatchLine(
        { id: "row-11", vorq: { job_id: "0x7", result_cid: "bafy", rate_in: "2", rate_out: "3",
                                provider: 7, gas_fee: gasFee, fee: "0" } },
        null,
        bytes({ output: [], usage: { input_tokens: 10, output_tokens: 20 } }),
      ) as TextResult;
    expect(line("0.021").gasFee).toBe("0.021");
    expect(line("0.021").cost).toBe("0.00008");
    expect(line("0").cost).toBe("0.00008");
  });
});

describe("fee", () => {
  // The protocol fee settlement took, beside `cost` and never inside it. Breaks
  // caught: not surfacing it, recomputing it from the rates, and folding it
  // into cost.
  const row = (fee: unknown) => ({
    id: "j", result_cid: "c", vorq: { rate_in: "50", rate_out: "150", provider_id: 42, gas_fee: "0.03", fee },
  });
  const bodies: [string, Uint8Array, string, string][] = [
    ["text", bytes({ output: [], usage: { input_tokens: 1000, output_tokens: 500 } }), "0.125", "0.00125"],
    ["media", bytes({ images: [{ b64: "", width: 1000, height: 1000 }] }), "150", "1.5"],
    ["embedding", bytes({ object: "list", data: [], usage: { prompt_tokens: 1000 }, model: "m" }), "0.05", "0.0005"],
  ];

  it.each(bodies)("surfaces the job row's protocol fee on a %s result, outside cost", (_kind, raw, cost, fee) => {
    const r = resultFromRaw(raw, row(fee), null);
    expect(r.fee).toBe(fee);
    expect(r.cost).toBe(cost);
    expect(resultFromRaw(raw, row("0"), null).fee).toBe("0");
    expect(resultFromRaw(raw, row("0"), null).cost).toBe(cost);
  });

  it.each([1, undefined, null, "1e30", "-1", "$0.03"])("refuses a job row whose fee is %s", (fee) => {
    expect(() => resultFromRaw(bodies[0]![1], row(fee), null)).toThrow(/fee=.*not a USD amount/);
  });

  it("surfaces a batch line's own protocol fee, outside cost", () => {
    const line = (fee: string) =>
      resultFromBatchLine(
        { id: "row-12", vorq: { job_id: "0x8", result_cid: "bafy", rate_in: "2000", rate_out: "3000",
                                provider: 7, gas_fee: "0.03", fee } },
        null,
        bytes({ output: [], usage: { input_tokens: 10, output_tokens: 20 } }),
      ) as TextResult;
    expect(line("0.0008").fee).toBe("0.0008");
    expect(line("0.0008").cost).toBe("0.08");
    expect(line("0").cost).toBe("0.08");
  });
});

describe("discriminators and frames", () => {
  it("lifts the provider's stamp off the body and surfaces only custom_id", () => {
    // `raw` stays the model's own object; the stamp is VORQ's, added outside it.
    const raw = bytes({
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
      vorq: { custom_id: "mine", job_id: "ignored" },
    });
    const r = resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { rate_in: "0", rate_out: "0", provider_id: 7, gas_fee: "0.03", fee: "0" } }, null);
    expect(r.customId).toBe("mine");
    expect(r.raw).not.toHaveProperty("vorq");
    expect(r.provider).toBe(7);
  });

  it("parses a verbatim chat.completion body", () => {
    const raw = bytes({
      choices: [{ message: { content: "Paris." } }],
      usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
    });
    const r = resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { rate_in: "0", rate_out: "0", gas_fee: "0.03", fee: "0" } }, null);
    expect(r).toBeInstanceOf(TextResult);
    expect((r as TextResult).text).toBe("Paris.");
    expect((r as TextResult).usage).toEqual({ input_tokens: 18, output_tokens: 8, total_tokens: 26 });
  });

  it("refuses a frame that is not strict base64", () => {
    // Skipping non-alphabet characters would return b"" — a provider could
    // declare 1024x768, seal garbage, and hand back a perfectly good zero-byte
    // image that download() then wrote to disk.
    const raw = bytes({ images: [{ b64: "###", content_type: "image/png" }] });
    const r = resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { rate_out: "0", gas_fee: "0.03", fee: "0" } }, null) as MediaResult;
    expect(() => r.bytes()).toThrow(ResultIntegrityError);
  });

  it("refuses a frame whose base64 carries whitespace", () => {
    // A standard encoder never emits whitespace, so a frame carrying a newline
    // did not come from one; guessing which non-alphabet characters were meant
    // to be ignored is the guess that produced the empty frame.
    const raw = bytes({ images: [{ b64: "AA AA", content_type: "image/png" }] });
    const r = resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { rate_out: "0", gas_fee: "0.03", fee: "0" } }, null) as MediaResult;
    expect(() => r.bytes()).toThrow(ResultIntegrityError);
  });

  it("refuses a frame carrying no b64 member", () => {
    const raw = bytes({ images: [{ content_type: "image/png" }] });
    const r = resultFromRaw(raw, { id: "j", result_cid: "c", vorq: { rate_out: "0", gas_fee: "0.03", fee: "0" } }, null) as MediaResult;
    expect(() => r.bytes()).toThrow(ResultIntegrityError);
  });
});

describe("resultFromBatchLine", () => {
  /** A success body whose text and token counts distinguish it from any other. */
  const textBody = (text: string, inTok = 10, outTok = 20) =>
    bytes({
      output: [{ content: [{ type: "output_text", text }] }],
      usage: { input_tokens: inTok, output_tokens: outTok },
    });

  it("reads an error row as a JobError, keeping its custom_id", () => {
    // Breaks caught: not reading `error` at all; mapping `code` to something
    // other than `type`; dropping `custom_id`.
    const parsed = resultFromBatchLine(
      { id: "row-1", custom_id: "mine", vorq: { job_id: "0xabc" },
        error: { message: "provider refused", code: "job_failed" } },
      null, null,
    );
    expect(parsed).toBeInstanceOf(JobError);
    expect((parsed as JobError).message).toBe("provider refused");
    expect((parsed as JobError).type).toBe("job_failed");
    expect((parsed as JobError).jobId).toBe("0xabc");
    expect((parsed as JobError).customId).toBe("mine");
    expect((parsed as JobError).raw).toEqual({ message: "provider refused", code: "job_failed" });
  });

  it("defaults a bare error row's message and type", () => {
    // Break caught: `type` left undefined rather than the canonical "unknown",
    // which a caller switching on the cause vocabulary would fall through.
    const parsed = resultFromBatchLine({ id: "row-1b", error: { reason: "?" } }, null, null);
    expect((parsed as JobError).message).toBe("");
    expect((parsed as JobError).type).toBe("unknown");
    expect((parsed as JobError).customId).toBeNull();
  });

  it("answers a null job id for a vorq block that names no job", () => {
    // Not the row id. A skipped line never became a job, and handing back the
    // synthetic row id would give the caller a string that resolves to nothing.
    // Break caught: collapsing the branch to `vorq.job_id ?? line.id`.
    const parsed = resultFromBatchLine(
      { id: "row-2", vorq: { skip_reason: "unreadable" },
        error: { message: "line skipped", code: "invalid_line" } },
      null, null,
    );
    expect((parsed as JobError).jobId).toBeNull();
  });

  it("answers a null job id for an empty vorq block", () => {
    // The block's *presence* is what decides, not its contents. Break caught:
    // testing `Object.keys(vorq).length > 0` instead of `"vorq" in line` — which
    // the row above cannot catch, because its block is not empty.
    const parsed = resultFromBatchLine(
      { id: "row-2b", vorq: {}, error: { message: "line skipped", code: "invalid_line" } },
      null, null,
    );
    expect((parsed as JobError).jobId).toBeNull();
  });

  it("uses the row id only when there is no vorq block at all", () => {
    // Break caught: hard-wiring `jobId` to `vorq.job_id`, which would report
    // null for every coordinator refusal that never reached the chain.
    const parsed = resultFromBatchLine(
      { id: "row-3", error: { message: "malformed", code: "invalid_line" } }, null, null,
    );
    expect((parsed as JobError).jobId).toBe("row-3");
  });

  it("opens a success row's named bytes and costs it at the row's own rates", () => {
    // Breaks caught: passing `vorq.provider` through under its own name rather
    // than as `provider_id`, which is silent — the result builds and `.provider`
    // is just null; and reading rates from anywhere but this row's own block,
    // which would render "0" instead of (10*2 + 20*3)/1e6.
    const parsed = resultFromBatchLine(
      { id: "row-4", vorq: { job_id: "0xdef", result_cid: "bafy", rate_in: "2",
                             rate_out: "3", provider: 7, gas_fee: "0.03", fee: "0" } },
      null, textBody("hi"),
    );
    expect(parsed).toBeInstanceOf(TextResult);
    expect((parsed as TextResult).text).toBe("hi");
    expect((parsed as TextResult).provider).toBe(7);
    expect((parsed as TextResult).jobId).toBe("0xdef");
    expect((parsed as TextResult).cost).toBe("0.00008");
  });

  it("reads only the named bytes, never an inline body on the row", () => {
    // The row names its result and never carries it: `response.body` is always
    // null, because the bytes are sealed to this client's own key. Break caught:
    // an implementation that "helpfully" falls back to a row-carried copy, which
    // is the one way a sealed body could be swapped between lines.
    const parsed = resultFromBatchLine(
      { id: "row-6", vorq: { job_id: "0x2", result_cid: "bafy", rate_in: "0", rate_out: "0", gas_fee: "0.03", fee: "0" },
        response: { status_code: 200, body: {
          output: [{ content: [{ type: "output_text", text: "swapped" }] }],
          usage: { input_tokens: 0, output_tokens: 0 },
        } } },
      null, textBody("sealed"),
    );
    expect((parsed as TextResult).text).toBe("sealed");
  });

  it("decides the error before it looks for a result cid", () => {
    // Break caught: hoisting the result_cid lookup above the error branch. This
    // row names a cid and carries openable bytes, so a reordered implementation
    // returns a perfectly good TextResult for a line that never delivered.
    const parsed = resultFromBatchLine(
      { id: "row-7", vorq: { job_id: "0x3", result_cid: "bafy" },
        error: { message: "reclaimed", code: "reclaim" } },
      null, textBody("should not be read"),
    );
    expect(parsed).toBeInstanceOf(JobError);
    expect((parsed as JobError).type).toBe("reclaim");
  });

  it.each([
    ["a string", "boom"],
    ["an array", ["boom"]],
  ])("reports a row whose error is %s as a failure, not a delivery", (_label, member) => {
    // Break caught: reading an `error` member only when it is an object. Such a
    // row names a valid result_cid and carries openable bytes, so reading past
    // the error hands the caller TextResult("delivered") for a line that
    // reported a failure — a fail-open, and the one shape of mistake this
    // module must not make.
    const parsed = resultFromBatchLine(
      { id: "row-9", error: member,
        vorq: { job_id: "0x5", result_cid: "bafy", rate_in: "0", rate_out: "0" } },
      null, textBody("delivered"),
    );
    expect(parsed).toBeInstanceOf(JobError);
    expect((parsed as JobError).message).toBe("boom");
    expect((parsed as JobError).type).toBe("unknown");
    expect((parsed as JobError).jobId).toBe("0x5");
  });

  it("fails closed on a success row that names no result_cid", () => {
    // Break caught: dropping the guard entirely. Openable bytes are handed in
    // alongside the row on purpose — with no guard the row would build a happy
    // TextResult out of bytes it never named, which is the swap the design
    // forbids. Passing null bytes here would not distinguish that: they fail to
    // parse and raise the same error class for an entirely different reason.
    expect(() =>
      resultFromBatchLine({ id: "row-5", vorq: { job_id: "0x1" } }, null, textBody("unnamed")),
    ).toThrow(/names no result_cid/);
  });

  it("refuses a success row whose gas_fee is not a USD string", () => {
    // Break caught: defaulting the gas fee, which is money this line's claim took.
    const ok = { job_id: "0x6", result_cid: "bafy", rate_in: "0", rate_out: "0", gas_fee: "0.03", fee: "0" };
    const parse = (vorq: Record<string, unknown>) =>
      resultFromBatchLine({ id: "row-10", vorq }, null, textBody("hi"));
    expect(parse(ok)).toBeInstanceOf(TextResult);
    for (const gas_fee of [1, undefined, null, "1e30", "-1", "$0.03"]) {
      expect(() => parse({ ...ok, gas_fee }), String(gas_fee)).toThrow(VorqError);
      expect(() => parse({ ...ok, gas_fee })).toThrow(/gas_fee=.*not a USD amount/);
    }
  });

  it("refuses a success row whose fee is not a USD string", () => {
    // Break caught: defaulting the protocol fee, which is money this line's
    // settlement took.
    const ok = { job_id: "0x6", result_cid: "bafy", rate_in: "0", rate_out: "0", gas_fee: "0.03", fee: "0" };
    const parse = (vorq: Record<string, unknown>) =>
      resultFromBatchLine({ id: "row-10", vorq }, null, textBody("hi"));
    expect(parse(ok)).toBeInstanceOf(TextResult);
    for (const fee of [1, undefined, null, "1e30", "-1", "$0.03"]) {
      expect(() => parse({ ...ok, fee }), String(fee)).toThrow(VorqError);
      expect(() => parse({ ...ok, fee })).toThrow(/ fee=.*not a USD amount/);
    }
  });

  it("quotes the row's own result_cid when the named bytes are unreadable", () => {
    // Break caught: passing "" (or the row id) to `openResultBytes` in place of
    // the cid, which loses the only name that identifies these bytes.
    //
    // Deliberately NOT pinned here: the `raw ?? new Uint8Array()` default.
    // Dereferencing a null `raw` throws inside `openResultBytes`, which catches
    // and wraps it as this same ResultIntegrityError quoting this same CID —
    // only the message tail differs ("The \"list\" argument must be an instance
    // of ... ArrayBufferView" instead of "Unexpected end of JSON input"). No
    // honest assertion separates the two, so no test claims to.
    const err = (() => {
      try {
        resultFromBatchLine(
          { id: "row-8", vorq: { job_id: "0x4", result_cid: "bafy-row-8", gas_fee: "0.03", fee: "0" } }, null, null,
        );
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(ResultIntegrityError);
    expect((err as Error).message).toContain("bafy-row-8");
  });
});
