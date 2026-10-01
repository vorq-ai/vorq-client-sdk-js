import { describe, expect, it, vi } from "vitest";
import {
  Client,
  MAX_EXPIRY_SECONDS,
  MAX_SUBMIT_ATTEMPTS,
  SETTLEMENT_MARGIN_SECONDS,
} from "../src/client.js";
import { PrivateKeySigner } from "../src/signer/private-key.js";
import { SealedBoxCipher, deriveResultCipher } from "../src/crypto/cipher.js";
import { EscrowKeyUnverified, ValidationError, VorqError } from "../src/errors.js";
import { INLINE_MAX_BYTES } from "../src/crypto/domains.js";
import { sealOpen } from "../src/crypto/sealed-box.js";
import {
  commitmentOf,
  deriveDek,
  jobIdFor,
  openDek,
  splitContainer,
} from "../src/crypto/container.js";
import { JobHandle } from "../src/jobs.js";
// The scripted node, the signing-path fixtures and the two submit helpers all
// live in one place, because the seal-line suite needs the same ones and a
// second copy of a signing-path fixture drifts.
import {
  CHAIN,
  KEY,
  MODELS,
  QUOTE,
  RECIPIENT_PUBLIC,
  RECIPIENT_SECRET,
  baseRoutes,
  client,
  funded,
  json,
  marketCandidate,
  marketRoute,
  openEnvelope,
  posts,
  probes,
  scriptedFetch,
  sealedByASubmit,
  type Call,
  type Route,
} from "./helpers/submit-harness.js";

/**
 * The `402` an honest node answers to one posted order.
 *
 * Every member of the quoted authorization but the amount is derived from the
 * order this body carries — the job id is the nonce, and the window is
 * `expires_at + 1` — so a quote built any other way is one this client refuses,
 * which is not what most of these tests are about.
 */
const quoteFor = (body: unknown, amount?: number) => {
  const order = body as { job_id: string; expires_at: number };
  return QUOTE(order.job_id, BigInt(order.expires_at), amount);
};

describe("unit declaration", () => {
  it("takes an explicit units_out over every heuristic, zero included", async () => {
    // An embedding has no output side to buy: it settles at completionTok == 0,
    // so zero must survive as zero rather than fall through to the 4096 default,
    // or the client escrows an output leg the job can never spend.
    const zero = await sealedByASubmit({ input: "hi", max_tokens: 500 }, { unitsOut: 0 });
    expect(zero.order.units_out).toBe(0);
    const explicit = await sealedByASubmit({ input: "hi", max_tokens: 500 }, { unitsOut: 9 });
    expect(explicit.order.units_out).toBe(9);
  });

  it("refuses a negative or non-integer units_out", async () => {
    const { client: c } = client(baseRoutes());
    for (const bad of [-1, 1.5, true]) {
      await expect(
        c.submit({ model: "m", input: "hi", provider: 1, unitsOut: bad as never }),
      ).rejects.toThrow(/non-negative integer/);
    }
  });

  it("refuses it before the first network read, not after one", async () => {
    // Local validation precedes discovery, which is the order the authority
    // states. A malformed `unitsOut` is a caller mistake and nothing on chain
    // can change the answer, so a chain read that goes first only means the
    // caller is handed a TransportError from a request that was never needed
    // instead of the ValidationError that names the problem. The chain route
    // here answers 500 for exactly that reason: it is what the wrong order
    // would surface.
    const { client: c, calls } = client([
      [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
      [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
      [/\/evm\/chain/, () => json({ error: { message: "boom" } }, 500)],
    ]);
    await expect(
      c.submit({ model: "m", input: "hi", provider: 1, unitsOut: -1, validateParams: false }),
    ).rejects.toThrow(/non-negative integer/);
    expect(calls).toHaveLength(0);
  });

  it.each(["max_output_tokens", "max_tokens", "max_completion_tokens"])(
    "reads an output-token ceiling from %s",
    async (key) => {
      const { order } = await sealedByASubmit({ input: "hi", [key]: 1234 });
      expect(order.units_out).toBe(1234);
    },
  );

  it("refuses a negative output ceiling rather than substituting the default", async () => {
    // Python's ceiling chain is `a or b or c or 4096`, and `-5` is truthy there:
    // it becomes units_out = -5 and is refused by the uint32 check on the order.
    // A `> 0` filter here would instead silently substitute 4096, so the same
    // input would be signed by one SDK and rejected by the other.
    const { client: c, calls } = client([...baseRoutes(), [/\/v1\/jobs$/, () => json({}, 500)]]);
    await expect(
      c.submit({ model: "m", input: { input: "hi", max_tokens: -5 }, provider: 1 }),
    ).rejects.toThrow(/unitsOut must be in \[0, /);
    expect(posts(calls)).toHaveLength(0);
  });

  it("meters video in pixel-seconds and images in pixels", async () => {
    // width x height x duration_secs; width x height x num_images.
    // Each dimension defaults to 1024 to match the coordinator and provider.
    const video = await sealedByASubmit({ input: "hi", width: 512, height: 256, duration_secs: 3 });
    expect(video.order.units_out).toBe(512 * 256 * 3);
    const images = await sealedByASubmit({ input: "hi", width: 512, num_images: 2 });
    expect(images.order.units_out).toBe(512 * 1024 * 2);
    const defaults = await sealedByASubmit({ input: "hi", duration_secs: 2 });
    expect(defaults.order.units_out).toBe(1024 * 1024 * 2);
  });

  it("defaults to 4096 when nothing names a size", async () => {
    const { order } = await sealedByASubmit({ input: "hi" });
    expect(order.units_out).toBe(4096);
  });

  it("estimates units_in from the canonical payload, never below 1", async () => {
    const { order } = await sealedByASubmit({ input: "hi" });
    const canonical = JSON.stringify({ input: "hi" });
    expect(order.units_in).toBe(Math.max(1, Math.floor(canonical.length / 4)));
    // An empty input canonicalizes to two bytes, and a job that declared zero
    // input units would price its prompt leg at nothing.
    const empty = await sealedByASubmit({});
    expect(empty.order.units_in).toBe(1);
  });
});

describe("the envelope and the container", () => {
  it("seals the SEED and never the DEK", async () => {
    // Sealing the DEK instead produces a byte-perfect container and a job **no
    // provider can ever decrypt**. Nothing structural catches that, so it is
    // pinned here: open the wrap and assert the plaintext is the seed, and that
    // the DEK derived from it is what actually opens the bulk.
    const { container, order } = await sealedByASubmit("hello");
    const { seedWrap, ciphertext } = splitContainer(container);
    const unsealed = sealOpen(RECIPIENT_SECRET, seedWrap);
    expect(unsealed).toHaveLength(32);
    const dek = deriveDek(unsealed, order.owner as string);
    const plaintext = JSON.parse(new TextDecoder().decode(openDek(ciphertext, dek))) as {
      input: unknown;
      v: string;
    };
    expect(plaintext.input).toEqual({ input: "hello" });
    expect(plaintext.v).toBe("vorq-env-v1");
    // The seed is not the DEK: deriving is what turns one into the other. If the
    // wrap carried the DEK, `deriveDek` over it would produce something else and
    // `openDek` above would already have thrown — this pins the two apart
    // directly, so the reason is readable rather than inferred from a failure.
    expect(Buffer.from(unsealed).toString("hex")).not.toBe(Buffer.from(dek).toString("hex"));
    // And the sealed 32 bytes do not open the bulk on their own.
    expect(() => openDek(ciphertext, unsealed)).toThrow();
  });

  it("seals the owner and the result key, taking them off the wire", async () => {
    // Whoever opens the box is the only party that learns which client the task
    // belongs to and which key to seal the result back to.
    const { container, order } = await sealedByASubmit("hi");
    const env = openEnvelope(container, order.owner as string);
    expect(env.owner).toBe(order.owner);
    expect(env.result_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the DEK under the order's owner", async () => {
    // HKDF info = "vorq-dek" || owner20. The wrap is public — anyone who knows
    // a container's name can fetch it — so an attacker can lift it verbatim and
    // ask the escrow to open it. What refuses them is this: they derive under
    // their own address and get a key that does not open these bytes.
    const { container, order } = await sealedByASubmit("hi");
    const { seedWrap, ciphertext } = splitContainer(container);
    const seed = sealOpen(RECIPIENT_SECRET, seedWrap);
    const stranger = `0x${"99".repeat(20)}`;
    expect(() => openDek(ciphertext, deriveDek(seed, stranger))).toThrow();
    expect(() => openDek(ciphertext, deriveDek(seed, order.owner as string))).not.toThrow();
  });

  it("canonicalizes the sealed plaintext: sorted keys, no spaces, literal non-ASCII", async () => {
    // The plaintext is the commitment preimage, so its byte encoding is a
    // cross-language contract with Python's
    // `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
    // The expected inner object below is that call's real output for this same
    // input — keys ordered by CODE POINT ("Z" 0x5a, "b" 0x62, "ä" 0xe4, "�",
    // "\u{1f600}"), non-ASCII left literal, and no space after ':' or ','.
    //
    // The last two keys are what tells code-point order from JavaScript's own
    // UTF-16 code-unit order, which would put the emoji first: its lead
    // surrogate is 0xd83d, below 0xfffd.
    //
    // "10" and "9" are the other half of the pin, and they are why this module
    // cannot delegate to `JSON.stringify` at all. An object rebuilt in sorted
    // order still has `JSON.stringify` hoist integer-like keys and emit them in
    // NUMERIC order — `{"9":..,"10":..}` — where Python's string sort puts "10"
    // first. Without these two keys that re-implementation passes the suite.
    const input = { b: 3, "ä": 4, Z: 5, "�": 1, "\u{1f600}": 2, "10": 1, "9": 2 };
    const { container, order } = await sealedByASubmit(input);
    const { seedWrap, ciphertext } = splitContainer(container);
    const seed = sealOpen(RECIPIENT_SECRET, seedWrap);
    const plaintext = new TextDecoder().decode(
      openDek(ciphertext, deriveDek(seed, order.owner as string)),
    );
    const env = JSON.parse(plaintext) as { result_key: string };
    expect(plaintext).toBe(
      `{"input":{"10":1,"9":2,"Z":5,"b":3,"ä":4,"�":1,"\u{1f600}":2},"owner":"${order.owner as string}",` +
        `"result_key":"${env.result_key}","v":"vorq-env-v1"}`,
    );
  });

  it("computes c and the job id the chain's way", async () => {
    const { container, order } = await sealedByASubmit("hi");
    expect(order.c).toBe(commitmentOf(container));
    expect(order.job_id).toBe(jobIdFor(order.owner as string, order.c as `0x${string}`));
  });

  it("omits custom_id entirely when unset rather than sending null", async () => {
    // The envelope is canonicalized into the commitment preimage, so a key that
    // carries no meaning must not be there — it would change `c`.
    const { container, order } = await sealedByASubmit("hi");
    const env = openEnvelope(container, order.owner as string);
    expect(Object.keys(env)).not.toContain("custom_id");
    expect("custom_id" in env).toBe(false);

    // Set, it is sealed — so the absence above is the unset case and not a key
    // this client never writes.
    const tagged = await sealedByASubmit("hi", { customId: "batch-row-7" });
    expect(openEnvelope(tagged.container, tagged.order.owner as string).custom_id).toBe(
      "batch-row-7",
    );
  });

});

describe("recipient selection", () => {
  it("seals to the named provider's registry box key", async () => {
    // Proven by the fact that RECIPIENT_SECRET opens the wrap at all — see the
    // seed-rule test above, which uses the key served by /evm/providers/1.
    const { calls, container, order } = await sealedByASubmit("hi");
    expect(calls.some((c) => /\/evm\/providers\/1$/.test(c.url))).toBe(true);
    expect(() => openEnvelope(container, order.owner as string)).not.toThrow();
    // A named provider is the order's `designated`; 0 is the open-order sentinel.
    expect(order.designated).toBe(1);
  });

  it("refuses a provider that publishes no box key", async () => {
    // There is nobody to seal this payload to.
    const { client: c } = client(baseRoutes(null));
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /box_key|seal this payload to/,
    );
  });

  it.each([
    ["a number", 0.05],
    ["a bigint", 50_000n],
    ["a fraction finer than the token", "0.0000001"],
    ["an exponent", "5e-2"],
  ])("refuses a rate given as %s, naming the unit, before anything is signed", async (_label, rate) => {
    const { client: c, calls } = client(baseRoutes());
    const err = await c
      .submit({ model: "m", input: "hi", provider: 1, rateIn: rate as string, rateOut: "0.1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('USD per 1M units as a decimal string, e.g. "0.05"');
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends a USD rate as its canonical string", async () => {
    const { order } = await sealedByASubmit("hi", { rateIn: "0.050", rateOut: "2" });
    expect([order.rate_in, order.rate_out]).toEqual(["0.05", "2"]);
  });

  it("refuses an open order until spec 07 (R5)", async () => {
    // An open order seals to the coordinator's escrow key and this client has
    // no verifier to check it. Fail closed: nothing is posted, and the error
    // names submit({ provider }) as the remedy. There is no automatic fallback
    // to a designated bid — re-targeting is the caller's decision.
    const { client: c, calls } = client(baseRoutes());
    const err = await c.submit({ rateIn: "1", rateOut: "1", model: "m", input: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowKeyUnverified);
    expect((err as Error).message).toMatch(/provider/);
    expect(posts(calls)).toHaveLength(0);
    // And the escrow key was never even fetched: an unverifiable key is not
    // read and then discarded, it is refused before the read.
    expect(calls.some((x) => x.url.endsWith("/key"))).toBe(false);
  });

  // The guard is on the **truthiness** of `confidential`, not on `=== true`,
  // and the out-of-contract cases below are the ones that pin it there. The
  // flag is typed `boolean`, so a TypeScript caller can only reach the first
  // row — but this SDK ships to plain JS too, and a caller writing
  // `confidential: 1` means it. Under an `=== true` guard that order used to be
  // caught a second time inside `recipientFor`; routing the sealing through
  // `sealLine`, which seals unconditionally, left that second door with nobody
  // at it, and `1` posted twice with a 382-test suite watching.
  it.each([
    ["true", true],
    ["a truthy 1 out of plain JS", 1],
    ["a truthy string", "yes"],
    ["a truthy object", {}],
  ])("refuses a confidential submission (%s) before any request (R6)", async (_label, flag) => {
    const { client: c, calls } = client(baseRoutes());
    await expect(
      c.submit({ model: "m", input: "hi", provider: 1, confidential: flag as never }),
    ).rejects.toThrow(ValidationError);
    // Not one request — not the chain read, not the provider read, nothing.
    expect(calls).toHaveLength(0);
  });

  // The other half of the same pin: the guard must stay a truthiness test and
  // not drift into "present at all", which would refuse every caller that
  // spells out `confidential: false`.
  it.each([
    ["false", false],
    ["absent", undefined],
    ["a falsy 0", 0],
  ])("posts a submission whose confidential flag is %s", async (_label, flag) => {
    const { order, calls } = await sealedByASubmit("hi", { confidential: flag as never });
    expect(order.designated).toBe(1);
    expect(funded(calls)).toHaveLength(1);
  });
});

describe("expiry", () => {
  it("clamps to the chain's 86400 ceiling", async () => {
    // JobRegistry refuses anything past now + 86400, and the 24h window plus
    // the settlement margin already reaches it, so the clamp is the ordinary
    // case and not an edge one.
    const before = Math.floor(Date.now() / 1000);
    const { order } = await sealedByASubmit("hi", { sla: "24h" });
    const after = Math.floor(Date.now() / 1000);
    expect(Number(order.expires_at)).toBeGreaterThanOrEqual(before + 86400);
    expect(Number(order.expires_at)).toBeLessThanOrEqual(after + 86400);
  });

  it("covers the SLA window plus the settlement margin", async () => {
    // The payment authorization must outlive the work, or a long order expires
    // before /settle.
    //
    // The expectation is the clamped sum rather than the bare one, so an ambient
    // $VORQ_SETTLEMENT_MARGIN cannot turn a green suite red: a large enough
    // margin pins expires_at to the 86400 ceiling, which is the same rule, and
    // the assertion below still fails on a margin that is dropped entirely.
    const expected = Math.min(3600 + SETTLEMENT_MARGIN_SECONDS, MAX_EXPIRY_SECONDS);
    const before = Math.floor(Date.now() / 1000);
    const { order } = await sealedByASubmit("hi", { sla: "1h" });
    const after = Math.floor(Date.now() / 1000);
    expect(Number(order.expires_at)).toBeGreaterThanOrEqual(before + expected);
    expect(Number(order.expires_at)).toBeLessThanOrEqual(after + expected);
  });

  it.each([
    ["120", 120],
    ["0", 0],
    ["", 3600],
    ["90s", 3600],
    ["-1", 3600],
    ["1.5", 3600],
  ])("reads $VORQ_SETTLEMENT_MARGIN=%o as %i seconds", async (raw, seconds) => {
    // The override is read once, at module load, through the `globalThis`
    // process probe — so exercising it means a fresh module graph. Anything that
    // is not a whole number of seconds leaves the default in place rather than
    // becoming a NaN that would travel into an order's expiresAt.
    vi.stubEnv("VORQ_SETTLEMENT_MARGIN", raw);
    vi.resetModules();
    try {
      const fresh = (await import("../src/client.js")) as typeof import("../src/client.js");
      expect(fresh.SETTLEMENT_MARGIN_SECONDS).toBe(seconds);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("model id", () => {
  it("resolves a name to the catalog's numeric id", async () => {
    const { order } = await sealedByASubmit("hi");
    expect(order.model_id).toBe(7); // MODELS publishes order.model_id = 7 for "m"
  });

  // An order signs the id rather than the name, so a 0 here would post an order
  // against whatever model happens to be first. `null` is the trap worth naming:
  // it reads as "the catalog has no id", and `Number(null)` is `0`.
  it.each([{}, { model_id: null }, { model_id: "not-a-number" }, { model_id: true }])(
    "refuses a name the catalog carries no id for (%o)",
    async (vorq) => {
      const { client: c, calls } = client([
        [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
        [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
        [/\/evm\/chain/, () => json(CHAIN)],
        [/\/v1\/models/, () => json({ data: [{ id: "m", object: "model", vorq }] })],
        [/\/evm\/providers\/\d+/, () => json({ id: 1, box_key: RECIPIENT_PUBLIC })],
        [/\/v1\/jobs$/, () => json({}, 500)],
      ]);
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /no numeric model_id/,
      );
      expect(posts(calls)).toHaveLength(0);
    },
  );
});

describe("the quote", () => {
  /** A 402 body whose authorization block is the honest one, patched per test. */
  const quoteWith = (body: unknown, authorization: Record<string, unknown>) => {
    const honest = quoteFor(body).quote;
    return {
      quote: { ...honest, authorization: { ...honest.authorization, ...authorization } },
    };
  };

  /** Drive one submit against a scripted 402 body and hand back the outcome. */
  async function submitAgainst(challenge: (body: unknown) => unknown) {
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, body) => {
          const jobId = (body as never as { job_id: string }).job_id;
          return n === 1
            ? json(challenge(body), 402)
            : json({ job_id: jobId, task_cid: "bafy", tx_hash: "0x1" });
        },
      ],
    ]);
    const outcome = await c.submit({ model: "m", input: "hi", provider: 1 }).catch((e: unknown) => e);
    return { outcome, calls };
  }

  // **This client signs what it derives; the quote supplies the amount and
  // nothing else.** The block is still read member for member, because a node
  // describing a different authorization than the one about to be signed is a
  // node on another deployment — and the result of signing anyway would be an
  // unclaimable job rather than a refusal.
  const DERIVED = /not the one this client derives/;
  it.each([
    ["no quote at all", () => ({}), /no quote to sign/],
    [
      "a quote with no authorization block",
      () => ({ quote: { amount: "0.00021" } }),
      /names no amount and authorization/,
    ],
    [
      "an amount that is not a USD string",
      (b: unknown) => ({ quote: { ...quoteFor(b).quote, amount: 210 } }),
      /names no amount and authorization/,
    ],
    [
      "an amount finer than the token carries",
      (b: unknown) => ({ quote: { ...quoteFor(b).quote, amount: "0.0002100" + "1" } }),
      /names no amount and authorization/,
    ],
    [
      "another deployment's chain",
      (b: unknown) => quoteWith(b, { domain: { ...quoteFor(b).quote.authorization.domain, chainId: 999 } }),
      DERIVED,
    ],
    [
      "another token",
      (b: unknown) =>
        quoteWith(b, {
          domain: { ...quoteFor(b).quote.authorization.domain, verifyingContract: `0x${"ee".repeat(20)}` },
        }),
      DERIVED,
    ],
    [
      "another token name",
      (b: unknown) =>
        quoteWith(b, { domain: { ...quoteFor(b).quote.authorization.domain, name: "USD Coin" } }),
      DERIVED,
    ],
    [
      "another token version",
      (b: unknown) => quoteWith(b, { domain: { ...quoteFor(b).quote.authorization.domain, version: "1" } }),
      DERIVED,
    ],
    ["another payee", (b: unknown) => quoteWith(b, { to: `0x${"ee".repeat(20)}` }), DERIVED],
    [
      "another job's nonce",
      (b: unknown) => quoteWith(b, { nonce: `0x${"cc".repeat(32)}` }),
      DERIVED,
    ],
    [
      "a nonce that is not hex at all",
      (b: unknown) => quoteWith(b, { nonce: "not-a-nonce" }),
      DERIVED,
    ],
    [
      "a value that is not the amount",
      (b: unknown) => quoteWith(b, { value: 211 }),
      DERIVED,
    ],
    ["a validity that has not begun", (b: unknown) => quoteWith(b, { valid_after: 1 }), DERIVED],
    [
      "a window that is not the order's",
      (b: unknown) =>
        quoteWith(b, {
          valid_before: (b as { expires_at: number }).expires_at + 2,
        }),
      DERIVED,
    ],
  ])("refuses %s, signing nothing", async (_label, challenge, message) => {
    const { outcome, calls } = await submitAgainst(challenge);
    expect(outcome).toBeInstanceOf(VorqError);
    expect((outcome as VorqError).message).toMatch(message);
    expect((outcome as VorqError).statusCode).toBe(402);
    // The refusal is the whole point: no funded body ever went out.
    expect(funded(calls)).toHaveLength(0);
  });

  it("refuses a 402 challenge whose body is not JSON, as no quote to sign", async () => {
    // The same infrastructure answers this challenge as the 409 refusal and the
    // 200 receipt, both of which already tolerate a gateway's HTML or an empty
    // body. The 402 must not be the one path that lets a bare SyntaxError escape
    // `submit()` instead of a `VorqError`.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [/\/v1\/jobs$/, () => new Response("<html>Bad Gateway</html>", { status: 402 })],
    ]);
    const outcome = await c.submit({ model: "m", input: "hi", provider: 1 }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(VorqError);
    expect(outcome).not.toBeInstanceOf(SyntaxError);
    expect((outcome as VorqError).message).toMatch(/no quote to sign/);
    // The refusal is the whole point: no funded body ever went out.
    expect(funded(calls)).toHaveLength(0);
  });

  it("compares the quoted addresses case-insensitively", async () => {
    // The wire spelling is EIP-55 checksummed at one end and lowercase at the
    // other; only the address is being compared.
    const { outcome, calls } = await submitAgainst((b) => {
      const honest = quoteFor(b).quote;
      return {
        quote: {
          ...honest,
          authorization: {
            ...honest.authorization,
            domain: {
              ...honest.authorization.domain,
              verifyingContract: honest.authorization.domain.verifyingContract.toLowerCase(),
            },
            to: honest.authorization.to.toLowerCase(),
            nonce: honest.authorization.nonce.toLowerCase(),
          },
        },
      };
    });
    expect(outcome).not.toBeInstanceOf(Error);
    expect(funded(calls)).toHaveLength(1);
  });

  it("refuses a non-402 answer to a terms-only body without leaking a rejection", async () => {
    // A terms-only body has exactly one answer, and it is the quote: a success
    // here would mean a job posted with no container, refused on chain as
    // EmptyTaskCid. The discarded body below is deliberately already locked, so
    // `cancel()` on it rejects — a bare `void cancel()` would surface that as an
    // unhandled rejection and dirty the run.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        () => {
          const answer = json({ job_id: "0xdead" });
          answer.body?.getReader(); // lock it: cancel() now rejects
          return answer;
        },
      ],
    ]);
    const err = await c.submit({ model: "m", input: "hi", provider: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VorqError);
    expect((err as Error).message).toMatch(/answered 200 to a terms-only body/);
    expect(funded(calls)).toHaveLength(0);
  });

  it("signs the window it derives from the order, never one the node names", async () => {
    // The token requires `now < validBefore` and a claim may land exactly on
    // `expiresAt`, so the window is the order's own plus one second — and it is
    // the client's arithmetic, not the quote's, that decides it.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) =>
          n === 1
            ? json(quoteFor(b), 402)
            : json({ job_id: (b as never as { job_id: string }).job_id }),
      ],
    ]);
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });

    const payment = funded(calls).at(-1)!;
    const wire = payment.body as { auth_sig: `0x${string}`; expires_at: number };

    // The same authorization re-signed over the order's own expiry must match
    // byte for byte; over any other value it cannot.
    const ctx = await c.chainContext();
    const signer = new PrivateKeySigner(KEY);
    const args = { amount: 210n, jobId: handle.id as `0x${string}`, ctx };
    const expiresAt = BigInt(wire.expires_at);
    expect(wire.auth_sig).toBe(await signer.signPaymentAuthorization({ ...args, expiresAt }));
    expect(wire.auth_sig).not.toBe(
      await signer.signPaymentAuthorization({ ...args, expiresAt: expiresAt + 1n }),
    );
  });
});

describe("the sealing preconditions", () => {
  // A submission is always sealed: with no signer (and no $VORQ_WALLET_KEY) it is
  // refused before any request.
  it.each([
    ["no signer", { cipher: new SealedBoxCipher(new Uint8Array(32).fill(0x22)) }],
    ["neither", {}],
  ])("refuses to submit with %s, before any request", async (_label, parts) => {
    vi.stubEnv("VORQ_WALLET_KEY", "");
    try {
      const { impl, calls } = scriptedFetch(baseRoutes());
      const c = new Client({ baseUrl: "http://node", fetch: impl, ...parts });
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /set \$VORQ_WALLET_KEY or pass a signer/,
      );
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("signs with $VORQ_WALLET_KEY when no signer is passed", () => {
    vi.stubEnv("VORQ_WALLET_KEY", KEY);
    try {
      expect(new Client().signer?.address).toBe(new PrivateKeySigner(KEY).address);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("derives the result cipher from the signer when none is passed", async () => {
    const signer = new PrivateKeySigner(KEY);
    const { impl } = scriptedFetch([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => (n === 1 ? json(quoteFor(b), 402) : json({ job_id: (b as { job_id: string }).job_id })),
      ],
    ]);
    const c = new Client({ baseUrl: "http://node", fetch: impl, signer });
    expect(c.cipher).toBeNull();
    await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(c.cipher?.publicKey).toBe((await deriveResultCipher(signer)).publicKey);
  });
});

describe("no bid named: the market", () => {
  const terms = (calls: Call[]) => posts(calls)[0]!.body as Record<string, unknown>;
  const jobs: Route = [
    /\/v1\/jobs$/,
    (n, b) => (n === 1 ? json(quoteFor(b), 402) : json({ job_id: (b as { job_id: string }).job_id })),
  ];

  it("probes unsigned, then bids the first candidate's ask pinned to it", async () => {
    const { client: c, calls } = client([...baseRoutes(), jobs]);
    await c.submit({ model: "m", input: "hi" });
    const [probe] = probes(calls);
    expect(probe!.body).toEqual({
      model_id: 7,
      sla_secs: 86400,
      units_in: (probe!.body as { units_in: number }).units_in,
      units_out: (probe!.body as { units_out: number }).units_out,
      designated: 0,
    });
    // marketCandidate(1): the node's first pick, at its own ask.
    const t = terms(calls);
    expect([t.rate_in, t.rate_out, t.designated, t.sla_secs]).toEqual(["0.001", "0.002", 1, 86400]);
  });

  it("takes the node's first candidate as ranked, never re-sorting", async () => {
    const { client: c, calls } = client([
      marketRoute([marketCandidate(5), marketCandidate(4)]),
      ...baseRoutes(),
      jobs,
    ]);
    await c.submit({ model: "m", input: "hi" });
    const t = terms(calls);
    expect([t.rate_in, t.rate_out, t.designated]).toEqual(["0.005", "0.01", 5]);
  });

  it("pins the probe too when only the provider is given, and bids that provider's ask", async () => {
    const { client: c, calls } = client([...baseRoutes(), jobs]);
    await c.submit({ model: "m", input: "hi", sla: "1h", provider: 3 });
    expect((probes(calls)[0]!.body as { designated: number }).designated).toBe(3);
    const t = terms(calls);
    expect([t.rate_in, t.rate_out, t.designated]).toEqual(["0.003", "0.006", 3]);
  });

  it("refuses before signing anything when no provider is serving", async () => {
    const { client: c, calls } = client([marketRoute([]), ...baseRoutes(), jobs]);
    await expect(c.submit({ model: "m", input: "hi" })).rejects.toThrow(
      /no provider is serving m in the 24h window/,
    );
    expect(probes(calls)).toHaveLength(1);
    expect(posts(calls)).toHaveLength(0);
  });
});

describe("the two-request exchange", () => {
  /** The body a submission POSTs: the flat signed terms, and on phase 2 the bytes. */
  type Posted = { job_id: string; c: string; container?: string; container_cid?: string };

  /** POST /v1/jobs answering `answers[n-1]` on the n-th call. */
  const jobsRoute = (answers: ((body: Posted) => Response)[]): Route => [
    /\/v1\/jobs$/,
    (n: number, body: unknown) => answers[Math.min(n, answers.length) - 1]!(body as Posted),
  ];

  it("sends terms and no bytes on the challenge", async () => {
    // The quote is arithmetic over the signed terms plus one cached gas read,
    // so the challenge needs no payload — and a client that sent one anyway
    // would be told to sign a quote and come back, uploading the same megabytes
    // a second time.
    const { client: c, calls } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
      ]),
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    const [challenge, payment] = posts(calls);
    expect(challenge!.body).not.toHaveProperty("container");
    expect(challenge!.body).not.toHaveProperty("auth_sig");
    expect(payment!.body).toHaveProperty("container");
  });

  it("posts the paid submission as flat JSON: order fields, base64 container, auth_sig and amount", async () => {
    const { client: c, calls } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
      ]),
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    const [challenge, payment] = posts(calls);
    const ORDER = ["c", "owner", "job_id", "model_id", "sla_secs", "rate_in", "rate_out",
      "units_in", "units_out", "designated", "expires_at", "signature"];

    // The challenge is flat JSON: no envelope around the order, and no bytes.
    expect(typeof challenge!.init.body).toBe("string");
    expect(Object.keys(challenge!.body as object)).toEqual(ORDER);

    // So is the paid submission — JSON again, not a form.
    expect(typeof payment!.init.body).toBe("string");
    expect(new Headers(payment!.init.headers).get("content-type")).toBe("application/json");
    expect(Object.keys(payment!.body as object)).toEqual([...ORDER, "container", "auth_sig", "amount"]);

    const body = payment!.body as Record<string, unknown>;
    expect(typeof body.container).toBe("string");
    expect(body.container_cid).toBeUndefined();
    const bytes = Buffer.from(body.container as string, "base64");
    expect(commitmentOf(bytes)).toBe((challenge!.body as { c: string }).c);
  });

  it("uploads a container over INLINE_MAX_BYTES first, purpose=input, octet-stream, and posts container_cid with no container", async () => {
    // No cap remains — a container this large is never refused, only handled
    // differently: filed first, and referenced by cid rather than inlined.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/files$/,
        () => json({ id: "file_1", object: "file", purpose: "input", bytes: 1, vorq: { cid: "bafy-input" } }),
      ],
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
      ]),
    ]);
    await c.submit({ model: "m", input: "x".repeat(INLINE_MAX_BYTES + 1024), provider: 1 });

    const uploads = calls.filter((call) => call.url.endsWith("/v1/files"));
    expect(uploads).toHaveLength(1);
    // purpose ahead of the file part, which is the order the door reads them in.
    expect(Object.keys(uploads[0]!.body as object)).toEqual(["purpose", "file"]);
    expect((uploads[0]!.body as { purpose: string }).purpose).toBe("input");
    const form = uploads[0]!.init.body as FormData;
    expect((form.get("file") as File).type).toBe("application/octet-stream");

    const [, payment] = posts(calls);
    expect(typeof payment!.init.body).toBe("string");
    const body = payment!.body as Record<string, unknown>;
    expect(body.container_cid).toBe("bafy-input");
    expect(body).not.toHaveProperty("container");
  });

  it("pins the inline/upload-first split exactly at INLINE_MAX_BYTES", async () => {
    // Container length is `overhead + the payload string's length`: a fixed
    // number of bytes (the version byte, the seed wrap, the secret-box
    // nonce/MAC, the rest of the envelope) plus the "x"s, which need no JSON
    // escaping and so add exactly one byte each. Calibrate that overhead once
    // against an empty input, then solve for the string lengths that land the
    // container on either side of the boundary exactly — rather than a size
    // padded "well past" it, which the earlier tests already cover.
    const { client: probe } = client(baseRoutes());
    const ctx = await probe.chainContext();
    const overhead = (
      await probe.sealLine({
        model: "m",
        payloadInput: { input: "" },
        window: "batch",
        url: "/v1/responses",
        provider: 1,
        ctx,
      })
    ).container.length;
    const inputFor = (containerBytes: number) => "x".repeat(containerBytes - overhead);

    // Exactly at the boundary: still inline.
    {
      const { client: c, calls } = client([
        ...baseRoutes(),
        jobsRoute([
          (b) => json(quoteFor(b), 402),
          (b) => json({ job_id: b.job_id, task_cid: "bafy" }),
        ]),
      ]);
      await c.submit({ model: "m", input: inputFor(INLINE_MAX_BYTES), provider: 1 });
      const [, payment] = posts(calls);
      const body = payment!.body as Record<string, unknown>;
      expect(Buffer.from(body.container as string, "base64")).toHaveLength(INLINE_MAX_BYTES);
      expect(body.container_cid).toBeUndefined();
      expect(calls.some((call) => call.url.endsWith("/v1/files"))).toBe(false);
    }

    // One byte over: uploaded first.
    {
      const { client: c, calls } = client([
        ...baseRoutes(),
        [
          /\/v1\/files$/,
          () => json({ id: "file_1", object: "file", purpose: "input", bytes: 1, vorq: { cid: "bafy-input" } }),
        ],
        jobsRoute([
          (b) => json(quoteFor(b), 402),
          (b) => json({ job_id: b.job_id, task_cid: "bafy" }),
        ]),
      ]);
      await c.submit({ model: "m", input: inputFor(INLINE_MAX_BYTES + 1), provider: 1 });
      const uploads = calls.filter((call) => call.url.endsWith("/v1/files"));
      expect(uploads).toHaveLength(1);
      expect((uploads[0]!.body as { file: Uint8Array }).file).toHaveLength(INLINE_MAX_BYTES + 1);
      const [, payment] = posts(calls);
      expect((payment!.body as { container_cid?: string }).container_cid).toBe("bafy-input");
      expect(payment!.body).not.toHaveProperty("container");
    }
  });

  it("refuses an upload answer carrying no vorq.cid rather than posting container_cid: null", async () => {
    // The cid is the whole reference, and `VorqFile.cid` is `string | null`
    // because this client parses the field defensively. Sent on, a `null` makes
    // a body the node answers `container_required` to — which reads as "this
    // SDK forgot the container" and sends the caller looking in the wrong place.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/files$/,
        () => json({ id: "file_1", object: "file", purpose: "input", bytes: 1, vorq: {} }),
      ],
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
      ]),
    ]);

    // One submit, and the error read off it: the scripted node answers each
    // `POST /v1/jobs` once, so a second attempt would be measuring the script.
    const failure: unknown = await c
      .submit({ model: "m", input: "x".repeat(INLINE_MAX_BYTES + 1024), provider: 1 })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(VorqError);
    expect((failure as Error).message).toMatch(/no vorq\.cid for file file_1/);

    // And the paid submission was never sent — only the challenge was.
    expect(posts(calls).filter((call) => "auth_sig" in (call.body as object))).toEqual([]);
  });

  it("does not re-upload a large container when re-signing after a 409", async () => {
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/files$/,
        () => json({ id: "file_1", object: "file", purpose: "input", bytes: 1, vorq: { cid: "bafy-input" } }),
      ],
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) =>
          json(
            quoteFor(b, 999),
            409,
          ),
        (b) => json({ job_id: b.job_id, task_cid: "bafy" }),
      ]),
    ]);
    await c.submit({ model: "m", input: "x".repeat(INLINE_MAX_BYTES + 1024), provider: 1 });

    expect(calls.filter((call) => call.url.endsWith("/v1/files"))).toHaveLength(1);
    const [, first, second] = posts(calls);
    type Complete = { container_cid: string; auth_sig: string; amount: string };
    expect((second!.body as Complete).container_cid).toBe((first!.body as Complete).container_cid);
    expect((second!.body as Complete).auth_sig).not.toBe((first!.body as Complete).auth_sig);
    expect((second!.body as Complete).amount).toBe("0.000999");
  });

  it("refuses any answer to a terms-only body that is not a 402", async () => {
    // A job posted with no container names no task and is refused on chain as
    // EmptyTaskCid, so a 200 here is not a shortcut — it is a server this
    // client does not know.
    const { client: c } = client([
      ...baseRoutes(),
      jobsRoute([(b) => json({ job_id: b.job_id })]),
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /only a 402 quote is a valid answer/,
    );
  });

  it("re-signs only the payment on a 409 carrying a quote, reusing the container", async () => {
    // The terms and `c` are unchanged, so a drifting gas fee never costs a
    // fresh seed, a fresh `c`, or a second upload of the payload.
    const { client: c, calls } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) =>
          json(
            quoteFor(b, 999),
            409,
          ),
        (b) => json({ job_id: b.job_id, task_cid: "bafy" }),
      ]),
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    const [, first, second] = posts(calls);
    type Complete = { container: string; c: string; auth_sig: string; amount: string };
    expect((second!.body as Complete).container).toEqual((first!.body as Complete).container);
    expect((second!.body as Complete).c).toBe((first!.body as Complete).c);
    expect((second!.body as Complete).auth_sig).not.toBe((first!.body as Complete).auth_sig);
    expect((second!.body as Complete).amount).toBe("0.000999");
  });

  it("gives up after MAX_SUBMIT_ATTEMPTS re-quotes without re-uploading again", async () => {
    // A gas fee drifting forever is a server this client should stop feeding
    // megabytes to, not a condition to spin on.
    const { client: c, calls } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json(quoteFor(b), 409),
        (b) => json(quoteFor(b), 409),
        (b) => json(quoteFor(b), 409),
        (b) => json(quoteFor(b), 409),
      ]),
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(/drift/);
    // one challenge + exactly MAX_SUBMIT_ATTEMPTS complete submissions
    expect(posts(calls)).toHaveLength(1 + MAX_SUBMIT_ATTEMPTS);
  });

  it("treats a 402 answered to a body carrying a container as a protocol violation", async () => {
    // Looping on this would re-upload the whole payload to be quoted again.
    const { client: c, calls } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json(quoteFor(b), 402),
      ]),
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /never answered with a quote/,
    );
    expect(posts(calls)).toHaveLength(2);
  });

  it("raises the chain's refusal for a 409 with no quote in it", async () => {
    // The two 409s are told apart by **body** and never by status.
    const { client: c } = client([
      ...baseRoutes(),
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        () => json({ error: { message: "DuplicateJob", code: "DuplicateJob" } }, 409),
      ]),
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /DuplicateJob/,
    );
  });

  it("never retries a submission, but a 401 still re-mints once", async () => {
    // retry: false on both phases — a POST that may have had an effect is never
    // repeated. A 401 is different: nothing was created, so the session rotates
    // and the call goes again.
    let mints = 0;
    const { client: c, calls } = client([
      [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
      [
        /\/auth\/session/,
        () => {
          mints++;
          return json({ token: `t${mints}`, expires_at: 4102444800 });
        },
      ],
      [/\/evm\/chain/, () => json(CHAIN)],
      [/\/v1\/models/, () => json(MODELS)],
      [/\/evm\/providers\/\d+/, () => json({ id: 1, box_key: RECIPIENT_PUBLIC })],
      marketRoute(),
      jobsRoute([
        () => json({ error: { message: "expired" } }, 401),
        (b) => json(quoteFor(b), 402),
        (b) => json({ job_id: b.job_id }),
      ]),
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(mints).toBe(2);
    // The challenge was sent twice (401 then 402); the payment exactly once.
    expect(
      posts(calls).filter((p) => (p.body as { container?: unknown }).container !== undefined),
    ).toHaveLength(1);
  });
});

describe("a dropped connection", () => {
  /**
   * The pre-check is the mechanism, not an optimisation, and it must not be
   * replaced by server-side idempotency later: every field a server-side
   * comparison could be built from is public calldata a front-runner copies
   * out of the mempool, so a server would hand an attacker's row back as this
   * client's own. What makes the client side sound is the one thing the server
   * does not have — this client knows `job_id = keccak(owner ‖ c)` *before* it
   * sends, because it chose the seed and built the container.
   */
  const drop = (): never => {
    throw new TypeError("connection reset");
  };

  /** The complete submissions in a call log: the ones that carried the bytes. */
  const uploads = (calls: Call[]) =>
    calls.filter(
      (x) => x.method === "POST" && (x.body as { container?: unknown } | undefined)?.container !== undefined,
    );

  it("asks whether the job landed instead of re-uploading", async () => {
    // A hit is its own job by construction: nobody else can produce this `c`
    // without the seed inside the wrap.
    let jobId = "";
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          if (n === 1) {
            jobId = (b as never as { job_id: string }).job_id;
            return json(quoteFor(b), 402);
          }
          return drop();
        },
      ],
      [/\/v1\/jobs\/0x/, () => json({ id: jobId, status: "queued", vorq: { sla_secs: 3600 } })],
    ]);
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(handle.id).toBe(jobId);
    // Exactly one complete submission was sent — the bytes did not go twice.
    expect(uploads(calls)).toHaveLength(1);
    expect(calls.some((x) => x.url.includes(`/v1/jobs/${jobId}`))).toBe(true);
  });

  it("re-sends once when the job is genuinely absent, and no further", async () => {
    // An unbounded rewrite loop is the same defect as an unbounded 402 loop
    // wearing a different hat.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) =>
          n === 1 ? json(quoteFor(b), 402) : drop(),
      ],
      [/\/v1\/jobs\/0x/, () => json({ error: { message: "no such job" } }, 404)],
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow();
    expect(uploads(calls)).toHaveLength(2);
  });

  it("treats an unreadable pre-check as unknown and re-sends rather than swallowing it", async () => {
    // The read failed for some other reason; that is not evidence of absence,
    // but it is also not evidence the job landed.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) =>
          n === 1 ? json(quoteFor(b), 402) : drop(),
      ],
      [/\/v1\/jobs\/0x/, () => json({ error: { message: "boom" } }, 500)],
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow();
    expect(uploads(calls)).toHaveLength(2);
  });

  it("percent-encodes the job id in the pre-check's read", async () => {
    // A real job id is always `0x` + a keccak256 digest — hex only — so an
    // escaped and an unescaped spelling of one are byte-identical, and every
    // test above would pass unchanged with the `encodeURIComponent` call
    // deleted. This id is synthetic, chosen only to make that call itself
    // observable; it is not a shape `jobIdFor` could ever produce.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [/\/v1\/jobs\//, () => json({ error: { message: "no such job" } }, 404)],
    ]);
    const posted = c as unknown as {
      postedJob(jobId: string): Promise<Record<string, unknown> | null>;
    };
    await posted.postedJob("0xdead/beef?x=1");
    expect(calls.at(-1)!.url).toBe(
      `http://node/v1/jobs/${encodeURIComponent("0xdead/beef?x=1")}`,
    );
  });
});

describe("what a submission hands back", () => {
  /** A submit whose second POST answers `receipt`. */
  const submitFor = (receipt: (jobId: string) => unknown, extra: Route[] = []) =>
    client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          const jobId = (b as { job_id: string }).job_id;
          return n === 1 ? json(quoteFor(b), 402) : json(receipt(jobId));
        },
      ],
      ...extra,
    ]);

  it("is a real JobHandle, not a stub", async () => {
    // Everything downstream — result(), cancel(), waiting — hangs off this being
    // the handle from src/jobs.ts and not the two-member placeholder it replaced.
    const { client: c } = submitFor((jobId) => ({ job_id: jobId, task_cid: "bafy" }));
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(handle).toBeInstanceOf(JobHandle);
    expect(typeof handle.result).toBe("function");
    expect(typeof handle.cancel).toBe("function");
  });

  it("keeps the handle when phase 2 answers 200 with a body that is not JSON", async () => {
    // By the time this response arrives the job is already posted and paid
    // for; `jobId` is known locally — it's `keccak256(owner || c)`, computed
    // before the request went out — so a truncated body, an empty one, or a
    // gateway's HTML is not a reason to lose the handle to a funded job.
    let built = "";
    const { client: c } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          built = (b as { job_id: string }).job_id;
          return n === 1
            ? json(quoteFor(b), 402)
            : new Response("<html>Bad Gateway</html>", { status: 200 });
        },
      ],
    ]);
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(handle).toBeInstanceOf(JobHandle);
    expect(handle.id).toBe(built);
  });

  it("names the job it built, not the job the answer echoes", async () => {
    // A deliberate divergence from the authority, which reads `id or job_id` off
    // the body. This client chose the seed and built the container, so it knows
    // keccak256(owner || c) before it sends — and a handle that followed the
    // answer would follow a node that named somebody else's job, which is
    // exactly the substitution the dropped-connection pre-check exists to refuse.
    // For an honest node the two values are the same one.
    let built = "";
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          built = (b as { job_id: string }).job_id;
          return n === 1
            ? json(quoteFor(b), 402)
            : json({ job_id: `0x${"77".repeat(32)}`, task_cid: "bafy" });
        },
      ],
      [/\/v1\/jobs\/0x/, () => json({ id: built, status: "queued", vorq: { gas_fee: "0.03", fee: "0" } })],
    ]);
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(handle.id).toBe(built);
    expect(handle.id).not.toBe(`0x${"77".repeat(32)}`);
    // And the read it makes is for the job it built.
    await handle.status();
    expect(calls.at(-1)!.url).toBe(`http://node/v1/jobs/${built}`);
  });

  it("keeps the task_cid off the answer that minted it, from either shape", async () => {
    // The client can neither compute nor predict this name — the storage service
    // names the content — so the answer is the only place it comes from. A post
    // receipt carries it at the top level; an indexed row carries it under vorq.
    const receipt = submitFor((jobId) => ({ job_id: jobId, task_cid: "bafy-receipt" }));
    expect((await receipt.client.submit({ model: "m", input: "hi", provider: 1 })).taskCid).toBe(
      "bafy-receipt",
    );

    const row = submitFor((jobId) => ({ id: jobId, status: "queued", vorq: { task_cid: "bafy-row" } }));
    expect((await row.client.submit({ model: "m", input: "hi", provider: 1 })).taskCid).toBe(
      "bafy-row",
    );

    const none = submitFor((jobId) => ({ job_id: jobId }));
    expect((await none.client.submit({ model: "m", input: "hi", provider: 1 })).taskCid).toBeNull();
  });

  it("reads through this client's own transport, session and all", async () => {
    // The handle takes a `JobClient` and nothing else, so `Client` has to
    // forward `json`/`request` to its own `Transport` — the thing that carries
    // the base URL, the session token and the retry policy. A handle wired to a
    // bare `fetch` would read somewhere else, and this is where that shows.
    const { client: c, calls } = submitFor((jobId) => ({ job_id: jobId }), [
      [/\/v1\/jobs\/0x/, () => json({ id: "x", status: "completed", vorq: { gas_fee: "0.03", fee: "0" } })],
    ]);
    const handle = await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(await handle.status()).toBe("completed");
    const read = calls.at(-1)!;
    expect(read.method).toBe("GET");
    expect(read.url).toBe(`http://node/v1/jobs/${handle.id}`);
  });

  it("re-signs the re-quoted amount, and the value it authorizes moves with it", async () => {
    // A loop that threaded the new amount into the body but kept the first
    // quote's signature would send a body whose `amount` and whose signed
    // `value` disagree — and the node would refuse it for a reason naming
    // neither. Only the fee moves here, so a client that ignored the second
    // quote entirely would send an identical auth_sig.
    let jobId = "";
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          jobId = (b as { job_id: string }).job_id;
          if (n === 1) return json(quoteFor(b), 402);
          if (n === 2) return json(quoteFor(b, 999), 409);
          return json({ job_id: jobId });
        },
      ],
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    const [, first, second] = posts(calls);
    const paid = (call: Call) => call.body as { auth_sig: string; amount: string; expires_at: number };
    expect(paid(second!).auth_sig).not.toBe(paid(first!).auth_sig);
    expect(paid(second!).amount).toBe("0.000999");

    const signer = new PrivateKeySigner(KEY);
    expect(paid(second!).auth_sig).toBe(
      await signer.signPaymentAuthorization({
        amount: 999n,
        jobId: jobId as `0x${string}`,
        expiresAt: BigInt(paid(second!).expires_at),
        ctx: await c.chainContext(),
      }),
    );
  });

  it("re-checks a re-quote against its own context rather than trusting the second one", async () => {
    // The first quote passing is not a licence for the second: a node that
    // quotes honestly, is refused, and then re-quotes another deployment's chain
    // would otherwise get a valid signature over an authorization the caller
    // never meant to give.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          if (n === 1) return json(quoteFor(b), 402);
          const honest = quoteFor(b).quote;
          return json(
            {
              quote: {
                ...honest,
                authorization: {
                  ...honest.authorization,
                  domain: { ...honest.authorization.domain, chainId: 1 },
                },
              },
            },
            409,
          );
        },
      ],
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /not the one this client derives/,
    );
    // One challenge and one funded attempt: the bad re-quote signed nothing.
    expect(funded(calls)).toHaveLength(1);
  });

  it("discards a 402 answered to a complete submission without leaking a rejection", async () => {
    // The body is deliberately already locked, so `cancel()` on it rejects — a
    // bare `void cancel()` would surface that as an unhandled rejection and
    // dirty the run.
    const { client: c } = client([
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          const jobId = (b as { job_id: string }).job_id;
          if (n === 1) return json(quoteFor(b), 402);
          const answer = json(quoteFor(b), 402);
          answer.body?.getReader(); // lock it: cancel() now rejects
          return answer;
        },
      ],
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
      /never answered with a quote/,
    );
  });
});

describe("the reads a handle is wired to", () => {
  it("re-attaches to a persisted id without a network call", async () => {
    const { client: c, calls } = client(baseRoutes());
    const handle = c.job("0xdead");
    expect(handle).toBeInstanceOf(JobHandle);
    expect(handle.id).toBe("0xdead");
    expect(calls).toHaveLength(0);
  });

  it("reads blobs off the gateway, unauthenticated and nowhere near the coordinator", async () => {
    // The CID *is* the authorization: knowing the name is the whole entitlement,
    // so this read carries no session token and never touches the base URL — the
    // coordinator serves no blob endpoint to touch.
    const seen: { url: string; auth: string | null }[] = [];
    const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const c = new Client({
      baseUrl: "http://node",
      gateway: "https://gw/",
      fetch: impl as unknown as typeof globalThis.fetch,
    });
    expect(await c.fetchBlob("bafy")).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://gw/ipfs/bafy");
    expect(seen[0]!.auth).toBeNull();
  });

  it("has no read path at all when the gateway is disabled", async () => {
    // `gateway: ""` is "I will supply my own", and it must be sayable rather
    // than falling through to the built-in default.
    const { impl } = scriptedFetch([]);
    const c = new Client({ baseUrl: "http://node", gateway: "", fetch: impl });
    await expect(c.fetchBlob("bafy")).rejects.toThrow(/no gateway configured/);
  });
});

describe("param checking on the way in", () => {
  /** A catalog whose one model publishes `schema` as its params schema. */
  const withSchema = (schema: unknown): Route[] => [
    [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
    [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
    [/\/evm\/chain/, () => json(CHAIN)],
    [
      /\/v1\/models/,
      () => json({ data: [{ id: "m", object: "model", vorq: { model_id: 7, params_schema: schema } }] }),
    ],
    [/\/evm\/providers\/\d+/, () => json({ id: 1, box_key: RECIPIENT_PUBLIC })],
  ];

  const SCHEMA = { type: "object", properties: { temperature: { type: "number" } } };

  it("surfaces the checker's warnings without refusing the submission", async () => {
    // Deliberate divergence from Python in mechanism only: it raises a
    // UserWarning from inside the checker, and there is no such channel here, so
    // `checkInput` returns them and this is the door they come out of. A warning
    // is never a refusal — the serving provider may well understand the key.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client: c, calls } = client([
        ...withSchema(SCHEMA),
        marketRoute(),
        [
          /\/v1\/jobs$/,
          (n, b) => {
            const jobId = (b as { job_id: string }).job_id;
            return n === 1 ? json(quoteFor(b), 402) : json({ job_id: jobId });
          },
        ],
      ]);
      await c.submit({ model: "m", input: { input: "hi", nonesuch: 1 }, provider: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not in the model's schema"));
      expect(funded(calls)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a param the schema contradicts, before anything is sealed", async () => {
    const { client: c, calls } = client([
      ...withSchema(SCHEMA),
      [/\/v1\/jobs$/, () => json({}, 500)],
    ]);
    await expect(
      c.submit({ model: "m", input: { input: "hi", temperature: "warm" }, provider: 1 }),
    ).rejects.toThrow(ValidationError);
    expect(posts(calls)).toHaveLength(0);
  });

  it("skips the check outright on validateParams: false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client: c, calls } = client([
        ...withSchema(SCHEMA),
        marketRoute(),
        [
          /\/v1\/jobs$/,
          (n, b) => {
            const jobId = (b as { job_id: string }).job_id;
            return n === 1 ? json(quoteFor(b), 402) : json({ job_id: jobId });
          },
        ],
      ]);
      await c.submit({
        model: "m",
        input: { input: "hi", temperature: "warm" },
        provider: 1,
        validateParams: false,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(funded(calls)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("never lets a discovery hiccup block a submit", async () => {
    // A network failure reading the schema is not a statement about the input.
    const { client: c, calls } = client([
      [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
      [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
      [/\/evm\/chain/, () => json(CHAIN)],
      // First read (the schema lookup) fails; the model-id resolution re-reads.
      [/\/v1\/models/, (n) => (n === 1 ? json({ error: { message: "boom" } }, 500) : json(MODELS))],
      [/\/evm\/providers\/\d+/, () => json({ id: 1, box_key: RECIPIENT_PUBLIC })],
      marketRoute(),
      [
        /\/v1\/jobs$/,
        (n, b) => {
          const jobId = (b as { job_id: string }).job_id;
          return n === 1 ? json(quoteFor(b), 402) : json({ job_id: jobId });
        },
      ],
    ]);
    await c.submit({ model: "m", input: "hi", provider: 1 });
    expect(funded(calls)).toHaveLength(1);
  });
});

describe("the upload-first path's operational bounds", () => {
  type Posted = { job_id: string; c: string; container?: string; container_cid?: string };
  const jobsRoute = (answers: ((body: Posted) => Response)[]): Route => [
    /\/v1\/jobs$/,
    (n: number, body: unknown) => answers[Math.min(n, answers.length) - 1]!(body as Posted),
  ];

  it("files the container only after the payment is signed", async () => {
    // The orphan window opens the moment the bytes are filed: an upload nobody
    // has attached is deleted after 300 s. `signPaymentAuthorization` is a wallet
    // prompt in a browser — a dialog a human has to notice and approve — so an
    // upload ahead of it starts that clock and then waits on a person. Six
    // minutes in another tab and the sweep wins, the post is refused
    // `unknown_container`, and the node marks that refusal not retryable.
    //
    // Signing first costs nothing: the payment does not depend on the container,
    // and a caller who declines the prompt never uploads at all.
    const order: string[] = [];
    // The real signer, with one method watched: a hand-built stand-in would have
    // to reimplement the handshake too, and this test is about ordering.
    const signer = new PrivateKeySigner(KEY);
    const realPayment = signer.signPaymentAuthorization.bind(signer);
    vi.spyOn(signer, "signPaymentAuthorization").mockImplementation(async (...args) => {
      order.push("payment");
      return realPayment(...args);
    });

    const { client: c } = client(
      [
        ...baseRoutes(),
        [
          /\/v1\/files$/,
          () => {
            order.push("upload");
            return json({
              id: "file_1",
              object: "file",
              purpose: "input",
              bytes: 1,
              vorq: { cid: "bafy-input" },
            });
          },
        ],
        jobsRoute([
          (b) => json(quoteFor(b), 402),
          (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
        ]),
      ],
      { signer },
    );

    await c.submit({ model: "m", input: "x".repeat(INLINE_MAX_BYTES + 1024), provider: 1 });

    expect(order).toEqual(["payment", "upload"]);
  });

  it("still files the container once across a re-quote", async () => {
    // The other half of the ordering change: moving the upload after the payment
    // must not move it *into* the attempt loop, or a gas-fee re-quote re-sends
    // the whole payload — which is the cost the upload-first path exists to
    // avoid paying twice.
    const { client: c, calls } = client([
      ...baseRoutes(),
      [
        /\/v1\/files$/,
        () =>
          json({
            id: "file_1",
            object: "file",
            purpose: "input",
            bytes: 1,
            vorq: { cid: "bafy-input" },
          }),
      ],
      jobsRoute([
        (b) => json(quoteFor(b), 402),
        (b) => json(quoteFor(b), 409),
        (b) => json({ job_id: b.job_id, task_cid: "bafy", tx_hash: "0x1" }),
      ]),
    ]);

    await c.submit({ model: "m", input: "x".repeat(INLINE_MAX_BYTES + 1024), provider: 1 });

    expect(calls.filter((call) => call.url.endsWith("/v1/files"))).toHaveLength(1);
    // The 409 was actually consumed as a re-quote rather than short-circuiting
    // somewhere earlier: challenge, re-quoted attempt, accepted attempt. Without
    // this the single-upload assertion would also pass if the submission had
    // never reached a second attempt at all.
    expect(posts(calls)).toHaveLength(3);
  });
});
