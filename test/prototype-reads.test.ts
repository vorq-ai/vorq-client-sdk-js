/**
 * The prototype-chain rule, one test per site that reads an untrusted record.
 *
 * The rule (stated at each site in `src/`, and on the `own()` helper in `src/own.ts`): a
 * record that arrived from `JSON.parse` or from a caller is read with
 * `Object.hasOwn`, never with a bare `key in record` or a bare `record[key]`.
 *
 * Two shapes make the bare forms answer for keys nobody sent, and this file
 * uses both:
 *
 *   - **A name `Object.prototype` supplies.** `"constructor" in {}` is `true`
 *     and `{}["toString"]` is a function, so a *published* schema declaring
 *     `"constructor": false` refused every request from every caller — the
 *     defect that prompted this suite. Prototype pollution generalizes it to
 *     any name at all, which is how the `properties[key]` sites are pinned
 *     below: a page that pollutes `Object.prototype` must not be able to make
 *     this SDK refuse an honest request.
 *   - **`Object.create(honestRecord)`** — an object whose own-property set is
 *     **empty**. It states nothing, and yet every `.` read answers with the
 *     honest record's values. Each verifier check gets one of these: an
 *     inherited property must not be able to satisfy a check.
 *
 * Every test here is written so that reverting *its own* site — and no other —
 * turns it red, with **ten** measured exceptions — every one checked by
 * reverting each guard in turn and reading which tests went red. Nine are
 * guards that redden more than one test; the tenth is the opposite case, five
 * masked reads that redden none:
 *
 *   - `normalize`'s `method` and `body` reads share one guard (`stated`), so
 *     reverting it reddens both of its tests.
 *   - `sealingFetch`'s six construction reads share one guard (`stated`), so
 *     reverting it reddens both of its tests.
 *   - "reads no model from the fetched row's prototype" reddens for **either**
 *     `retrieve`'s read or `responseObject`'s: the two sit on one call path
 *     over one row. The pure-`render` test isolates `responseObject`'s.
 *   - "reads no request body from the prototype" reddens for **either**
 *     `normalize`'s guard or `Transport.request`'s, for the same reason. The
 *     transport test calls `client.request` directly and isolates that one.
 *   - `Client.providers`' `box_key` read has **three** tests — the site, the
 *     batch path and the single-order path — and reverting it reddens all
 *     three. That is deliberate: the defect hid because the site looked like a
 *     display read, so the end-to-end tests are the ones that matter.
 *   - `checkInput`'s `own(schema, "properties")` has **two** — the unit test and
 *     the end-to-end `Client.submit` one — and reverting it reddens both. The
 *     end-to-end test is the one that states the consequence: the shipped
 *     defect was a client that could not submit at all.
 *   - `BatchHandle`'s status read (`statusOf`) has **two** — the `cancel` gate
 *     and the wait loop's terminal test — because both call the one guard.
 *   - `Client.payLine`'s five reads (`terms`, `url`, `order`, `container`,
 *     `jobId`) share one `stated` guard, so one test covers them and reverting
 *     any *single* read is masked by the others — `jobId` alone still throws
 *     out of `BigInt(undefined)`. The measured revert is the helper itself.
 *   - `Client.floors` and `Client.jobsSummary` read every figure through the
 *     one `moneyFigure` guard, so reverting it reddens all three of
 *     the tests that pollute a wire figure: the floors row, the summary body
 *     and the `by_model` row. Each still isolates its own *record*, because
 *     nothing else supplies these bodies.
 *   - **Five own-reads are masked and no test here reddens for them**, because
 *     an own-guard on the same key runs first: `verify.ts:799`
 *     (`own(rec, "box_key")`, after `verifyRecord`), and in `results.ts`
 *     `:553` (`data`, after `isEmbedding`), `:570` (`images`), `:577` (`video`)
 *     and `:613` (`choices`, after the dispatch in `resultFromRaw`). Each
 *     carries a comment at its site saying which ordering it rests on and that
 *     nothing enforces that ordering. They are correct today and untested by
 *     construction; a refactor that reorders the guards is what the comments
 *     are for. Reverting any of the five reddens **nothing**.
 *
 * **What this file covers, and what it does not.** Every own-read guard in
 * `params.ts`, `units.ts`, `verify.ts`, `results.ts`, `client.ts`,
 * `terms.ts` (`ChainContext.fromWire`), `paging.ts` (`pageRows`),
 * `models.ts` (`paramsSchema`), `jobs.ts`, `transport.ts`, `errors.ts`
 * (`errorFromWire`), `files.ts` (`fetchBlob`), `crypto/cipher.ts`
 * (`SealedBoxCipher`'s recipient), `signer/private-key.ts`,
 * `signer/browser-wallet.ts`, `openai-compat.ts`, `sla.ts`
 * (`windowFromSeconds`) and `batches.ts` has a test below — except the five
 * masked reads named above, which no test can redden. Every one of those tests was checked by
 * **reverting its own guard to the bare read and confirming that the test goes
 * red**; the list above records every case where that reddens more than one
 * test, and there are no others.
 *
 * **The environment is a record, and it is in scope.** `process.env.X` for an
 * unset `X` returns `Object.prototype.X`, so the three environment reads —
 * `$VORQ_PIN_GATEWAY` (`files.ts`), `$VORQ_WALLET_KEY` (`signer/private-key.ts`)
 * and `$VORQ_SETTLEMENT_MARGIN` (`client.ts`) — are read own-properties only,
 * at **every hop**: `globalThis.process`, `process`'s `env`, and the variable
 * name. The `globalThis` hop matters because a browser realm has no own
 * `process`, so a bare read there lets a polluted prototype manufacture an
 * environment where those files' docblocks promise there is none. The same
 * applies to `globalThis.window` in `signer/browser-wallet.ts`.
 *
 * The corresponding enumeration — every read of an untrusted record in `src/`,
 * what each one decides, and the verdict — is
 * `.superpowers/sdd/2026-08-28-js-sdk-08-sdk-compat-webhooks-packaging/enumeration.md`.
 *
 * **Deliberately outside it, and these are now the only entries:**
 *
 *   - **`sla.ts`'s `normalizeSla`** — the untrusted thing there is the *key* a
 *     caller supplies, looked up in this package's own `TIER_ALIASES` table
 *     with `Object.hasOwn`. `test/sla.test.ts` owns that table's behaviour, and
 *     a tier named `constructor` is pinned there rather than duplicated here.
 *     (`windowFromSeconds`'s `SECONDS_WINDOW` lookup in the same file is a
 *     different question — its key is the coordinator's, not a caller's — and
 *     it **is** covered below.)
 *   - **`terms.ts`'s `OrderTerms`** constructor and `toWire` — their records are
 *     built by `client.ts` as own literals and `OrderTerms` is not on the
 *     package's export surface, so no caller can hand one in.
 *   - **`signer/browser-wallet.ts`'s EIP-6963 event detail** (`detail?.info?.uuid`
 *     in `discover`). It is a `CustomEvent` payload from a wallet extension —
 *     neither `JSON.parse` output nor a caller argument — and the object is used
 *     whole (its `provider` is called) rather than probed for absent keys, so a
 *     prototype value cannot manufacture a wallet that was never announced.
 *     (The `globalThis.window` fallback beside it **is** guarded — an earlier
 *     round left it bare and justified it as "a realm with no `window` has no
 *     wallet to steal", which was wrong in the direction that matters:
 *     pollution does not steal a wallet, it *manufactures* one.)
 *
 * `sla.ts:76`'s `SECONDS_WINDOW[parsed]` was on this exclusion list too, under
 * a justification that was **false as written** — the key there is
 * `Number(String(vorq.sla_secs))` off the coordinator's row, not a
 * regex-constrained one — and it is now guarded and tested like the rest.
 *
 * Everything the previous version of this list named as an unclosed gap —
 * `batches.ts`'s `gasFee`, its `BatchHandle` (`id`, the two file ids,
 * `request_counts`, `completion_window`, `status`, `row.vorq`,
 * `vorq.result_cid`, the options record) and its listing; `jobs.ts`'s
 * `settledResult` and `waitFor` — **is now guarded and tested**, and each of
 * those tests reddens when its own guard is reverted.
 */
import { describe, expect, it, vi } from "vitest";

import { Client, DEFAULT_BASE_URL, mintSessionToken } from "../src/client.js";
import { toBase64 } from "../src/crypto/bytes.js";
import {
  EscrowKeyUnverified,
  ResultIntegrityError,
  ValidationError,
  VerificationError,
  VorqError,
  WaitTimeout,
  errorFromWire,
} from "../src/errors.js";
import { JobHandle, endCause } from "../src/jobs.js";
import { errorResponse, responseObject, sealingFetch } from "../src/openai-compat.js";
import type { SealingFetch } from "../src/openai-compat.js";
import { checkInput } from "../src/params.js";
import {
  EmbeddingResult,
  JobError,
  MediaResult,
  TextResult,
  resultFromBatchLine,
  resultFromRaw,
} from "../src/results.js";
import { parseUsd } from "../src/money.js";
import { declareUnits } from "../src/units.js";

/** A batch line body with its own bid: an unpriced line is refused. */
const PRICED_LINE = { model: "m", max_rate_in: "1", max_rate_out: "2" };
import { Verifier } from "../src/verify.js";
import {
  CHAIN,
  KEY,
  MODELS,
  QUOTE,
  RECIPIENT_PUBLIC,
  RESULT_KEY,
  baseRoutes,
  batchHarness,
  client,
  handleHarness,
  json,
  manifestRows,
  marketRoute,
  posts,
  probes,
  type Call,
  scriptedFetch,
  type Route,
  usd,
} from "./helpers/submit-harness.js";
import { BatchHandle } from "../src/batches.js";
import { SealedBoxCipher } from "../src/crypto/cipher.js";
import { curvePublicKey, seal } from "../src/crypto/sealed-box.js";
import { SEALED_RESULT_VERSION } from "../src/crypto/domains.js";
import { fetchBlob, resolveGateway } from "../src/files.js";
import { slaSeconds, windowFromSeconds } from "../src/sla.js";
import { BrowserWalletSigner } from "../src/signer/browser-wallet.js";
import type { ChainContext } from "../src/terms.js";
import { CTX } from "./vectors-loader.js";
import { PrivateKeySigner } from "../src/signer/private-key.js";
import {
  ACTIVE,
  BOX,
  ESCROW_ACTIVE,
  MEASUREMENT,
  NOW,
  announcement,
  evidence,
  record,
  scriptedNode,
  staticAnnouncement,
} from "./helpers/verify-harness.js";

/**
 * `base` with exactly one key moved onto a prototype — every other field stays
 * own.
 *
 * This is the shape that isolates a single site: the record is otherwise
 * completely honest, so the only check that can fail is the one reading the
 * moved key. A whole-record `Object.create` fails at the first guard and would
 * pin only that one.
 */
function inherited(base: Record<string, unknown>, key: string): Record<string, unknown> {
  const out = Object.create({ [key]: base[key] }) as Record<string, unknown>;
  for (const [k, v] of Object.entries(base)) {
    if (k !== key) out[k] = v;
  }
  return out;
}

/** Add one non-enumerable property to `Object.prototype`. */
function pollute(key: string, value: unknown): void {
  Object.defineProperty(Object.prototype, key, {
    value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

const unpollute = (key: string): void => {
  delete (Object.prototype as Record<string, unknown>)[key];
};

/** Run a **synchronous** `body` with one extra property on `Object.prototype`. */
function polluted<T>(key: string, value: unknown, body: () => T): T {
  pollute(key, value);
  try {
    return body();
  } finally {
    unpollute(key);
  }
}

/**
 * The same for an async `body`, and it is a separate function on purpose: a
 * `try { return body(); } finally { … }` around an async callback removes the
 * property the moment the promise is *created*, so the work under test would
 * run in a clean realm and the test would pass for the wrong reason. The
 * `await` inside the `try` is what holds the pollution open.
 */
async function pollutedAsync<T>(key: string, value: unknown, body: () => Promise<T>): Promise<T> {
  pollute(key, value);
  try {
    return await body();
  } finally {
    unpollute(key);
  }
}

/**
 * The same for **several** keys at once.
 *
 * Used where one function reshapes a whole wire record: polluting every key it
 * reads and asserting the whole reshaped object means reverting *any single one*
 * of those reads reddens the test, which is what makes one test per record
 * honest rather than a claim about the one field it happened to check.
 */
async function pollutedAllAsync<T>(
  entries: [string, unknown][],
  body: () => Promise<T>,
): Promise<T> {
  for (const [key, value] of entries) pollute(key, value);
  try {
    return await body();
  } finally {
    for (const [key] of entries) unpollute(key);
  }
}

/** The honest `402` for one posted order, off the body the route was handed. */
const quoted = (body: unknown) => {
  const order = body as { job_id: string; expires_at: number };
  return QUOTE(order.job_id, BigInt(order.expires_at));
};

function pollutedAll<T>(entries: [string, unknown][], body: () => T): T {
  for (const [key, value] of entries) pollute(key, value);
  try {
    return body();
  } finally {
    for (const [key] of entries) unpollute(key);
  }
}

// ---------------------------------------------------------------------------
// src/params.ts
// ---------------------------------------------------------------------------

describe("checkInput — the published schema's key membership test", () => {
  // Site: `sub === false && Object.hasOwn(body, key)` in `checkInput`.
  // This is the shipped defect, verified against `dist/` before the fix.
  it("does not refuse over a `constructor` subschema nobody's input carries", () => {
    expect(() => checkInput({ properties: { constructor: false } }, { max_tokens: 5 })).not.toThrow();
  });

  it("does not refuse over a `toString` subschema nobody's input carries", () => {
    expect(() => checkInput({ properties: { toString: false } }, { max_tokens: 5 })).not.toThrow();
  });

  it("still refuses a forbidden key the input actually carries", () => {
    // The other direction, so the fix cannot be "stop checking": an own key
    // declared `false` is still a refusal.
    expect(() => checkInput({ properties: { constructor: false } }, { constructor: 5 })).toThrow(
      /parameter 'constructor' is not supported/,
    );
  });

  // Site: `sub === false && Object.hasOwn(nestedBody, key)` in `matches`.
  it("does not refuse a nested object over a `constructor` subschema", () => {
    expect(() =>
      checkInput({ properties: { opts: { properties: { constructor: false } } } }, { opts: {} }),
    ).not.toThrow();
  });
});

describe("checkInput — the published schema's `type` as a lookup key", () => {
  // Site: `Object.hasOwn(TYPE_CHECKS, s.type) ? TYPE_CHECKS[s.type] : undefined`.
  //
  // The untrusted thing here is the **key**, not the record: `TYPE_CHECKS` is
  // this package's own table, and the coordinator's schema chooses what to look
  // up in it. `client.submit()` calls `checkInput` outside the `try/catch` that
  // wraps the fetch, so both spellings below reached every caller.
  const schema = (type: string) => ({ properties: { max_tokens: { type } } });

  it("does not call a prototype method for `type: \"valueOf\"`", () => {
    // Was: `Object.prototype.valueOf` returned, then invoked as a type check —
    // `TypeError: Cannot convert undefined or null to object`, which is not a
    // `VorqError` and escapes this SDK's error taxonomy entirely.
    expect(() => checkInput(schema("valueOf"), { max_tokens: 5 })).not.toThrow();
  });

  it("does not refuse every request for `type: \"isPrototypeOf\"`", () => {
    // Was: `Object.prototype.isPrototypeOf` returned `false` for the value, so
    // the param was refused for every caller.
    expect(() => checkInput(schema("isPrototypeOf"), { max_tokens: 5 })).not.toThrow();
  });

  it("reports an unknown type name as an unevaluated keyword, not a refusal", () => {
    expect(checkInput(schema("valueOf"), { max_tokens: 5 })).toEqual([]);
  });

  it("still enforces a type name the table does define", () => {
    expect(() => checkInput(schema("string"), { max_tokens: 5 })).toThrow(
      /parameter 'max_tokens' is invalid/,
    );
  });
});

describe("checkInput — looking a caller's param up in the schema", () => {
  // Site: `const sub = own(properties, key)` in `checkInput`.
  //
  // A bare `properties[key]` answers from `Object.prototype`, so a polluted
  // prototype supplies a subschema the coordinator never published and the
  // request is refused against it.
  it("reads no subschema from the prototype for a param the schema omits", () => {
    polluted("temperature", { type: "string" }, () => {
      expect(() => checkInput({ properties: {} }, { temperature: 0.7 })).not.toThrow();
      expect(checkInput({ properties: {} }, { temperature: 0.7 })).toEqual([
        "params not in the model's schema (a provider may ignore them): temperature",
      ]);
    });
  });

  // Site: `const sub = own(nestedProperties, key)` in `matches`.
  it("reads no nested subschema from the prototype", () => {
    polluted("temperature", { type: "string" }, () => {
      expect(() =>
        checkInput(
          { properties: { opts: { type: "object", properties: {} } } },
          { opts: { temperature: 0.7 } },
        ),
      ).not.toThrow();
    });
  });

  it("a param named `constructor` is unknown, not matched against a function", () => {
    // The milder twin of the defect above: `properties["constructor"]` is
    // `Object.prototype.constructor`, which is a function, and `matches`
    // returns `true` for a non-object schema — so the param was silently not
    // checked rather than wrongly refused. It must be reported unknown.
    expect(checkInput({ properties: { max_tokens: { type: "integer" } } }, { constructor: "x" })).toEqual([
      "params not in the model's schema (a provider may ignore them): constructor",
    ]);
  });
});

describe("checkInput — the cross-field budget check", () => {
  // Sites: the three `own(input, …)` reads in `checkBudgetFitsCap`.
  //
  // `canonicalJson` seals `Object.keys` — own properties only — so a param the
  // caller merely inherits is never sent. Refusing over one refuses a request
  // the network would have accepted.
  it("reads no output cap from the prototype", () => {
    const input = inherited({ max_tokens: 10, reasoning_max_tokens: 50 }, "max_tokens");
    expect(() => checkInput(null, input)).not.toThrow();
  });

  it("reads no reasoning budget from the prototype", () => {
    const input = inherited({ max_tokens: 10, reasoning_max_tokens: 50 }, "reasoning_max_tokens");
    expect(() => checkInput(null, input)).not.toThrow();
  });

  it("reads no min_tokens from the prototype", () => {
    const input = inherited({ max_tokens: 10, min_tokens: 50 }, "min_tokens");
    expect(() => checkInput(null, input)).not.toThrow();
  });

  it("still refuses an own reasoning budget that fills the cap", () => {
    expect(() => checkInput(null, { max_tokens: 10, reasoning_max_tokens: 50 })).toThrow(
      /reasoning_max_tokens/,
    );
  });
});

// ---------------------------------------------------------------------------
// src/units.ts
// ---------------------------------------------------------------------------

describe("declareUnits — sizing an order from the caller's input", () => {
  // Site: `OUTPUT_CEILING_KEYS.some((key) => Object.hasOwn(input, key))`.
  it("declares the default when the only ceiling is inherited", () => {
    expect(declareUnits(inherited({ max_tokens: 77 }, "max_tokens")).unitsOut).toBe(4096);
  });

  // Site: `OUTPUT_CEILING_KEYS.some((key) => Object.hasOwn(input, key))`, isolated.
  //
  // The test above cannot redden this membership test on its own: entering the
  // ceiling branch and finding nothing there lands on the same 4096 as never
  // entering it. Giving the input an own *image* shape separates the two — an
  // inherited ceiling must leave the image branch reachable.
  it("does not take the ceiling branch on an inherited ceiling alone", () => {
    const input = inherited(
      { max_tokens: 77, num_images: 2, width: 100, height: 100 },
      "max_tokens",
    );
    expect(declareUnits(input).unitsOut).toBe(100 * 100 * 2);
  });

  // Site: `Math.trunc(Number(own(input, key) ?? 0))`.
  it("reads no ceiling value from the prototype when another ceiling is own", () => {
    // `max_output_tokens: 0` is own and falls through the `!== 0` filter, so
    // the branch is entered and every spelling is read — the inherited
    // `max_tokens` must not be one of them.
    const input = inherited({ max_output_tokens: 0, max_tokens: 77 }, "max_tokens");
    expect(declareUnits(input).unitsOut).toBe(4096);
  });

  // Site: `Object.hasOwn(input, "duration_secs")` / `own(input, "duration_secs")`.
  it("does not take the video branch on an inherited duration_secs", () => {
    const input = inherited({ duration_secs: 3, width: 100, height: 100 }, "duration_secs");
    expect(declareUnits(input).unitsOut).toBe(100 * 100);
  });

  // Site: `own(input, "num_images")`.
  it("reads no image count from the prototype", () => {
    const input = inherited({ num_images: 4, width: 100, height: 100 }, "num_images");
    expect(declareUnits(input).unitsOut).toBe(100 * 100);
  });

  // Site: `Object.hasOwn(input, "num_images") || Object.hasOwn(input, "width")`.
  it("does not take the image branch on an inherited width alone", () => {
    const input = inherited({ width: 100, height: 100 }, "width");
    expect(declareUnits(input).unitsOut).toBe(4096);
  });

  // Site: `framePixels` — `own(input, "width")` and `own(input, "height")`.
  it("reads no frame dimension from the prototype", () => {
    const input = inherited({ num_images: 2, width: 100, height: 100 }, "height");
    expect(declareUnits(input).unitsOut).toBe(100 * 1024 * 2);
  });

  // Site: `own(input, key)` over the list keys in `assets`.
  it("reads no reference list from the prototype", () => {
    const listed = { b64: "AA==", media_type: "image/png", width: 64, height: 64 };
    const input = inherited({ reference_images: [listed], duration: 5 }, "reference_images");
    expect(declareUnits(input).unitsIn).toBe(0);
  });

  // Site: `own(elements, String(i))` in `assets`.
  it("reads no listed reference from the array's prototype", () => {
    const listed = { b64: "AA==", media_type: "image/png", width: 64, height: 64 };
    const sparse: unknown[] = [];
    sparse.length = 1;
    // Writable, or every `push` onto an empty array anywhere would throw instead.
    Object.defineProperty(Array.prototype, "0", {
      value: listed, configurable: true, writable: true,
    });
    try {
      expect(() => declareUnits({ reference_images: sparse, duration: 5 })).toThrow(
        /reference_images\[0\] must be a reference object/,
      );
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["0"];
    }
  });
});

// ---------------------------------------------------------------------------
// src/verify.ts — verifyRecord
// ---------------------------------------------------------------------------

const verifier = (mode: "mock" | "structural" = "mock") =>
  new Verifier("http://node", { mode, fetch: scriptedNode({ entries: () => ACTIVE }).fetch });

/** An otherwise-honest record whose evidence inherits exactly one field. */
const recordInheriting = (key: string): Record<string, unknown> =>
  record(inherited(evidence(), key));

describe("verifyRecord — an inherited field cannot satisfy a check", () => {
  it("refuses a record with zero own properties", async () => {
    // The shape plan 07 named and never tested: `Object.create(honest)` states
    // nothing at all, and answers every `.` read with the honest record.
    await expect(verifier().verifyRecord(Object.create(record()))).rejects.toThrow(
      /provider record carries no attestation evidence/,
    );
  });

  it("refuses evidence with zero own properties", async () => {
    await expect(verifier().verifyRecord(record(Object.create(evidence())))).rejects.toThrow(
      /unrecognized evidence type undefined/,
    );
  });

  // Site: `own(record, "evidence")`.
  it("reads no evidence block from the prototype", async () => {
    await expect(verifier().verifyRecord(inherited(record(), "evidence"))).rejects.toThrow(
      /carries no attestation evidence/,
    );
  });

  // Site: `own(ev, "type")`.
  it("reads no evidence type from the prototype", async () => {
    await expect(verifier().verifyRecord(recordInheriting("type"))).rejects.toThrow(
      /unrecognized evidence type/,
    );
  });

  // Site: `own(ev, "measurement")`.
  it("reads no measurement from the prototype", async () => {
    await expect(verifier().verifyRecord(recordInheriting("measurement"))).rejects.toThrow(
      /no usable measurement/,
    );
  });

  // Site: `own(record, "box_key")`.
  it("reads no box key from the prototype", async () => {
    await expect(verifier().verifyRecord(inherited(record(), "box_key"))).rejects.toThrow(
      /box_key is not a 32-byte hex/,
    );
  });

  // Site: `own(record, "operator")`.
  it("reads no payee address from the prototype", async () => {
    await expect(verifier().verifyRecord(inherited(record(), "operator"))).rejects.toThrow(
      /operator is not a 20-byte hex/,
    );
  });

  // Site: `own(ev, "report_data")`.
  it("reads no report_data from the prototype", async () => {
    await expect(verifier().verifyRecord(recordInheriting("report_data"))).rejects.toThrow(
      /does not bind this record's box key and payee/,
    );
  });

  // Site: `own(ev, "debug")`.
  it("reads no debug flag from the prototype", async () => {
    await expect(verifier().verifyRecord(recordInheriting("debug"))).rejects.toThrow(
      /does not state a boolean debug flag/,
    );
  });

  // Site: `own(evidence, "tcb")` in `tcbSvn`.
  it("reads no TCB block from the prototype", async () => {
    await expect(verifier().verifyRecord(recordInheriting("tcb"))).rejects.toThrow(
      /carries no TCB version/,
    );
  });

  // Site: `own(tcb, "svn")` in `tcbSvn`.
  it("reads no TCB version from the prototype", async () => {
    const ev = { ...evidence(), tcb: Object.create({ svn: 1 }) as Record<string, unknown> };
    await expect(verifier().verifyRecord(record(ev))).rejects.toThrow(
      /TCB version is not a number/,
    );
  });
});

// ---------------------------------------------------------------------------
// src/verify.ts — verifyEscrowKey
// ---------------------------------------------------------------------------

const escrowVerifier = () =>
  new Verifier("http://node", {
    mode: "mock",
    wallClock: () => NOW,
    fetch: scriptedNode({ entries: () => ESCROW_ACTIVE }).fetch,
  });

/** An otherwise-honest announcement whose evidence inherits exactly one field. */
function announcementInheriting(key: string): Record<string, unknown> {
  const body = announcement();
  body.evidence = inherited(body.evidence as Record<string, unknown>, key);
  return body;
}

describe("verifyEscrowKey — an inherited field cannot satisfy a check", () => {
  it("refuses a measured announcement with zero own properties", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(Object.create(announcement())),
    ).rejects.toThrow(/announced no 32-byte hex escrow_public_key/);
  });

  it("refuses a static announcement with zero own properties", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(Object.create(staticAnnouncement())),
    ).rejects.toThrow(/announced no 32-byte hex escrow_public_key/);
  });

  it("refuses escrow evidence with zero own properties", async () => {
    const body = announcement();
    body.evidence = Object.create(body.evidence as object) as Record<string, unknown>;
    await expect(escrowVerifier().verifyEscrowKey(body)).rejects.toThrow(
      /unrecognized escrow evidence type undefined/,
    );
  });

  // Site: `own(announcement, "escrow_public_key")`.
  it("reads no escrow key from the prototype", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(inherited(announcement(), "escrow_public_key")),
    ).rejects.toThrow(/announced no 32-byte hex escrow_public_key/);
  });

  // Site: `own(announcement, "evidence")`.
  it("reads no escrow evidence block from the prototype", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(inherited(announcement(), "evidence")),
    ).rejects.toThrow(/carries no attestation evidence/);
  });

  // Site: `own(announcement, "issued_at")`.
  it("reads no issued_at from the prototype", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(inherited(announcement(), "issued_at")),
    ).rejects.toThrow(/states no numeric issued_at/);
  });

  // Site: `own(ev, "type")` on the escrow path.
  it("reads no escrow evidence type from the prototype", async () => {
    await expect(escrowVerifier().verifyEscrowKey(announcementInheriting("type"))).rejects.toThrow(
      /unrecognized escrow evidence type/,
    );
  });

  // Site: `own(ev, "measurement")` on the escrow path.
  it("reads no escrow measurement from the prototype", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(announcementInheriting("measurement")),
    ).rejects.toThrow(/no usable measurement/);
  });

  // Site: `own(ev, "report_data")` on the escrow path.
  it("reads no escrow report_data from the prototype", async () => {
    await expect(
      escrowVerifier().verifyEscrowKey(announcementInheriting("report_data")),
    ).rejects.toThrow(/does not bind the escrow key/);
  });

  // Site: `own(ev, "debug")` on the escrow path.
  it("reads no escrow debug flag from the prototype", async () => {
    await expect(escrowVerifier().verifyEscrowKey(announcementInheriting("debug"))).rejects.toThrow(
      /does not state a boolean debug flag/,
    );
  });
});

// ---------------------------------------------------------------------------
// src/verify.ts — verifyCandidates
// ---------------------------------------------------------------------------

describe("verifyCandidates — an inherited field cannot satisfy a check", () => {
  const withRecord = (rec: unknown) =>
    new Verifier("http://node", {
      mode: "mock",
      fetch: scriptedNode({ entries: () => ACTIVE, records: { 7: rec } }).fetch,
    });

  it("drops a candidate with zero own properties", async () => {
    const candidate = Object.create({ provider: 7, box_key: BOX });
    expect(await withRecord(record()).verifyCandidates([candidate])).toEqual([]);
  });

  // Site: `providerPathId(own(candidate, "provider"))`.
  it("reads no provider id from the prototype", async () => {
    const candidate = inherited({ provider: 7, box_key: BOX }, "provider");
    expect(await withRecord(record()).verifyCandidates([candidate])).toEqual([]);
  });

  // Site: `own(candidate, "box_key")` — the seal-target pin.
  it("reads no seal target from the prototype", async () => {
    const candidate = inherited({ provider: 7, box_key: BOX }, "box_key");
    expect(await withRecord(record()).verifyCandidates([candidate])).toEqual([]);
  });

  // Site: `own(rec, "provider")` — the transport echo check.
  //
  // `Response.json` cannot carry a prototype (`JSON.stringify` drops inherited
  // properties), so the shape is injected at the parse boundary — which is
  // where a hostile `Response` implementation would sit anyway.
  it("treats an inherited echo as no echo rather than as a mismatch", async () => {
    const rec = inherited(record(evidence(), 99), "provider");
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/evm/allowlist") return Response.json({ entries: ACTIVE });
      if (path === "/evm/providers/7") {
        return { status: 200, body: null, json: async () => rec } as unknown as Response;
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const pinned = new Verifier("http://node", { mode: "mock", fetch: fetchImpl });
    expect(await pinned.verifyCandidates([{ provider: 7, box_key: BOX }])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// src/verify.ts — the allowlist path
// ---------------------------------------------------------------------------

/**
 * The allowlist reaches `parseAllowlist` and `normalizeEntry` only through
 * `readAllowlist`, which calls `JSON.parse` on the response text itself — so a
 * hostile `fetch` cannot duck-type a prototype-bearing object in, and none of
 * the names these two functions read is on `Object.prototype` as shipped.
 *
 * That is not the end of the argument, which is why these tests exist: a
 * polluted realm supplies any name at all. Each one below fabricates part of an
 * allowlist entry — or the whole envelope — out of `Object.prototype` and
 * asserts that `verifyRecord` refuses anyway. Read with the bare forms, every
 * one of them accepts a measurement that was never on any allowlist.
 */
describe("the allowlist — a polluted prototype cannot fabricate an entry", () => {
  const over = (entries: unknown) =>
    new Verifier("http://node", {
      mode: "mock",
      fetch: scriptedNode({ allowlistBody: () => entries }).fetch,
    });

  // Site: `own(body, "entries")` in `parseAllowlist`.
  it("reads no entries list from the prototype", async () => {
    await pollutedAsync("entries", [{ kind: "image", measurement: MEASUREMENT, status: "active", mock: true }], async () => {
      await expect(over({}).verifyRecord(record())).rejects.toThrow(
        /measurement is not on the allowlist/,
      );
    });
  });

  // Site: `Object.hasOwn(entry, key)` in `normalizeEntry`'s `pick`.
  it("reads no entry field from the prototype", async () => {
    const entries = { entries: [{ measurement: MEASUREMENT, status: "active", mock: true }] };
    await pollutedAsync("kind", "image", async () => {
      await expect(over(entries).verifyRecord(record())).rejects.toThrow(
        /measurement is not on the allowlist/,
      );
    });
  });

  // Site: `own(blob, key)` in `normalizeEntry`'s `pick` — the nested shape.
  it("reads no blob field from the prototype", async () => {
    const entries = { entries: [{ status: 1, entry: { kind: "image", mock: true } }] };
    await pollutedAsync("measurement", MEASUREMENT, async () => {
      await expect(over(entries).verifyRecord(record())).rejects.toThrow(
        /measurement is not on the allowlist/,
      );
    });
  });

  // Site: `own(entry, "entry")` in `normalizeEntry`.
  it("reads no nested entry blob from the prototype", async () => {
    const blob = { kind: "image", measurement: MEASUREMENT, status: "active", mock: true };
    await pollutedAsync("entry", blob, async () => {
      await expect(over({ entries: [{}] }).verifyRecord(record())).rejects.toThrow(
        /measurement is not on the allowlist/,
      );
    });
  });

  // Site: `own(entry, "status")` in `normalizeEntry`.
  it("reads no entry status from the prototype", async () => {
    const entries = { entries: [{ kind: "image", measurement: MEASUREMENT, mock: true }] };
    await pollutedAsync("status", "active", async () => {
      await expect(over(entries).verifyRecord(record())).rejects.toThrow(
        /measurement is not active on the allowlist/,
      );
    });
  });

  // Site: `own(blob, "status")` — the `status ?? blob.status` fallback.
  it("reads no blob status from the prototype", async () => {
    const entries = {
      entries: [{ kind: "image", measurement: MEASUREMENT, mock: true, entry: {} }],
    };
    await pollutedAsync("status", "active", async () => {
      await expect(over(entries).verifyRecord(record())).rejects.toThrow(
        /measurement is not active on the allowlist/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// src/results.ts
// ---------------------------------------------------------------------------

/**
 * The result reader, whose records all come out of `JSON.parse` over bytes a
 * provider produced — and which sits on a **public** path: `JobHandle.result()`
 * → `settledResult()` → `resultFromRaw`.
 *
 * These tests use prototype pollution rather than `Object.create`, because
 * `JSON.parse` is the only way a body gets in here and its products always
 * carry `Object.prototype`. That is not a weaker threat model: it is the *same*
 * bar the `params.ts` schema-lookup sites were fixed to, and the payoff is
 * larger. Read with the bare forms, a polluted `images` turns a text completion
 * into a `MediaResult`, and a polluted `choices` makes `result.text` return
 * attacker-chosen content in place of a confidential inference result.
 */
const RESULT_JOB = {
  id: "job-1",
  result_cid: "cid",
  vorq: { rate_in: "3", rate_out: "7", provider_id: 42, gas_fee: "0.03", fee: "0" },
};
const RESPONSE_BODY = {
  output: [{ content: [{ type: "output_text", text: "hello" }] }],
  usage: { input_tokens: 11, output_tokens: 13 },
};
const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const openResult = (output: unknown, job: Record<string, unknown> = RESULT_JOB) =>
  resultFromRaw(bytesOf(output), job, null);

describe("results — which result class an opened body becomes", () => {
  // Site: `own(output, "object")` in `isEmbedding`.
  it("reads no `object` discriminator from the prototype", () => {
    polluted("object", "list", () => {
      expect(openResult({ ...RESPONSE_BODY, data: [{ embedding: [1] }] })).toBeInstanceOf(TextResult);
    });
  });

  // Site: `own(output, "data")` in `isEmbedding`.
  it("reads no embeddings list from the prototype", () => {
    polluted("data", [{ embedding: [1] }], () => {
      expect(openResult({ ...RESPONSE_BODY, object: "list" })).toBeInstanceOf(TextResult);
    });
  });

  // Site: `Object.hasOwn(entry, "embedding")` in `isEmbedding`.
  it("reads no per-entry embedding from the prototype", () => {
    polluted("embedding", [1], () => {
      expect(openResult({ ...RESPONSE_BODY, object: "list", data: [{}] })).toBeInstanceOf(TextResult);
    });
  });

  // Site: `Object.hasOwn(output, "images")` in `isMedia`.
  it("does not turn a text completion into a MediaResult", () => {
    polluted("images", [{ width: 8, height: 8 }], () => {
      const result = openResult(RESPONSE_BODY);
      expect(result).toBeInstanceOf(TextResult);
      expect((result as TextResult).text).toBe("hello");
    });
  });

  // Site: `Object.hasOwn(output, "video")` in `isMedia`.
  it("does not turn a text completion into a video MediaResult", () => {
    polluted("video", { width: 8, height: 8, duration_secs: 4 }, () => {
      expect(openResult(RESPONSE_BODY)).toBeInstanceOf(TextResult);
    });
  });

  // Site: `Object.hasOwn(body, "choices")` in `resultFromOutput`.
  it("does not route a Responses body through the chat parser", () => {
    polluted("choices", [{ message: { content: "injected" } }], () => {
      expect((openResult(RESPONSE_BODY) as TextResult).text).toBe("hello");
    });
  });

  // Site: `Object.hasOwn(output, "images")` in `mediaResult`.
  it("does not take the image branch of a video result", () => {
    polluted("images", [{ width: 8, height: 8 }], () => {
      const result = openResult({ video: { width: 2, height: 2, duration_secs: 3 } }) as MediaResult;
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]!.duration_secs).toBe(3);
    });
  });

  // Site: `own(output, "enc")` in `decryptOutput`.
  it("does not read a cleartext result as a sealed one", () => {
    polluted("enc", "vorq-sealed-v1", () => {
      expect(openResult(RESPONSE_BODY)).toBeInstanceOf(TextResult);
    });
  });

  // Site: `own(output, "ciphertext")` in `decryptOutput`.
  it("reads no ciphertext from the prototype", () => {
    const cipher = { publicKey: "00".repeat(32), encrypt: (b: Uint8Array) => b, decrypt: () => bytesOf(RESPONSE_BODY) };
    polluted("ciphertext", "eyJhIjoxfQ==", () => {
      expect(() => resultFromRaw(bytesOf({ enc: "vorq-sealed-v1" }), RESULT_JOB, cipher)).toThrow(
        /carries no base64 'ciphertext' member/,
      );
    });
  });
});

describe("results — the fields each result class reads", () => {
  const baseline = (output: unknown, job: Record<string, unknown> = RESULT_JOB) =>
    openResult(output, job);

  // Site: `own(output, "usage")` in `embeddingResult`.
  it("reads no embeddings usage block from the prototype", () => {
    const body = { object: "list", data: [{ embedding: [1] }] };
    polluted("usage", { prompt_tokens: 9_999 }, () => {
      expect((openResult(body) as EmbeddingResult).promptTokens).toBe(0);
    });
  });

  // Site: `own(usage, "prompt_tokens")` in `embeddingResult` and `embeddingCost`.
  it("reads no prompt token count from the prototype", () => {
    const body = { object: "list", data: [{ embedding: [1] }], usage: {} };
    // Taken **outside** the polluted block on purpose: a baseline computed
    // inside it moves with the mutation and the comparison asserts nothing.
    const clean = (baseline(body) as EmbeddingResult).cost;
    polluted("prompt_tokens", 9_999, () => {
      const result = openResult(body) as EmbeddingResult;
      expect(result.promptTokens).toBe(0);
      expect(result.cost).toBe(clean);
    });
  });

  // Site: `own(output, "model")` in `embeddingResult`.
  it("reads no model name from the prototype", () => {
    const body = { object: "list", data: [{ embedding: [1] }], usage: {} };
    polluted("model", "some-other-model", () => {
      expect((openResult(body) as EmbeddingResult).model).toBeNull();
    });
  });

  // Site: `own(output, "seed")` in `mediaResult`.
  it("reads no seed from the prototype", () => {
    const body = { images: [{ width: 4, height: 4 }] };
    polluted("seed", 4242, () => {
      expect((openResult(body) as MediaResult).seed).toBeNull();
    });
  });

  // Site: `own(video, "duration_secs")` in `mediaResult`.
  it("reads no video duration from the prototype", () => {
    const body = { video: { width: 4, height: 4 } };
    const clean = (baseline(body) as MediaResult).cost;
    polluted("duration_secs", 9_999, () => {
      expect((openResult(body) as MediaResult).cost).toBe(clean);
    });
  });

  // Site: `own(frame, "width")` / `own(frame, "height")` in `framePixels`.
  it("reads no frame dimension from the prototype", () => {
    const body = { images: [{}] };
    const clean = (baseline(body) as MediaResult).cost;
    polluted("width", 8, () => {
      expect((openResult(body) as MediaResult).cost).toBe(clean);
    });
  });

  // Site: `own(response, "output")` in `textResultFromResponse`.
  it("reads no Responses output list from the prototype", () => {
    polluted("output", [{ content: [{ type: "output_text", text: "injected" }] }], () => {
      expect((openResult({ usage: {} }) as TextResult).text).toBe("");
    });
  });

  // Site: `own(response, "usage")` in `textResultFromResponse`.
  it("reads no Responses usage block from the prototype", () => {
    const body = { output: [] };
    const clean = (baseline(body) as TextResult).cost;
    polluted("usage", { input_tokens: 9_999, output_tokens: 9_999 }, () => {
      expect((openResult(body) as TextResult).cost).toBe(clean);
    });
  });

  // Site: `own(asRecord(item), "content")` in `flattenResponseOutput`.
  it("reads no output-item content from the prototype", () => {
    polluted("content", [{ type: "output_text", text: "injected" }], () => {
      expect((openResult({ output: [{}], usage: {} }) as TextResult).text).toBe("");
    });
  });

  // Site: `own(record, "type")` in `flattenResponseOutput`.
  it("reads no content-part type from the prototype", () => {
    polluted("type", "output_text", () => {
      const body = { output: [{ content: [{ text: "injected" }] }], usage: {} };
      expect((openResult(body) as TextResult).text).toBe("");
    });
  });

  // Site: `own(record, "text")` in `flattenResponseOutput`.
  it("reads no content-part text from the prototype", () => {
    polluted("text", "injected", () => {
      const body = { output: [{ content: [{ type: "output_text" }] }], usage: {} };
      expect((openResult(body) as TextResult).text).toBe("");
    });
  });

  // Sites: `own(usage, "input_tokens")` / `own(usage, "output_tokens")` in `textCost`.
  //
  // `textResultFromResponse` hands `textCost` a **spread copy** of the wire's
  // usage block, and a spread is not a defence: `{ ...record }` copies own
  // properties into a literal that still inherits from `Object.prototype`, so a
  // key the copy lacks is still answered by a polluted prototype. Read bare,
  // this chose the displayed cost of somebody's job on the public
  // `JobHandle.result()` path.
  it("reads no input token count from the prototype", () => {
    const body = { output: [], usage: { output_tokens: 2 } };
    const clean = (baseline(body) as TextResult).cost;
    polluted("input_tokens", 9_999_999, () => {
      expect((openResult(body) as TextResult).cost).toBe(clean);
    });
  });

  it("reads no output token count from the prototype", () => {
    const body = { output: [], usage: { input_tokens: 2 } };
    const clean = (baseline(body) as TextResult).cost;
    polluted("output_tokens", 9_999_999, () => {
      expect((openResult(body) as TextResult).cost).toBe(clean);
    });
  });

  it("still costs the token counts the body does carry", () => {
    // The other direction, so the fix cannot be "stop reading usage": own keys
    // are still priced. 11 in at rate_in 3 + 13 out at rate_out 7 over 1e6.
    expect((openResult(RESPONSE_BODY) as TextResult).cost).toBe("0.000124");
  });

  // Site: `own(asRecord(choice), "message")` in `textResultFromChatCompletion`.
  it("reads no choice message from the prototype", () => {
    polluted("message", { content: "injected" }, () => {
      expect((openResult({ choices: [{}] }) as TextResult).text).toBe("");
    });
  });

  // Site: `own(…, "content")` in `textResultFromChatCompletion`.
  it("reads no chat message content from the prototype", () => {
    polluted("content", "injected", () => {
      expect((openResult({ choices: [{ message: {} }] }) as TextResult).text).toBe("");
    });
  });

  // Site: `own(body, "usage")` in `textResultFromChatCompletion`.
  it("reads no chat usage block from the prototype", () => {
    const body = { choices: [] };
    const clean = (baseline(body) as TextResult).cost;
    polluted("usage", { prompt_tokens: 9_999, completion_tokens: 9_999 }, () => {
      expect((openResult(body) as TextResult).cost).toBe(clean);
    });
  });

  // Site: `own(rawUsage, "prompt_tokens")` in `textResultFromChatCompletion`.
  it("reads no chat token counts from the prototype", () => {
    const body = { choices: [], usage: {} };
    const clean = (baseline(body) as TextResult).cost;
    polluted("prompt_tokens", 9_999, () => {
      expect((openResult(body) as TextResult).cost).toBe(clean);
    });
  });
});

describe("results — the job row a result is priced and labelled from", () => {
  // Site: `own(job, "vorq")` in `resultFromOutput`.
  it("reads no vorq block from the prototype", () => {
    // Read bare, the inherited block supplies the gas fee the row lacks and the
    // result builds as provider 99's. Guarded, the row has no block and no fee.
    polluted("vorq", { provider_id: 99, rate_in: "9", rate_out: "9", gas_fee: "0.03", fee: "0" }, () => {
      expect(() => openResult(RESPONSE_BODY, { id: "job-1", result_cid: "cid" })).toThrow(
        /gas_fee=undefined/,
      );
    });
  });

  // Site: `own(vorq, "rate_in")` / `own(vorq, "rate_out")` in `resultFromOutput`.
  it("reads no rates from the prototype", () => {
    const job = { id: "job-1", result_cid: "cid", vorq: { gas_fee: "0.03", fee: "0" } };
    const clean = (openResult(RESPONSE_BODY, job) as TextResult).cost;
    polluted("rate_in", "9999", () => {
      expect((openResult(RESPONSE_BODY, job) as TextResult).cost).toBe(clean);
    });
  });

  // Site: `own(vorq, "fee")` in `resultFromOutput`.
  it("reads no protocol fee from the prototype", () => {
    const job = { id: "job-1", result_cid: "cid", vorq: { gas_fee: "0.03" } };
    polluted("fee", "0", () => {
      expect(() => openResult(RESPONSE_BODY, job)).toThrow(/the node sent fee=undefined/);
    });
  });

  // Site: `own(vorq, "provider_id")` in `resultFromOutput`.
  it("reads no job provider id from the prototype", () => {
    const job = { id: "job-1", result_cid: "cid", vorq: { gas_fee: "0.03", fee: "0" } };
    polluted("provider_id", 99, () => {
      expect(openResult(RESPONSE_BODY, job).provider).toBeNull();
    });
  });

  // Site: `own(job, "id")` in `resultFromOutput`.
  it("reads no job id from the prototype", () => {
    const job = { result_cid: "cid", vorq: { gas_fee: "0.03", fee: "0" } };
    polluted("id", "some-other-job", () => {
      expect(openResult(RESPONSE_BODY, job).jobId).toBeNull();
    });
  });

  // Site: `own(output, "vorq")` — the provider's correlation stamp.
  it("reads no correlation stamp from the prototype", () => {
    polluted("vorq", { custom_id: "injected" }, () => {
      const job = { id: "job-1", result_cid: "cid", vorq: { gas_fee: "0.03", fee: "0" } };
      expect(openResult(RESPONSE_BODY, job).customId).toBeNull();
    });
  });

  // Site: `own(stamp, "custom_id")` in `resultFromOutput`.
  it("reads no custom id from the prototype", () => {
    polluted("custom_id", "injected", () => {
      expect(openResult({ ...RESPONSE_BODY, vorq: { job_id: "x" } }).customId).toBeNull();
    });
  });

  // Site: `own(job, "result_cid")` in `resultFromRaw`.
  it("reads no result CID from the prototype", () => {
    polluted("result_cid", "some-other-cid", () => {
      // The CID names the bytes in the error a caller sees; reading one off the
      // prototype would quote a name the row never carried.
      expect(() => resultFromRaw(new TextEncoder().encode("not json"), { vorq: {} }, null)).toThrow(
        /CID "" are not JSON/,
      );
    });
  });
});

describe("results — a batch output row", () => {
  const line = (fields: Record<string, unknown>) => resultFromBatchLine(fields, null, bytesOf(RESPONSE_BODY));

  // Site: `Object.hasOwn(line, "vorq")` / `own(line, "vorq")` in `resultFromBatchLine`.
  it("reads no row vorq block from the prototype", () => {
    polluted("vorq", { job_id: "injected" }, () => {
      expect((line({ id: "row-1", error: { message: "boom" } }) as JobError).jobId).toBe("row-1");
    });
  });

  // Site: `own(line, "vorq")` — the value read, not the membership test above.
  //
  // Its own test, because the membership test short-circuits the one above: a
  // row with no own `vorq` must find no `result_cid` either, rather than open
  // bytes named by the prototype.
  it("reads no row vorq value from the prototype", () => {
    polluted("vorq", { result_cid: "cid", provider: 9 }, () => {
      expect(() => line({})).toThrow(/reports success and names no/);
    });
  });

  // Site: `own(vorq, "job_id")` in `resultFromBatchLine`.
  it("reads no row job id from the prototype", () => {
    polluted("job_id", "injected", () => {
      expect((line({ vorq: {}, error: { message: "boom" } }) as JobError).jobId).toBeNull();
    });
  });

  // Site: `own(line, "id")` — the row-id fallback.
  it("reads no fallback row id from the prototype", () => {
    polluted("id", "injected", () => {
      expect((line({ error: { message: "boom" } }) as JobError).jobId).toBeNull();
    });
  });

  // Site: `own(line, "error")` in `resultFromBatchLine`.
  it("reads no error block from the prototype", () => {
    polluted("error", { message: "boom" }, () => {
      expect(line({ vorq: { result_cid: "cid", gas_fee: "0.03", fee: "0" } })).not.toBeInstanceOf(JobError);
    });
  });

  // Site: `own(error, "message")` in `resultFromBatchLine`.
  it("reads no error message from the prototype", () => {
    polluted("message", "injected", () => {
      expect((line({ error: { code: "bad" } }) as JobError).message).toBe("");
    });
  });

  // Site: `own(error, "code")` in `resultFromBatchLine`.
  it("reads no error code from the prototype", () => {
    polluted("code", "injected", () => {
      expect((line({ error: { message: "boom" } }) as JobError).type).toBe("unknown");
    });
  });

  // Site: `own(line, "custom_id")` in `resultFromBatchLine`.
  it("reads no row custom id from the prototype", () => {
    polluted("custom_id", "injected", () => {
      expect((line({ error: { message: "boom" } }) as JobError).customId).toBeNull();
    });
  });

  // Site: `own(vorq, "result_cid")` in `resultFromBatchLine`.
  it("reads no row result CID from the prototype", () => {
    polluted("result_cid", "injected", () => {
      expect(() => line({ vorq: {} })).toThrow(ResultIntegrityError);
    });
  });

  // Site: `own(line, "id")` inside that refusal's message.
  it("names no row id from the prototype in the refusal", () => {
    polluted("id", "injected", () => {
      expect(() => line({ vorq: {} })).toThrow(/batch row null reports success/);
    });
  });

  // Site: `own(vorq, "provider")` in the terms `resultFromBatchLine` forwards.
  it("reads no row provider from the prototype", () => {
    polluted("provider", 99, () => {
      expect((line({ vorq: { result_cid: "cid", gas_fee: "0.03", fee: "0" } }) as TextResult).provider).toBeNull();
    });
  });

  // Site: `own(vorq, "rate_in")` / `own(vorq, "rate_out")` in the same terms.
  it("reads no row rates from the prototype", () => {
    const row = { vorq: { result_cid: "cid", gas_fee: "0.03", fee: "0" } };
    const clean = (line(row) as TextResult).cost;
    polluted("rate_in", "9999", () => {
      expect((line(row) as TextResult).cost).toBe(clean);
    });
  });

  // Site: `own(vorq, "gas_fee")` in `resultFromBatchLine`.
  it("reads no row gas fee from the prototype", () => {
    polluted("gas_fee", "0.03", () => {
      expect(() => line({ vorq: { result_cid: "cid" } })).toThrow(/gas_fee=undefined/);
    });
  });

  // Site: `own(vorq, "fee")` in `resultFromBatchLine`.
  it("reads no row protocol fee from the prototype", () => {
    polluted("fee", "0", () => {
      expect(() => line({ vorq: { result_cid: "cid", gas_fee: "0.03" } })).toThrow(/the node sent fee=undefined/);
    });
  });
});

// ---------------------------------------------------------------------------
// src/client.ts — the 409 refusal
// ---------------------------------------------------------------------------

describe("client — telling a re-quote from a refusal", () => {
  // Site: `Object.hasOwn(refusal, "quote")` in `Client.submit`.
  //
  // The two 409s are told apart by body. A bare `in` lets a polluted
  // `Object.prototype.quote` route the chain's flat refusal into the re-quote
  // branch, where it is read as a quote the node never sent.
  it("reads no quote from the prototype on a 409", async () => {
    const jobsRoute: Route = [
      /\/v1\/jobs$/,
      (n, body) =>
        n === 1
          ? json(quoted(body), 402)
          : json({ error: { message: "DuplicateJob", code: "DuplicateJob" } }, 409),
    ];
    const { client: c } = client([...baseRoutes(), jobsRoute]);
    await pollutedAsync("quote", QUOTE("0x1", 0n).quote, async () => {
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /DuplicateJob/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// src/jobs.ts — the end cause
// ---------------------------------------------------------------------------

describe("endCause — the reason a job ended", () => {
  // Sites: `own(job, "vorq")` and `own(vorq, "ended_because")` in `endCause`.
  //
  // Read bare, a polluted prototype names an end cause for a row that named
  // none — and `openai-compat.ts` renders that as the job's `error`, so the
  // caller is told *why* a job failed on the strength of a key nobody sent.
  it("reads no vorq block from a job row's prototype", () => {
    polluted("vorq", { ended_because: 2 }, () => {
      expect(endCause({ id: "j1" })).toBeNull();
    });
  });

  it("reads no ended_because from the prototype", () => {
    polluted("ended_because", 2, () => {
      expect(endCause({ id: "j1", vorq: {} })).toBeNull();
    });
  });

  it("still reports a cause the row actually carries", () => {
    // The other direction, so the fix cannot be "stop reading".
    expect(endCause({ vorq: { ended_because: 2 } })).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// src/openai-compat.ts — the sealed OpenAI transport
// ---------------------------------------------------------------------------

/** Where the `openai` package thinks it is talking to. */
const AT = "https://compat.test";
/** A pinned clock, so `created_at` is an assertion rather than a range check. */
const COMPAT_NOW = () => 1_790_000_000;

const render = (
  job: Record<string, unknown>,
  options: Partial<Parameters<typeof responseObject>[1]> = {},
): Record<string, unknown> =>
  responseObject(job, { background: false, now: COMPAT_NOW, ...options });

/**
 * The coordinator's answer is `JSON.parse` output, and every field of it that
 * `responseObject` renders is read own-properties only.
 *
 * These are pure-function tests on purpose: `responseObject` is exported, and
 * the retrieve path below drives the same function through a real fetch. A test
 * here reddens for this function's own site and nothing else.
 */
describe("openai-compat — the job row a Response is rendered from", () => {
  // Site: `own(job, "status")` in `responseObject`.
  it("reads no status from the prototype", () => {
    // `"completed"` from the prototype reports every queued job settled — with
    // an empty output, because nothing was ever fetched.
    polluted("status", "completed", () => {
      expect(render({ id: "j1" }).status).toBe("queued");
    });
  });

  // Site: `own(job, "id")` in `responseObject`.
  it("reads no id from the prototype", () => {
    // The row spells it `job_id`; a polluted `id` would win the `||` and the
    // caller would get back a handle to a job nobody submitted.
    polluted("id", "0xnobodys-job", () => {
      expect(render({ job_id: "0xtherealone" }).id).toBe("0xtherealone");
    });
  });

  // Site: `own(job, "job_id")` in `responseObject`.
  it("reads no job_id from the prototype", () => {
    polluted("job_id", "0xnobodys-job", () => {
      expect(() => render({})).toThrow(/named no job/);
    });
  });

  // Site: `own(job, "model")` in `responseObject`.
  it("reads no model from the prototype", () => {
    // `model: null` stated **own** on the options record, so the options site
    // below is satisfied without reading anything and this test reddens for the
    // job-row read alone.
    polluted("model", "somebody-elses-model", () => {
      expect(render({ id: "j1" }, { model: null }).model).toBeNull();
    });
  });

  // Site: `own(opts, "model")` in `responseObject`'s options record.
  //
  // A destructuring default is not a guard: `{ model = null }` fires only on
  // `undefined`, and an inherited property is not undefined. The cancel path
  // renders with `{ background: true }` and names no model at all, so this read
  // was answered entirely by the prototype.
  it("reads no model from the options record's prototype", () => {
    polluted("model", "somebody-elses-model", () => {
      expect(render({ id: "j1", model: "the-row-model" }).model).toBe("the-row-model");
    });
  });

  // Site: `own(opts, "now")` in `responseObject`'s options record.
  it("reads no clock from the options record's prototype", () => {
    polluted("now", () => 1, () => {
      const out = responseObject({ id: "j1" }, { background: false });
      expect(out.created_at as number).toBeGreaterThan(1_700_000_000);
    });
  });

  // Site: `own(opts, "background")` in `responseObject`'s options record.
  it("reads no background flag from the options record's prototype", () => {
    polluted("background", true, () => {
      expect(responseObject({ id: "j1" }, {} as never).background).toBe(false);
    });
  });

  // Site: `own(opts, "result")` in `responseObject`'s options record.
  it("reads no result from the options record's prototype", () => {
    // An inherited `result` reports a job **completed**, with output the
    // coordinator never settled, on a row that says `queued`.
    const result = new TextResult({
      text: "content nobody settled",
      output: [],
      usage: {},
      raw: {},
      rates: { rateIn: null, rateOut: null },
      cost: "0.0",
      gasFee: "0.03",
      fee: "0",
      provider: 1,
      jobId: "0xabc",
      customId: null,
    });
    polluted("result", result, () => {
      expect(render({ id: "j1" }).status).toBe("queued");
    });
  });

  // Site: `own(job, "created_at")` in `responseObject`.
  it("reads no created_at from the job row's prototype", () => {
    polluted("created_at", 1_600_000_000, () => {
      expect(render({ id: "j1" }).created_at).toBe(1_790_000_000);
    });
  });

  // Site: `own(job, "metadata")` in `responseObject`.
  it("reads no metadata from the prototype", () => {
    polluted("metadata", { linked: "wallet" }, () => {
      expect(render({ id: "j1" }).metadata).toEqual({});
    });
  });

  // Site: `own(job, "vorq")` in `responseObject`.
  it("reads no vorq block from a rendered job row's prototype", () => {
    polluted("vorq", { rate_in: "999" }, () => {
      expect(render({ id: "j1" }).vorq).toEqual({});
    });
  });

  // Site: `own(job, "error")` in `responseObject`.
  it("reads no error object from the prototype", () => {
    polluted("error", { code: "invented", message: "invented" }, () => {
      expect(Object.hasOwn(render({ id: "j1", status: "failed" }), "error")).toBe(false);
    });
  });

  // Site: `own(error, "code")` in `responseObject`.
  it("reads no rendered error code from the prototype", () => {
    // The row carries an `error` object that names nothing. A polluted `code`
    // fills it in, and the caller is told a cause the coordinator never gave.
    polluted("code", "invented", () => {
      expect(Object.hasOwn(render({ id: "j1", status: "failed", error: {} }), "error")).toBe(false);
    });
  });

  // Site: `own(result.usage, key)` in `responseObject`'s `count`.
  it("reads no token count from the prototype", () => {
    // `result.usage` is a literal built by spreading the provider's own usage
    // record (`results.ts`), so it still inherits from `Object.prototype`.
    const result = new TextResult({
      text: "the sealed answer",
      output: [],
      usage: {},
      raw: {},
      rates: { rateIn: null, rateOut: null },
      cost: "0.0",
      gasFee: "0.03",
      fee: "0",
      provider: 1,
      jobId: "0xabc",
      customId: null,
    });
    polluted("input_tokens", 99, () => {
      const usage = render({ id: "j1" }, { result }).usage as Record<string, number>;
      expect(usage.input_tokens).toBe(0);
    });
  });
});

/**
 * `sealingFetch`'s own options object is the caller's, and the rule covers it.
 *
 * This is the most consequential application of the rule in the package: the
 * `client` and the `fetch` a transport is built on decide where every sealed
 * prompt goes.
 */
describe("openai-compat — building the transport", () => {
  // Site: `own(opts, "client")` in `sealingFetch`.
  it("adopts no client from the prototype", () => {
    // Read bare, the prototype's object is truthy, so this caller — who passed
    // construction options and no client — is refused for passing "both"; and
    // had they passed nothing at all, that object would have become the client
    // every prompt was sealed through.
    polluted("client", { submit: () => undefined }, () => {
      expect(() => sealingFetch({ baseUrl: "http://node" })).not.toThrow();
    });
  });

  // Site: `stated(key)` in `sealingFetch` — the `supplied` filter.
  it("counts no construction option from the prototype", () => {
    const { client: c } = client([]);
    polluted("baseUrl", "http://elsewhere", () => {
      expect(() => sealingFetch({ client: c })).not.toThrow();
    });
  });

  // Site: `stated(key)` again, on the client it builds. Shares its guard with
  // the test above — reverting `stated` reddens both.
  it("builds the client from no construction option on the prototype", async () => {
    const { impl, calls } = scriptedFetch([...baseRoutes(), [/\/v1\/models/, () => json(MODELS)]]);
    await pollutedAsync("baseUrl", "http://elsewhere.invalid", async () => {
      await sealingFetch({ fetch: impl })(`${AT}/v1/models`);
    });
    expect(calls).not.toHaveLength(0);
    expect(calls.every((c) => c.url.startsWith(DEFAULT_BASE_URL))).toBe(true);
  });
});

/**
 * `normalize` reads the caller's `init`, and the two fields it reads decide
 * which route ran and what bytes went with it.
 */
describe("openai-compat — normalizing the caller's request", () => {
  // Site: `stated("method")` in `normalize`.
  it("reads no method from the prototype", () => {
    const { client: c } = client([...baseRoutes(), [/\/v1\/models/, () => json(MODELS)]]);
    return pollutedAsync("method", "POST", async () => {
      // `GET /v1/models` forwards; `POST /v1/models` is on no list and is
      // refused. A polluted verb turns every honest read into a 400.
      const response = await sealingFetch({ client: c })(`${AT}/v1/models`, {});
      expect(response.status).toBe(200);
    });
  });

  // Site: `stated("body")` in `normalize`'s `readBody`.
  it("reads no request body from the prototype", async () => {
    const { client: c, calls } = client([
      ...baseRoutes(),
      [/\/v1\/models/, () => json(MODELS)],
    ]);
    await pollutedAsync("body", JSON.stringify({ injected: true }), async () => {
      await sealingFetch({ client: c })(`${AT}/v1/models`, {});
    });
    // Bytes nobody wrote, forwarded to the coordinator under the caller's name.
    // Asserted on the `RequestInit` the SDK built, and asserted **outside** the
    // pollution: `scriptedFetch` reads `init.body` bare, so its own parsed copy
    // is the harness reading the prototype, not the transport doing so.
    expect(calls.at(-1)!.init.body).toBeUndefined();
  });
});

/**
 * The create path: the body off `JSON.parse`, and the `vorq` block inside it.
 *
 * Driven through the real `sealingFetch` with `client.submit` captured rather
 * than run — the order that reached `submit` is exactly what the finding
 * measured, and it is what a signed, settled term is read off.
 */
describe("openai-compat — the create body and its vorq block", () => {
  /** `sealingFetch` over a client whose `submit` records its args. */
  function capturing() {
    const { client: c } = client([]);
    const submitted: Record<string, unknown>[] = [];
    const handle = {
      id: "0xjob",
      row: {},
      result: async () =>
        new TextResult({
          text: "the sealed answer",
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          raw: {},
          rates: { rateIn: null, rateOut: null },
          cost: "0.0",
          gasFee: "0.03",
          fee: "0",
          provider: 1,
          jobId: "0xjob",
          customId: null,
        }),
    } as unknown as JobHandle;
    vi.spyOn(c, "submit").mockImplementation(async (args) => {
      submitted.push(args as unknown as Record<string, unknown>);
      return handle;
    });
    return { submitted, fetch: sealingFetch({ client: c }) };
  }

  const post = (fetch: SealingFetch, body: unknown) =>
    fetch(`${AT}/v1/responses`, { method: "POST", body: JSON.stringify(body) });

  // Site: `own(body, "model")` in `create`.
  it("reads no model from the create body's prototype", async () => {
    const h = capturing();
    const response = await pollutedAsync("model", "m", () => post(h.fetch, { input: "hi" }));
    expect(h.submitted).toEqual([]);
    expect(response.status).toBe(400);
  });

  // Site: `own(body, "stream")` in `create`.
  it("reads no stream flag from the create body's prototype", async () => {
    // A polluted `stream` refuses every create on this surface: denial of
    // service over a field nobody sent.
    const h = capturing();
    const response = await pollutedAsync("stream", true, () =>
      post(h.fetch, { model: "m", input: "hi" }),
    );
    expect(response.status).toBe(200);
    expect(h.submitted).toHaveLength(1);
  });

  // Site: `own(body, "metadata")` in `create`.
  it("reads no metadata from the create body's prototype", async () => {
    const h = capturing();
    const response = await pollutedAsync("metadata", { k: "v" }, () =>
      post(h.fetch, { model: "m", input: "hi" }),
    );
    expect(response.status).toBe(200);
  });

  // Site: `own(body, "background")` in `create`.
  it("reads no background flag from the create body's prototype", async () => {
    const h = capturing();
    const response = await pollutedAsync("background", true, () =>
      post(h.fetch, { model: "m", input: "hi" }),
    );
    // Backgrounded from the prototype, the caller gets `queued` and never the
    // answer they synchronously asked for.
    expect(((await response.json()) as Record<string, unknown>).background).toBe(false);
  });

  // Site: `own(body, "vorq")` in `create`.
  it("reads no vorq block from the create body's prototype", async () => {
    const h = capturing();
    await pollutedAsync("vorq", { provider: 7, sla: "720h", max_rate_in: "999" }, () =>
      post(h.fetch, { model: "m", input: "hi" }),
    );
    const args = h.submitted[0]!;
    expect(Object.hasOwn(args, "provider")).toBe(false);
    expect(args.sla).toBe("1h");
    expect(args.maxRateIn).toBeNull();
  });

  // Site: `own(block, "provider")` in `create` (D20).
  it("reads no provider from the prototype", async () => {
    // **The serious one.** A provider on the order designates it, and a
    // designated order is sealed to that operator's box key instead of the
    // coordinator's escrow key: a change of who can read the payload, made on
    // a key the caller never sent. The D20 guard above cannot see it — it
    // refuses a wrong-*typed* own value, and the prototype supplies a number.
    const h = capturing();
    await pollutedAsync("provider", 7, () => post(h.fetch, { model: "m", input: "hi", vorq: {} }));
    expect(Object.hasOwn(h.submitted[0]!, "provider")).toBe(false);
  });

  // Site: `own(block, "sla")` in `create` (D19).
  it("reads no sla from the prototype", async () => {
    // A signed, settled term: a window from the prototype is a window this SDK
    // signs on the caller's behalf.
    const h = capturing();
    await pollutedAsync("sla", "720h", () => post(h.fetch, { model: "m", input: "hi", vorq: {} }));
    expect(h.submitted[0]!.sla).toBe("1h");
  });

  // Site: `own(block, "max_rate_in")` in `create`.
  it("reads no input ceiling from the prototype", async () => {
    const h = capturing();
    await pollutedAsync("max_rate_in", "999", () => post(h.fetch, { model: "m", input: "hi", vorq: {} }));
    expect(h.submitted[0]!.maxRateIn).toBeNull();
  });

  // Site: `own(block, "max_rate_out")` in `create`.
  it("reads no output ceiling from the prototype", async () => {
    const h = capturing();
    await pollutedAsync("max_rate_out", "999", () =>
      post(h.fetch, { model: "m", input: "hi", vorq: {} }),
    );
    expect(h.submitted[0]!.maxRateOut).toBeNull();
  });

  // Site: `own(payload, "input")` in `create`.
  it("seals no messages array from the prototype", async () => {
    // The spread that builds `payload` copies own properties into a literal
    // that still inherits, so a polluted `input` is sealed into the payload as
    // `messages` — content the caller never wrote, on its way to a provider.
    const h = capturing();
    await pollutedAsync("input", [{ role: "user", content: "injected" }], () =>
      post(h.fetch, { model: "m", temperature: 0.2 }),
    );
    expect(h.submitted[0]!.input).toEqual({ temperature: 0.2 });
  });
});

/** The retrieve and cancel paths: the query bag, and the cancel receipt. */
describe("openai-compat — retrieve and cancel", () => {
  const JOB = `0x${"ab".repeat(32)}`;
  const row = (extra: Record<string, unknown>): Route => [
    /\/v1\/jobs\/[^/?]+$/,
    () => json({ id: JOB, vorq: { gas_fee: "0.03", fee: "0" }, ...extra }),
  ];

  // Site: `own(params, "stream")` in `retrieve`.
  it("reads no stream flag from the query bag's prototype", async () => {
    // `params` is an object literal built in `normalize` from the query string,
    // so it inherits like any other. A polluted `stream` refuses every retrieve.
    const { client: c } = client([...baseRoutes(), row({ status: "queued" })]);
    await pollutedAsync("stream", "true", async () => {
      const response = await sealingFetch({ client: c })(`${AT}/v1/responses/${JOB}`);
      expect(response.status).toBe(200);
    });
  });

  // Site: `own(job, "status")` in `retrieve`.
  it("reads no status from the fetched row's prototype", async () => {
    // The row names no status and no result. Read bare, `"completed"` from the
    // prototype sends the retrieve down the settled-result path, which fails on
    // a job that named nothing to fetch — a 400 for a healthy queued job.
    const { client: c } = client([...baseRoutes(), row({})]);
    await pollutedAsync("status", "completed", async () => {
      const response = await sealingFetch({ client: c })(`${AT}/v1/responses/${JOB}`);
      expect(response.status).toBe(200);
    });
  });

  // Site: `own(job, "model")` in `retrieve`.
  //
  // **This is one of the file's two shared-revert tests**: `responseObject`
  // reads the same key off the same row one call later, so reverting either
  // site reddens this. The pure `render` test above isolates the other one.
  it("reads no model from the fetched row's prototype", async () => {
    const { client: c } = client([...baseRoutes(), row({ status: "queued" })]);
    await pollutedAsync("model", "somebody-elses-model", async () => {
      const response = await sealingFetch({ client: c })(`${AT}/v1/responses/${JOB}`);
      expect(((await response.json()) as Record<string, unknown>).model).toBeNull();
    });
  });

  // Site: `own(receipt, "job_id")` in `cancel`.
  it("reads no job_id from the cancel receipt's prototype", async () => {
    // A 2xx whose body names no job must be named as such. Read bare, a
    // polluted `job_id` reports a cancel of some other id as if the chain had
    // ended it.
    const { client: c } = client([
      ...baseRoutes(),
      [/\/v1\/jobs\/[^/]+\/cancel$/, () => json({})],
    ]);
    await pollutedAsync("job_id", "0xnobodys-job", async () => {
      const response = await sealingFetch({ client: c })(`${AT}/v1/responses/${JOB}/cancel`, {
        method: "POST",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/named no job_id/);
    });
  });
});

// ---------------------------------------------------------------------------
// src/transport.ts — the caller's request options
// ---------------------------------------------------------------------------

describe("transport — the options record a request is issued from", () => {
  // Site: `stated(key)` in `Transport.request` — one guard over all six reads
  // (`retry`, `allowStatuses`, `headers`, `body`, `json`, `params`), so one
  // test reddens it.
  //
  // `Client.request` is public API, so this record arrives from a caller, and
  // the `body`/`json` pair is the sharp end: read bare, a polluted prototype
  // puts bytes nobody wrote on the wire under this session's token — on a
  // request whose caller passed no body at all.
  it("puts no body from the prototype on the wire", async () => {
    const { client: c, calls } = client([...baseRoutes(), [/\/v1\/models/, () => json(MODELS)]]);
    await pollutedAsync("body", JSON.stringify({ injected: true }), async () => {
      await c.request("GET", "/v1/models");
    });
    expect(calls.at(-1)!.init.body).toBeUndefined();
  });

  // The other direction, so the fix cannot be "stop sending bodies".
  it("still sends a body the caller actually stated", async () => {
    const { client: c, calls } = client([...baseRoutes(), [/\/v1\/models/, () => json(MODELS)]]);
    await c.request("POST", "/v1/models", { json: { stated: true } });
    expect(calls.at(-1)!.body).toEqual({ stated: true });
  });
});

// ---------------------------------------------------------------------------
// src/batches.ts — the caller's request lines and options
// ---------------------------------------------------------------------------

/**
 * A batch line arrives from the caller's array or from `JSON.parse` over a
 * JSONL file, and both are in scope. `rate_in`/`rate_out` on a line's body are
 * **signed, settled terms** — the batch path's version of the create-body
 * finding — and `providers` decides who each line is sealed to.
 *
 * Every test drives the real `Batches.submit`; the sealing-loop tests read the
 * args that reached `Client.sealLine`, which is where a term becomes signed.
 */
describe("batches — the lines and options a submit is built from", () => {
  /** A catalog that publishes a schema `checkInput` throws on. */
  const BANNING_CATALOG = {
    data: [
      {
        id: "m",
        object: "model",
        vorq: { model_id: 7, params_schema: { properties: { banned: false } } },
      },
    ],
  };

  // Site: `own(line, "url")` in `endpointOf`.
  it("reads no endpoint from a line's prototype", async () => {
    // Every line in the file would agree on an endpoint nobody wrote, and a
    // batch is metered and settled by its endpoint.
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("url", "/v1/embeddings", async () => {
      await h.client.batches.submit([{ body: PRICED_LINE }], "1h", { providers: [1] });
    });
    expect(h.creates[0]!.endpoint).toBe("/v1/responses");
  });

  // Site: `own(line, "custom_id")` in the pre-flight loop.
  it("reads no custom_id from a line's prototype when checking for duplicates", async () => {
    // Read bare, every line carries the same inherited id, so the second line
    // of every batch is a "duplicate" — a refusal of an honest file.
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("custom_id", "inherited", async () => {
      await expect(
        h.client.batches.submit([{ body: PRICED_LINE }, { body: PRICED_LINE }], "1h", {
          providers: [1],
        }),
      ).resolves.toBeDefined();
    });
  });

  // Site: `own(line, "custom_id")` in the sealing loop.
  it("seals no custom_id from a line's prototype", async () => {
    // One line, so the duplicate check above cannot fire and this test pins the
    // second read on its own. A `custom_id` is stamped into the sealed line and
    // comes back on the result: an inherited one labels somebody's job.
    const h = batchHarness({ gasFee: 7n });
    const sealLine = vi.spyOn(h.client, "sealLine");
    await pollutedAsync("custom_id", "inherited", async () => {
      await h.client.batches.submit([{ body: PRICED_LINE }], "1h", { providers: [1] });
    });
    expect(sealLine.mock.calls[0]![0].customId).toBeUndefined();
  });

  // Site: `own(line, "body")` in the pre-flight loop.
  it("reads no body from a line's prototype", async () => {
    // A line with no body would pass validation and be sealed from a body the
    // caller never wrote.
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("body", { model: "m" }, async () => {
      await expect(
        h.client.batches.submit([{ custom_id: "a" }] as unknown as Record<string, unknown>[], "1h", {
          providers: [1],
        }),
      ).rejects.toThrow(/body.model is required/);
    });
    expect(h.calls).toHaveLength(0);
  });

  // Site: `own(body, "model")` in the pre-flight loop.
  it("reads no model from a body's prototype", async () => {
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("model", "m", async () => {
      await expect(
        h.client.batches.submit([{ body: {} }], "1h", { providers: [1] }),
      ).rejects.toThrow(/body.model is required/);
    });
    expect(h.calls).toHaveLength(0);
  });

  // Site: `own(body, "max_rate_in")` in the plan.
  it("plans under no input ceiling from a body's prototype", async () => {
    const h = batchHarness({ gasFee: 7n });
    const sealLine = vi.spyOn(h.client, "sealLine");
    // The line names its output ceiling only, so the input side has none: it
    // rests at the market's input rate, never the inherited 999.
    await pollutedAsync("max_rate_in", "999", async () => {
      await h.client.batches.submit([{ body: { model: "m", max_rate_out: "0.0001" } }], "1h", {
        providers: [1],
      });
    });
    const [entry] = h.plans[0]!.models as Record<string, unknown>[];
    expect(Object.hasOwn(entry!, "max_rate_in")).toBe(false);
    expect(sealLine.mock.calls[0]![0].rateIn).toBe("0.001");
  });

  // Site: `own(body, "max_rate_out")` in the plan.
  it("plans under no output ceiling from a body's prototype", async () => {
    const h = batchHarness({ gasFee: 7n });
    const sealLine = vi.spyOn(h.client, "sealLine");
    await pollutedAsync("max_rate_out", "999", async () => {
      await h.client.batches.submit([{ body: { model: "m", max_rate_in: "0.0001" } }], "1h", {
        providers: [1],
      });
    });
    const [entry] = h.plans[0]!.models as Record<string, unknown>[];
    expect(Object.hasOwn(entry!, "max_rate_out")).toBe(false);
    expect(sealLine.mock.calls[0]![0].rateOut).toBe("0.002");
  });

  // Site: `own(body, "units_out")` in the sealing loop.
  it("declares no output units from a body's prototype", async () => {
    // `units_out` is the output leg of the escrow cap, so an inherited one
    // signs an order for units the caller did not ask to pay for.
    const h = batchHarness({ gasFee: 7n });
    const sealLine = vi.spyOn(h.client, "sealLine");
    await pollutedAsync("units_out", 99, async () => {
      await h.client.batches.submit([{ body: PRICED_LINE }], "1h", { providers: [1] });
    });
    expect(sealLine.mock.calls[0]![0].unitsOut).toBeUndefined();
  });

  // Site: `own(opts, "providers")` in `submit`.
  it("designates no provider from the options record's prototype", async () => {
    // **The batch path's version of the create finding.** An inherited
    // `providers` seals every line to an operator the caller never named,
    // instead of to the coordinator's verified escrow key. With the own-read,
    // the list is empty — the line rests open — and this client has no
    // verifier, so it fails closed before a byte is sealed.
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("providers", [1], async () => {
      await expect(
        h.client.batches.submit([{ body: PRICED_LINE }], "1h", {} as { providers: number[] }),
      ).rejects.toThrow(EscrowKeyUnverified);
    });
    expect(h.termsOnlyPosts).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
  });

  // Site: `own(opts, "validateParams")` in `submit`.
  it("reads no validateParams opt-out from the options record's prototype", async () => {
    // The flag switches off a real *refusal*, not a warning. An inherited
    // `false` submits a line the network forbids outright.
    const h = batchHarness({ gasFee: 7n, models: BANNING_CATALOG });
    await pollutedAsync("validateParams", false, async () => {
      await expect(
        h.client.batches.submit([{ body: { ...PRICED_LINE, banned: 1 } }], "1h", { providers: [1] }),
      ).rejects.toThrow(/parameter 'banned' is not supported/);
    });
  });

  // Site: `own(opts, "metadata")` in `submit`.
  it("sends no batch metadata from the options record's prototype", async () => {
    // Batch metadata is plaintext by design and goes to the coordinator, so an
    // inherited map labels somebody's batch with keys they never wrote.
    const h = batchHarness({ gasFee: 7n });
    await pollutedAsync("metadata", { linked: "wallet" }, async () => {
      await h.client.batches.submit([{ body: PRICED_LINE }], "1h", { providers: [1] });
    });
    expect(h.creates[0]!.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// src/client.ts — the coordinator's answers and the caller's arguments
// ---------------------------------------------------------------------------

/**
 * **The provider record, and why this file exists.**
 *
 * `providers()` reshapes a `GET /evm/providers/:id` row, and its `box_key`
 * becomes the key a designated order's payload is sealed to. Read bare, a row
 * that omits `box_key` is answered by a polluted `Object.prototype.box_key` —
 * the `provider N publishes no box_key` refusal never fires, and the order
 * seals to a key nobody published. `verifyRecord` does not catch it: it guards
 * only the `confidential: true` branch, and **every batch line is
 * `confidential: false` by construction** (`client.ts`'s `sealLine` passes
 * `args.confidential ?? false` and the batch surface carries no such flag).
 *
 * The end-to-end test is the one that matters here, and it is the one the
 * site test cannot replace: this defect hid precisely because the site looked
 * like a display read.
 */
describe("client — the provider record a payload is sealed to", () => {
  /** A row that states an id and nothing else — no `box_key` at all. */
  const silentProvider: Route = [/\/evm\/providers\/\d+/, () => json({ id: 1 })];
  const ATTACKER_KEY = `0x${"99".repeat(32)}`;

  // Site: `own(row, "box_key")` in `Client.providers`.
  it("reshapes no provider field from the prototype", async () => {
    const { client: c } = client([silentProvider, ...baseRoutes()]);
    const record = await pollutedAllAsync(
      [
        ["box_key", ATTACKER_KEY],
        ["operator", "0xattacker"],
        ["provider_id", 99],
        ["listed", true],
      ],
      () => c.providers(1),
    );
    expect(record.boxKey).toBe("");
    expect(record.operator).toBe("");
    expect(record.providerId).toBe(0);
    expect(record.listed).toBe(false);
  });

  // The same site, reached the way the finding was measured: through a real
  // batch submit, which is a **non-confidential designated** order.
  it("refuses a batch line whose provider publishes no box_key, under pollution", async () => {
    // The plan places nobody, so the line rests on the provider it names.
    const { client: c, calls } = client([
      silentProvider,
      ...baseRoutes(),
      [/\/v1\/batches$/, () => json({ plan: [{ allocation: [] }] }, 402)],
    ]);
    await pollutedAsync("box_key", ATTACKER_KEY, async () => {
      await expect(
        c.batches.submit([{ body: PRICED_LINE }], "1h", { providers: [1] }),
      ).rejects.toThrow(/provider 1 publishes no box_key/);
    });
    // Nothing was sealed and nothing was posted: the refusal is before the wire.
    expect(calls.filter((call) => call.url.endsWith("/v1/jobs"))).toHaveLength(0);
  });

  // The same again on the single-order path, which is where `confidential`
  // could have saved it and does not, because it defaults to `false`.
  it("refuses a designated submit whose provider publishes no box_key, under pollution", async () => {
    const { client: c, calls } = client([silentProvider, ...baseRoutes()]);
    await pollutedAsync("box_key", ATTACKER_KEY, async () => {
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /provider 1 publishes no box_key/,
      );
    });
    // Only the unsigned market probe went out: no order was signed or posted.
    expect(posts(calls)).toHaveLength(0);
  });

  // The other direction, so the fix cannot be "always refuse": a row that
  // really does publish a key still seals to it.
  it("still seals to a box_key the row actually publishes", async () => {
    const { client: c } = client(baseRoutes());
    expect((await c.providers(1)).boxKey).toBe(RECIPIENT_PUBLIC);
  });
});

describe("client — the escrow announcement, the file row and the listings", () => {
  /** Any well-formed wallet: `jobsSummary` refuses a non-string owner outright. */
  const SUMMARY_OWNER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

  // Site: `own(body, …)` in `Client.escrowKey`.
  it("reshapes no escrow announcement field from the prototype", async () => {
    // Not on the sealing path — `escrowRecipient` reads `GET /key` separately
    // and hands the verifier the raw body — so this one is consistency, not a
    // hole that was open. Pinned anyway, because the rule holds because the
    // code enforces it.
    const { client: c } = client([[/\/key$/, () => json({})], ...baseRoutes()]);
    const announced = await pollutedAllAsync(
      [
        ["escrow_public_key", "deadbeef"],
        ["evidence", { type: "invented" }],
        ["issued_at", 12345],
      ],
      () => c.escrowKey(),
    );
    expect(announced.escrowPublicKey).toBe("");
    expect(announced.evidence).toBeUndefined();
    expect(announced.issuedAt).toBe(0);
  });

  // Site: `own(row, …)` and `own(vorq, …)` in `fileFrom`.
  it("reshapes no file field from the prototype", async () => {
    // `cid` is the name a batch's sealed output is fetched by, so an inherited
    // one points a result read at content this file never named.
    const { client: c } = client([
      [/\/v1\/files\/[^/]+$/, () => json({ object: "file" })],
      ...baseRoutes(),
    ]);
    const file = await pollutedAllAsync(
      [
        ["id", "file_attacker"],
        ["bytes", 99],
        ["filename", "invented.jsonl"],
        ["purpose", "batch"],
        ["status", "processed"],
        ["created_at", 1],
        ["vorq", { cid: "bafyattacker", lines: 7 }],
        ["cid", "bafyattacker"],
        ["lines", 7],
      ],
      () => c.file("file_1"),
    );
    expect(file.id).toBe("");
    expect(file.bytes).toBe(0);
    expect(file.filename).toBe("");
    expect(file.purpose).toBe("");
    expect(file.status).toBe("");
    expect(file.createdAt).toBeNull();
    expect(file.cid).toBeNull();
    expect(file.lines).toBeNull();
  });

  // Site: `own(body, "as_of_block")` in `Client.pageOf`.
  it("reads no as_of_block from the prototype", async () => {
    const { client: c } = client([[/\/evm\/asks/, () => json({ asks: [] })], ...baseRoutes()]);
    const book = await pollutedAsync("as_of_block", "999", () => c.asks());
    expect(book.asOfBlock).toBeNull();
  });

  // Site: `own(query, "limit")` in `Client.pageOf`.
  it("reads no page limit from the caller's query prototype", async () => {
    // With `limit` read off the prototype and matching the row count, an
    // exhausted listing claims another page and the walk never ends.
    const { client: c } = client([
      [/\/evm\/asks/, () => json({ asks: [{ provider_id: 1 }, { provider_id: 2 }] })],
      ...baseRoutes(),
    ]);
    const book = await pollutedAsync("limit", 2, () => c.asks());
    expect(book.nextOffset).toBeNull();
  });

  // Site: `own(query, "offset")` in `Client.pageOf`.
  it("reads no page offset from the caller's query prototype", async () => {
    // The truncation header names offset 5. Read at a prototype offset of 100
    // that header is "not usable" (it must be greater than the offset asked
    // for) and the walk resumes at 100 instead — skipping ninety-five rows.
    const { client: c } = client([
      [
        /\/evm\/asks/,
        () =>
          json({ asks: [{ provider_id: 1 }] }, 200, {
            "x-vorq-page-truncated": "true",
            "x-vorq-next-offset": "5",
          }),
      ],
      ...baseRoutes(),
    ]);
    const book = await pollutedAsync("offset", 100, () => c.asks());
    expect(book.nextOffset).toBe(5);
  });

  // Site: `own(r, …)` on an ask row in `Client.asks`.
  it("reshapes no ask row field from the prototype", async () => {
    const { client: c } = client([[/\/evm\/asks/, () => json({ asks: [{}] })], ...baseRoutes()]);
    const book = await pollutedAllAsync(
      [
        ["provider_id", 9],
        ["model_id", 9],
        ["sla", 9],
        ["rate_in", "999"],
        ["rate_out", "999"],
      ],
      () => c.asks(),
    );
    expect(book.asks[0]).toEqual({
      providerId: 0,
      modelId: 0,
      sla: 0,
      rateIn: "0",
      rateOut: "0",
    });
  });

  // Site: `own(query, …)` in `Client.asks`.
  it("sends no ask query parameter from the caller's query prototype", async () => {
    const { client: c, calls } = client([
      [/\/evm\/asks/, () => json({ asks: [] })],
      ...baseRoutes(),
    ]);
    await pollutedAllAsync(
      [
        ["model", 7],
        ["limit", 5],
        ["offset", 3],
      ],
      () => c.asks(),
    );
    expect(calls.at(-1)!.url).toBe("http://node/evm/asks");
  });

  // Site: `q(key)` in `Client.jobs`.
  it("sends no job query parameter from the caller's query prototype", async () => {
    const { client: c, calls } = client([
      [/\/evm\/jobs/, () => json({ jobs: [] })],
      ...baseRoutes(),
    ]);
    await pollutedAllAsync(
      [
        ["state", 2],
        ["model", 7],
        ["provider", 9],
        ["owner", "0xattacker"],
        ["postedBefore", 1],
        ["order", "newest"],
        ["limit", 5],
        ["offset", 3],
      ],
      () => c.jobs(),
    );
    expect(calls.at(-1)!.url).toBe("http://node/evm/jobs");
  });

  // Site: `own(query, …)` in `Client.floors`.
  it("sends no floors query parameter from the caller's query prototype", async () => {
    const { client: c, calls } = client([
      [/\/evm\/asks\/floors/, () => json({ floors: [] })],
      ...baseRoutes(),
    ]);
    await pollutedAllAsync(
      [
        ["model", 7],
        ["sla", 3600],
        ["limit", 5],
        ["offset", 3],
      ],
      () => c.floors(),
    );
    expect(calls.at(-1)!.url).toBe("http://node/evm/asks/floors");
  });

  // Site: `own(r, …)` on a floors row in `Client.floors`.
  it("reads no floor field from the prototype, and refuses naming it", async () => {
    // One key at a time, with the row stating every *other* one: read bare, the
    // prototype completes the row and the floor parses as a real rate; read own,
    // the figure is absent and the refusal names it. So reverting any single one
    // of the four reads reddens this test.
    for (const [key, value] of [
      ["model_id", 9],
      ["sla", 9],
      ["rate_in", "999"],
      ["rate_out", "999"],
    ] as [string, unknown][]) {
      const row: Record<string, unknown> = { model_id: 1, sla: 1, rate_in: "1", rate_out: "1" };
      delete row[key];
      const { client: c } = client([
        [/\/evm\/asks\/floors/, () => json({ floors: [row] })],
        ...baseRoutes(),
      ]);
      await expect(pollutedAsync(key, value, () => c.floors())).rejects.toThrow(key);
    }
  });

  // Site: `own(body, …)` on the summary body in `Client.jobsSummary`.
  it("reads no summary figure from the prototype, and refuses naming it", async () => {
    for (const [key, value] of [
      ["jobs", 9],
      ["completed", 9],
      ["escrowed", "999"],
      ["by_model", []],
    ] as [string, unknown][]) {
      const body: Record<string, unknown> = {
        jobs: 1,
        completed: 1,
        escrowed: "1",
        by_model: [],
      };
      delete body[key];
      const { client: c } = client([
        [/\/evm\/jobs\/summary/, () => json(body)],
        ...baseRoutes(),
      ]);
      await expect(
        pollutedAsync(key, value, () => c.jobsSummary({ owner: SUMMARY_OWNER })),
      ).rejects.toThrow(key);
    }
  });

  // Site: `own(r, …)` on a `by_model` row in `Client.jobsSummary`.
  it("reads no by_model figure from the prototype, and refuses naming it", async () => {
    // Each key is polluted with a value that would parse, so only an own read
    // refuses it: counts are JSON integers, `escrowed` a USD string.
    for (const [key, value] of [
      ["model_id", 9],
      ["jobs", 9],
      ["completed", 9],
      ["escrowed", "999"],
    ] as [string, unknown][]) {
      const row: Record<string, unknown> = {
        model_id: 1,
        jobs: 1,
        completed: 1,
        escrowed: "1",
      };
      delete row[key];
      const { client: c } = client([
        [
          /\/evm\/jobs\/summary/,
          () => json({ jobs: 1, completed: 1, escrowed: "1", by_model: [row] }),
        ],
        ...baseRoutes(),
      ]);
      await expect(
        pollutedAsync(key, value, () => c.jobsSummary({ owner: SUMMARY_OWNER })),
      ).rejects.toThrow(key);
    }
  });

  // Site: `own(body, "as_of_block")` in `Client.jobsSummary`.
  it("reads no summary as_of_block from the prototype", async () => {
    const { client: c } = client([
      [
        /\/evm\/jobs\/summary/,
        () => json({ jobs: 1, completed: 1, escrowed: "1", by_model: [] }),
      ],
      ...baseRoutes(),
    ]);
    const summary = await pollutedAsync("as_of_block", "999", () =>
      c.jobsSummary({ owner: SUMMARY_OWNER }),
    );
    expect(summary.asOfBlock).toBeNull();
  });

  // Site: `own(query, "owner")` in `Client.jobsSummary`.
  it("reads no summary owner from the caller's query prototype", async () => {
    // `jobs()` already drops an inherited `owner`; the summary must not answer
    // differently for the same argument shape. Read bare, this returns the
    // attacker's wallet totals for a query that names no wallet at all.
    const { client: c, calls } = client([
      [
        /\/evm\/jobs\/summary/,
        () =>
          json({
            jobs: 1,
            completed: 1,
            escrowed: "1",
            by_model: [],
            as_of_block: 9,
          }),
      ],
      ...baseRoutes(),
    ]);
    await expect(
      pollutedAsync("owner", "0xattacker", () => c.jobsSummary({} as { owner: string })),
    ).rejects.toBeInstanceOf(VorqError);
    expect(calls.some((call) => call.url.includes("owner="))).toBe(false);
  });

  // Site: `own(query, …)` in `Client.allowlist`, and `own(r, …)` on its rows.
  it("reshapes no allowlist entry and sends no allowlist query from the prototype", async () => {
    const { client: c, calls } = client([
      [/\/evm\/allowlist/, () => json({ entries: [{}] })],
      ...baseRoutes(),
    ]);
    const list = await pollutedAllAsync(
      [
        ["key", "0xattacker"],
        ["status", 1],
        ["entry", { invented: true }],
        ["limit", 5],
        ["offset", 3],
      ],
      () => c.allowlist(),
    );
    expect(list.entries[0]).toEqual({ key: "", status: 0, entry: undefined });
    expect(calls.at(-1)!.url).toBe("http://node/evm/allowlist");
  });
});

/**
 * The caller's argument records on the two sealing doors.
 *
 * `provider` chooses the seal recipient and `rateIn`/`rateOut`/`sla` are signed,
 * settled terms, so an inherited one is a term this SDK signs on the caller's
 * behalf. Both methods read their args through one guard, so one test each.
 */
describe("client — the arguments a sealed order is built from", () => {
  // Site: `arg(key)` in `Client.submit`.
  it("designates no provider from the submit args' prototype", async () => {
    // With the own-read the order is **open** — sealed to the coordinator's
    // escrow key — and this client has no verifier, so it fails closed with
    // nothing on the wire. Read bare it would be designated to provider 9.
    const { client: c, calls } = client(baseRoutes());
    await pollutedAllAsync(
      [
        ["provider", 9],
        ["maxRateIn", "999"],
        ["maxRateOut", "999"],
        ["sla", "720h"],
      ],
      async () => {
        await expect(c.submit({ maxRateIn: "0.0001", maxRateOut: "0.0001", model: "m", input: "hi" })).rejects.toThrow(EscrowKeyUnverified);
      },
    );
    // Only the unsigned market probe went out, unpinned and under the own ceilings.
    expect(posts(calls)).toHaveLength(0);
    expect(probes(calls)[0]!.body).toMatchObject({ designated: 0, max_rate_in: "0.0001" });
  });

  // Site: `arg(key)` in `Client.sealLine`.
  it("designates no provider from the sealLine args' prototype", async () => {
    const { client: c } = client(baseRoutes());
    const ctx = await c.chainContext();
    await pollutedAllAsync(
      [
        ["provider", 9],
        ["rateIn", "999"],
        ["rateOut", "999"],
      ],
      async () => {
        await expect(
          c.sealLine({
            model: "m",
            payloadInput: { input: "hi" },
            window: "1h",
            url: "/v1/responses",
            rateIn: "0",
            rateOut: "0",
            ctx,
          }),
        ).rejects.toThrow(EscrowKeyUnverified);
      },
    );
  });
});

/**
 * The node's quote, which is the one thing a submission takes off the network
 * before it signs a payment.
 *
 * Every read below fails **closed**, and that is the change: this client derives
 * the whole authorization itself and the quote has to agree member for member,
 * so a prototype standing in for a member the node never sent turns a quote this
 * client must refuse into one it signs. The honest value of every one of those
 * members is either a constant of the deployment or a field the node just echoed
 * back, so a page that can pollute can supply all of them.
 */
describe("client — the quote a payment authorization is checked against", () => {
  /** The job and the window the probes below quote for. Both are the client's own. */
  const JOB = `0x${"11".repeat(32)}`;
  const EXPIRES = 1_800_003_600n;
  const HONEST = () => QUOTE(JOB, EXPIRES).quote;

  /**
   * `quoteFrom` itself, reached by cast — narrower than driving a whole
   * `submit`, and deliberately so.
   *
   * One of the members below is `value`, and `value` is a **property-descriptor
   * key**: a realm whose `Object.prototype` carries one makes every
   * `Object.defineProperty(o, k, { get … })` anywhere in the process throw
   * "cannot both specify accessors and a value". Held open across an `await` that
   * takes the run down with it; held across one synchronous call it reaches
   * exactly the reads under test and nothing else. Measured — the end-to-end
   * form of this test failed that way before it was narrowed.
   */
  const read = (body: unknown): { amount: bigint } => {
    const { client: c } = client(baseRoutes());
    return (
      c as unknown as {
        quoteFrom(
          body: unknown,
          jobId: string,
          ctx: ChainContext,
          expiresAt: bigint,
        ): { amount: bigint };
      }
    ).quoteFrom(body, JOB, CTX, EXPIRES);
  };

  /**
   * Read `body` with `key` on the prototype, and hand back the refusal.
   *
   * The pollution is released **before** the assertion runs, for the reason
   * above: an expectation that failed while `Object.prototype.value` was still
   * in place would report a descriptor error rather than its own diff.
   */
  const refusalFor = (key: string, value: unknown, body: unknown): Error | null =>
    polluted(key, value, () => {
      try {
        read(body);
        return null;
      } catch (error) {
        return error as Error;
      }
    });

  /** The honest quote for this job, less the named member. */
  const quoteLess = (member: string, from: "authorization" | "domain") => {
    const { authorization, ...rest } = HONEST();
    const auth = { ...authorization } as Record<string, unknown>;
    if (from === "domain") {
      const domain = { ...authorization.domain } as Record<string, unknown>;
      delete domain[member];
      auth.domain = domain;
    } else {
      delete auth[member];
    }
    return { quote: { ...rest, authorization: auth } };
  };

  /**
   * Every member of the quoted authorization, and the value a polluted prototype
   * would have to supply for a bare read to find the quote in agreement.
   */
  const MEMBERS: Array<[string, "authorization" | "domain", unknown]> = [
    ["chainId", "domain", 84532],
    ["verifyingContract", "domain", CHAIN.contracts.usdc],
    ["name", "domain", "USDC"],
    ["version", "domain", "2"],
    ["to", "authorization", CHAIN.contracts.job_registry],
    ["nonce", "authorization", JOB],
    ["value", "authorization", 210],
    ["valid_after", "authorization", 0],
    ["valid_before", "authorization", Number(EXPIRES + 1n)],
  ];

  // Sites: `own(auth, …)` and `own(domain, …)` in `quoteFrom`.
  it.each(MEMBERS)("checks no %s the quote never stated", (member, from, honest) => {
    const refusal = refusalFor(member, honest, quoteLess(member, from));
    expect(refusal?.message).toMatch(/not the one this client derives/);
  });

  // Site: `own(body, "quote")` in `quoteFrom`.
  it("reads no quote from the challenge body's prototype", () => {
    expect(refusalFor("quote", HONEST(), {})?.message).toMatch(/no quote to sign/);
  });

  // Site: `own(fields, "authorization")` in `quoteFrom`.
  //
  // Asserted on the **message**, because both readings refuse: read bare, an
  // empty prototype block is an object, and the member-for-member comparison is
  // what turns it away — one refusal later, naming the wrong cause.
  it("reads no authorization block from the quote's prototype", () => {
    const refusal = refusalFor("authorization", {}, { quote: { amount: usd(210) } });
    expect(refusal?.message).toMatch(/names no amount and authorization/);
  });

  // Site: `own(fields, "amount")` in `quoteFrom`.
  //
  // The amount is the one figure this client takes from the node, so a quote
  // stating none has nothing to sign — and a prototype supplying one that agrees
  // with the quoted `value` is signed for silently.
  it("signs no amount the quote never named", () => {
    const { amount: _drop, ...rest } = HONEST();
    expect(refusalFor("amount", usd(210), { quote: rest })?.message).toMatch(
      /names no amount and authorization/,
    );
  });

  // Site: `own(auth, "domain")` in `quoteFrom`.
  it("reads no authorization domain from the quote's prototype", () => {
    const { domain, ...auth } = HONEST().authorization;
    const refusal = refusalFor("domain", domain, {
      quote: { amount: usd(210), authorization: auth },
    });
    expect(refusal?.message).toMatch(/not the one this client derives/);
  });

  // The other direction, end to end, so no fix here can be "always refuse" and
  // so the four arguments above are the ones a real submission passes.
  it("still signs a quote the node really did state", async () => {
    const { client: c, calls } = client([
      marketRoute(),
      [
        /\/v1\/jobs$/,
        (n, body) => {
          const order = body as { job_id: string; expires_at: number };
          return n === 1
            ? json(QUOTE(order.job_id, BigInt(order.expires_at)), 402)
            : json({ job_id: order.job_id, task_cid: "bafytask", tx_hash: "0x1" }, 201);
        },
      ],
      ...baseRoutes(),
    ]);
    await expect(c.submit({ model: "m", input: "hi", provider: 1 })).resolves.toBeDefined();
    expect(calls.filter((call) => "auth_sig" in ((call.body ?? {}) as object))).toHaveLength(1);
  });
});

describe("client — the catalog id an order is signed over, and the answer it comes back as", () => {
  const accepted: Route = [
    /\/v1\/jobs$/,
    (n, body) => {
      const jobId = (body as { job_id: string }).job_id;
      return n === 1 ? json(quoted(body), 402) : json({ job_id: jobId, tx_hash: "0x1" }, 201);
    },
  ];
  const catalog = (data: unknown): Route => [/\/v1\/models/, () => json({ data })];

  // Site: `own(record, "id")` in `modelIdFor`.
  it("matches no catalog row from its prototype id", async () => {
    const { client: c } = client([
      catalog([{ object: "model", vorq: { model_id: 7 } }]),
      accepted,
      ...baseRoutes(),
    ]);
    await pollutedAsync("id", "m", async () => {
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /carries no numeric model_id/,
      );
    });
  });

  // Site: `own(record, "vorq")` in `modelIdFor`.
  it("reads no catalog vorq block from the prototype", async () => {
    const { client: c } = client([
      catalog([{ id: "m", object: "model" }]),
      accepted,
      ...baseRoutes(),
    ]);
    await pollutedAsync("vorq", { model_id: 7 }, async () => {
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /carries no numeric model_id/,
      );
    });
  });

  // Site: `own(catalogVorq, "model_id")` in `modelIdFor`.
  it("signs no model id from the catalog vorq block's prototype", async () => {
    const { client: c } = client([
      catalog([{ id: "m", object: "model", vorq: {} }]),
      accepted,
      ...baseRoutes(),
    ]);
    await pollutedAsync("model_id", 7, async () => {
      await expect(c.submit({ model: "m", input: "hi", provider: 1 })).rejects.toThrow(
        /carries no numeric model_id/,
      );
    });
  });

  // Sites: `own(row, "vorq")`, `own(terms, "sla_secs")`, `own(row, "task_cid")`
  // and `own(terms, "task_cid")` in `handleFromJob`.
  it("builds no handle field from the post receipt's prototype", async () => {
    // A `POST /v1/jobs` receipt carries `{job_id, tx_hash}` and no terms at all,
    // so every one of these reads is answered by the prototype when read bare —
    // and `taskCid` is the name the sealed task is addressed by.
    const { client: c } = client([marketRoute(), accepted, ...baseRoutes()]);
    const handle = await pollutedAllAsync(
      [
        ["vorq", { sla_secs: 7200, task_cid: "bafyattacker" }],
        ["sla_secs", 7200],
        ["task_cid", "bafyattacker"],
      ],
      () => c.submit({ model: "m", input: "hi", provider: 1, sla: "1h" }),
    );
    expect(handle.taskCid).toBeNull();
    // Reached through a cast because the field is private: it is still the value
    // `handleFromJob` computed, and `sla_secs` has no other observable.
    expect((handle as unknown as { sla: string | null }).sla).toBe("1h");
  });
});

describe("client — the handshake", () => {
  const authed = (nonce: unknown, session: unknown): Route[] => [
    [/\/auth\/nonce/, () => json(nonce)],
    [/\/auth\/session/, () => json(session)],
  ];

  // Site: `own(body, field)` in `handshake`'s `required`.
  it("accepts no session token from the prototype", async () => {
    // A bare dynamic index lets a polluted `Object.prototype.token` satisfy the
    // malformed-response check, so an inherited string is stored and sent as
    // this client's bearer token.
    const { client: c } = client([
      ...authed({ nonce: "n", chain_id: 84532 }, {}),
      [/\/v1\/models/, () => json(MODELS)],
    ]);
    await pollutedAsync("token", "vorq_sess_attacker", async () => {
      await expect(c.request("GET", "/v1/models")).rejects.toThrow(/no usable `token`/);
    });
  });

  // Site: `own(payload, "expires_at")` in `handshake`.
  it("reads no session expiry from the prototype", async () => {
    // An expiry in the past from the prototype makes every request re-mint,
    // burning a fresh nonce per call.
    const { client: c, calls } = client([
      ...authed({ nonce: "n", chain_id: 84532 }, { token: "t" }),
      [/\/v1\/models/, () => json(MODELS)],
    ]);
    await pollutedAsync("expires_at", 1, async () => {
      await c.request("GET", "/v1/models");
      await c.request("GET", "/v1/models");
    });
    expect(calls.filter((call) => call.url.includes("/auth/nonce"))).toHaveLength(1);
  });

  // Site: `own(rec, …)` in `mintSessionToken`.
  it("mints against no base URL or transport from the args' prototype", async () => {
    const { impl, calls } = scriptedFetch(authed({ nonce: "n", chain_id: 84532 }, { token: "vorq_sess_ok" }));
    const poisoned = vi.fn();
    await pollutedAllAsync(
      [
        ["baseUrl", "http://elsewhere.invalid"],
        ["fetch", poisoned],
      ],
      () => mintSessionToken({ signer: new PrivateKeySigner(KEY), fetch: impl }),
    );
    expect(poisoned).not.toHaveBeenCalled();
    expect(calls.every((call) => call.url.startsWith(DEFAULT_BASE_URL))).toBe(true);
  });
});

describe("client — the constructor's options record", () => {
  // Site: `opt(key)` in the `Client` constructor.
  it("builds against no option from the prototype", async () => {
    // `fetch` and `signer` are the sharp ones: an inherited `fetch` would carry
    // every sealed request, and an inherited `signer` would sign every order.
    const { impl, calls } = scriptedFetch([
      ...baseRoutes(),
      [/\/v1\/models/, () => json(MODELS)],
    ]);
    const poisoned = vi.fn();
    await pollutedAllAsync(
      [
        ["baseUrl", "http://elsewhere.invalid"],
        ["fetch", poisoned],
        ["signer", new PrivateKeySigner(KEY)],
      ],
      async () => {
        const c = new Client({ fetch: impl });
        await c.request("GET", "/v1/models");
      },
    );
    expect(poisoned).not.toHaveBeenCalled();
    // No signer was adopted, so no handshake was attempted.
    expect(calls.filter((call) => call.url.includes("/auth/nonce"))).toHaveLength(0);
    expect(calls.every((call) => call.url.startsWith(DEFAULT_BASE_URL))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// src/terms.ts — the chain context every signature is made against
// ---------------------------------------------------------------------------

/**
 * `ChainContext.fromWire` is the same shape as the provider-record defect and
 * the same severity: a **presence check and a value read that both walk the
 * prototype chain**, over the four addresses this client signs against and the
 * token figures every payment is signed under. `usdc` is the `verifyingContract`
 * of the payment authorization, and `token_domain` is its name and version.
 */
describe("terms — the chain context a payment authorization is signed against", () => {
  const CONTRACTS = CHAIN.contracts;
  const chainRoute = (body: unknown): Route => [/\/evm\/chain/, () => json(body)];
  const rest = (): Route[] => [
    [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
    [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
  ];
  /** The honest body, less one key. */
  const less = (key: string): Record<string, unknown> => {
    const body = { ...CHAIN } as Record<string, unknown>;
    delete body[key];
    return body;
  };

  // Site: `stated(field)` in `ChainContext.fromWire`.
  it("signs against no contract address from the prototype", async () => {
    // The body names three of the four. Read bare, `Object.prototype.usdc`
    // answers both the missing-field check and the address read, so this client
    // signs a transfer authorization under a token the coordinator never named.
    const { job_registry, provider_registry, ask_registry } = CONTRACTS;
    const { client: c } = client([
      chainRoute({ ...CHAIN, contracts: { job_registry, provider_registry, ask_registry } }),
      ...rest(),
    ]);
    await pollutedAsync("usdc", "0x0000000000000000000000000000000000000bad", async () => {
      await expect(c.chainContext()).rejects.toThrow(/missing contract usdc/);
    });
  });

  // Site: `own(body, "contracts")` in `ChainContext.fromWire`.
  it("reads no contracts block from the prototype", async () => {
    const { client: c } = client([chainRoute(less("contracts")), ...rest()]);
    await pollutedAsync("contracts", CONTRACTS, async () => {
      await expect(c.chainContext()).rejects.toThrow(/answered no contracts block/);
    });
  });

  // Site: `own(body, "chain_id")` in `ChainContext.fromWire`.
  it("reads no chain id from the prototype", async () => {
    const { client: c } = client([chainRoute(less("chain_id")), ...rest()]);
    await pollutedAsync("chain_id", 999, async () => {
      await expect(c.chainContext()).rejects.toThrow(/chain_id must be a JSON integer/);
    });
  });

  // Site: `own(body, "token_domain")` in `ChainContext.fromWire`.
  it("reads no token domain from the prototype", async () => {
    const { client: c } = client([chainRoute(less("token_domain")), ...rest()]);
    await pollutedAsync("token_domain", { name: "USDC", version: "2" }, async () => {
      await expect(c.chainContext()).rejects.toThrow(/answered no token_domain/);
    });
  });

  // Sites: `own(tokenDomainMember, "name"|"version")` in `ChainContext.fromWire`.
  it.each(["name", "version"])(
    "reads no token domain %s from the prototype",
    async (member) => {
      const token_domain = { ...CHAIN.token_domain } as Record<string, unknown>;
      delete token_domain[member];
      const { client: c } = client([chainRoute({ ...CHAIN, token_domain }), ...rest()]);
      await pollutedAsync(member, "USDC", async () => {
        await expect(c.chainContext()).rejects.toThrow(
          new RegExp(`token_domain.${member} must be a non-empty string`),
        );
      });
    },
  );

  // Sites: `own(body, "decimals")` and `own(body, "fee_bps")`.
  it.each([
    ["decimals", 18, /decimals must be a JSON integer/],
    ["fee_bps", 1000, /fee_bps must be a JSON integer/],
  ])("reads no %s from the prototype", async (key, value, message) => {
    const { client: c } = client([chainRoute(less(key)), ...rest()]);
    await pollutedAsync(key, value, async () => {
      await expect(c.chainContext()).rejects.toThrow(message);
    });
  });

  // The other direction, so the fix cannot be "always refuse".
  it("still builds a context the coordinator actually stated", async () => {
    const { client: c } = client([chainRoute(CHAIN), ...rest()]);
    expect((await c.chainContext()).chainId).toBe(84532);
  });
});

// ---------------------------------------------------------------------------
// src/paging.ts — the rows a listing is read from
// ---------------------------------------------------------------------------

describe("paging — the rows key a listing is read from", () => {
  // Site: `own(body, key)` in `pageRows`.
  it("reads no listing rows from the prototype", async () => {
    // A bare dynamic index lets a polluted `Object.prototype.asks` stand in as
    // the coordinator's rows, so a body that carried none is read as a full
    // listing and the "this is not an array of rows" refusal never fires.
    const { client: c } = client([[/\/evm\/asks/, () => json({})], ...baseRoutes()]);
    await pollutedAsync("asks", [{ provider_id: 9 }], async () => {
      await expect(c.asks()).rejects.toThrow(/`asks` is absent/);
    });
  });
});

// ---------------------------------------------------------------------------
// src/models.ts — the published schema every submission is checked against
// ---------------------------------------------------------------------------

describe("models — the schema a submission is validated against", () => {
  const catalog = (data: unknown): Route => [/\/v1\/models/, () => json({ data })];
  const BANNING = { properties: { banned: false } };

  // Site: `own(vorq, "params_schema")` in `Models.paramsSchema`.
  it("validates against no schema from the catalog vorq block's prototype", async () => {
    // `checkInput` **throws** on a `false` subschema, so a schema supplied by
    // the prototype refuses every submission for every caller — the shipped
    // defect this rule was written for, one layer up from where it was fixed.
    const { client: c } = client([
      catalog([{ id: "m", object: "model", vorq: {} }]),
      ...baseRoutes(),
    ]);
    await pollutedAsync("params_schema", BANNING, async () => {
      expect(await c.models.paramsSchema("m")).toBeNull();
    });
  });

  // Site: `own(rec, "vorq")` in `Models.paramsSchema`.
  it("matches no catalog row from its prototype vorq block", async () => {
    const { client: c } = client([catalog([{ id: "m", object: "model" }]), ...baseRoutes()]);
    const schema = await pollutedAsync("vorq", { params_schema: BANNING }, () =>
      c.models.paramsSchema("m"),
    );
    expect(schema).toBeNull();
  });

  // Site: `own(rec, "id")` in `Models.paramsSchema`.
  //
  // The row states an own `vorq` carrying the schema, so the `vorq` guard is
  // satisfied by a real value and cannot mask this one. Measured: with all four
  // keys polluted at once, reverting this site left the test green.
  it("matches no catalog row from its prototype id", async () => {
    const { client: c } = client([
      catalog([{ object: "model", vorq: { params_schema: BANNING } }]),
      ...baseRoutes(),
    ]);
    const schema = await pollutedAsync("id", "m", () => c.models.paramsSchema("m"));
    expect(schema).toBeNull();
  });

  // Site: `own(vorq, "family")` in `Models.paramsSchema`.
  it("matches no catalog row from its prototype family", async () => {
    const { client: c } = client([
      catalog([{ id: "another-model", object: "model", vorq: { params_schema: BANNING } }]),
      ...baseRoutes(),
    ]);
    const schema = await pollutedAsync("family", "m", () => c.models.paramsSchema("m"));
    expect(schema).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// src/openai-compat.ts — the retry flag on a refusal
// ---------------------------------------------------------------------------

describe("openai-compat — the retry flag on an error response", () => {
  // Site: `own(options, "retryable")` in `errorResponse`.
  it("reads no retryable flag from the options record's prototype", () => {
    // The same destructuring hole `responseObject` had. Nothing signed and
    // nothing on the wire rests on it — the response is built in-process — but
    // an inherited `false` strips `x-should-retry` from a refusal that never
    // asked to be non-retryable.
    polluted("retryable", false, () => {
      const response = errorResponse(new ValidationError("nope"));
      expect(response.headers.get("x-should-retry")).toBeNull();
    });
  });

  // The other direction: a caller that really does opt out still gets the header.
  it("still marks a stated non-retryable refusal", () => {
    expect(
      errorResponse(new ValidationError("nope"), { retryable: false }).headers.get(
        "x-should-retry",
      ),
    ).toBe("false");
  });
});

// ===========================================================================
// The second sweep — sites an enumeration found that three "clean" reports
// did not. Every test below asserts the **consequence**, not the site.
// ===========================================================================

// ---------------------------------------------------------------------------
// src/params.ts — the published schema's own keywords (H2)
// ---------------------------------------------------------------------------

describe("checkInput — the keywords the published schema itself states", () => {
  // Every site here is a bare read of the schema record, which is `JSON.parse`
  // output off `GET /v1/models`. `checkInput` **throws**, and it runs outside
  // `submit`'s fetch try/catch — so each of these refused every submission from
  // every caller over a keyword the coordinator never published. Measured on
  // the unguarded file: `Object.prototype.properties` gave `parameter
  // 'temperature' is not supported on VORQ`; `Object.prototype.enum` and
  // `.minimum` each gave `parameter 'temperature' is invalid`.
  const scalarSchema = { properties: { temperature: {} } };

  // Site: `own(schema, "properties")` in `checkInput`.
  it("refuses no submission over a `properties` block the schema never carried", () => {
    polluted("properties", { temperature: false }, () => {
      expect(() => checkInput({}, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("type")` in `matches`.
  it("refuses no param over a `type` the subschema never stated", () => {
    polluted("type", "string", () => {
      expect(() => checkInput(scalarSchema, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("minimum")` in `matches`.
  it("refuses no param over a `minimum` the subschema never stated", () => {
    polluted("minimum", 1e9, () => {
      expect(() => checkInput(scalarSchema, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("maximum")` in `matches`.
  it("refuses no param over a `maximum` the subschema never stated", () => {
    polluted("maximum", -1, () => {
      expect(() => checkInput(scalarSchema, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("enum")` in `matches`.
  it("refuses no param over an `enum` the subschema never stated", () => {
    polluted("enum", [], () => {
      expect(() => checkInput(scalarSchema, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("oneOf")` in `matches`.
  it("refuses no param over a `oneOf` the subschema never stated", () => {
    polluted("oneOf", [false], () => {
      expect(() => checkInput(scalarSchema, { temperature: 0.7 })).not.toThrow();
    });
  });

  // Site: `kw("items")` in `matches`.
  it("refuses no array param over an `items` the subschema never stated", () => {
    polluted("items", false, () => {
      expect(() => checkInput({ properties: { stop: {} } }, { stop: ["x"] })).not.toThrow();
    });
  });

  // Site: `kw("properties")` in `matches` — the nested walk.
  it("refuses no nested object over a `properties` block the subschema never stated", () => {
    polluted("properties", { a: false }, () => {
      expect(() => checkInput({ properties: { opts: {} } }, { opts: { a: 1 } })).not.toThrow();
    });
  });

  // The other direction, so no fix here can be "stop checking": a keyword the
  // schema really does state is still enforced.
  it("still enforces every keyword the schema states as its own", () => {
    const refuses = (schema: unknown, input: Record<string, unknown>) =>
      expect(() => checkInput(schema, input)).toThrow(/is invalid/);
    refuses({ properties: { temperature: { type: "string" } } }, { temperature: 0.7 });
    refuses({ properties: { temperature: { minimum: 1 } } }, { temperature: 0.7 });
    refuses({ properties: { temperature: { maximum: 0.5 } } }, { temperature: 0.7 });
    refuses({ properties: { temperature: { enum: [0.1] } } }, { temperature: 0.7 });
    refuses({ properties: { temperature: { oneOf: [{ type: "string" }] } } }, { temperature: 0.7 });
    refuses({ properties: { stop: { items: { type: "number" } } } }, { stop: ["x"] });
    refuses({ properties: { opts: { properties: { a: false } } } }, { opts: { a: 1 } });
  });

  // The consequence, end to end: the submission itself. `checkInput` is called
  // from `Client.submit` before anything is sealed, so the shipped defect was a
  // client that could not submit at all.
  it("still submits when the catalog's schema states no properties", async () => {
    const catalog = {
      data: [{ id: "m", object: "model", vorq: { model_id: 7, params_schema: {} } }],
    };
    const { client: c } = client([
      [/\/v1\/models/, () => json(catalog)],
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, body) =>
          n === 1
            ? json(quoted(body), 402)
            : json({ job_id: (body as { job_id: string }).job_id }),
      ],
    ]);
    await pollutedAsync("properties", { temperature: false }, async () => {
      await expect(
        c.submit({ model: "m", input: { temperature: 0.7 }, provider: 1 }),
      ).resolves.toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// src/batches.ts — the gas fee every line's payment is signed over (H1)
// ---------------------------------------------------------------------------

describe("batches — the gas fee the whole file's payments are signed over", () => {
  /** A node whose terms-only `POST /v1/jobs` answers exactly `body`. */
  const quoting = (body: unknown) =>
    client([
      ...baseRoutes(),
      [/\/v1\/jobs$/, () => json(body, 402)],
      [/\/v1\/files$/, () => json({ id: "f", object: "file", purpose: "batch", bytes: 1 })],
      [
        /\/v1\/batches$/,
        // The plan places nobody, so the line rests at its own terms.
        (_n, body) =>
          Object.hasOwn(body as object, "input_file_id")
            ? json({ id: "b", object: "batch", status: "validating" })
            : json({ plan: [{ allocation: [] }] }, 402),
      ],
    ]);
  const line = [{ body: PRICED_LINE }];
  const created = (calls: Call[]) =>
    calls.filter(
      (c) => c.url.endsWith("/v1/batches") && Object.hasOwn(c.body as object, "input_file_id"),
    );

  // Site: `own(body, "quote")` in `Batches.fees`.
  //
  // Both values flow to `payLine`, where `amount = cap + cap*feeBps/10000 +
  // gasFee` is the **value** every line in the file authorizes. Measured
  // against `dist/` on the unguarded file: *refusal thrown: NONE; signed
  // authorization value: 1000000000000000000000000.*
  it("prices no batch from a quote block the 402 body never carried", async () => {
    const h = quoting({});
    await pollutedAsync("quote", { gas_fee: "1000000000000000000", fee_bps: 0 }, async () => {
      await expect(
        h.client.batches.submit(line, "1h", { providers: [1] }),
      ).rejects.toThrow(/the quote carries no gas_fee/);
    });
    // The consequence: nothing was uploaded and nothing was authorized.
    expect(h.calls.filter((c) => c.url.endsWith("/v1/files"))).toHaveLength(0);
    expect(created(h.calls)).toHaveLength(0);
  });

  // Site: `own(quote, "gas_fee")` in `Batches.fees`.
  it("prices no batch from a gas fee the quote never named", async () => {
    const h = quoting({ quote: { authorization: {} } });
    await pollutedAsync("gas_fee", "1000000000000000000000000", async () => {
      await expect(
        h.client.batches.submit(line, "1h", { providers: [1] }),
      ).rejects.toThrow(/the quote carries no gas_fee/);
    });
    expect(h.calls.filter((c) => c.url.endsWith("/v1/files"))).toHaveLength(0);
  });

  // Site: `own(quote, "fee_bps")` in `Batches.fees`. The same reasoning and the
  // same consequence: the rate rides on top of every line's cap, so a prototype
  // that gets to name it names part of the authorized value.
  it("prices no batch from a fee rate the quote never named", async () => {
    const h = quoting({ quote: { authorization: {}, gas_fee: usd(7) } });
    await pollutedAsync("fee_bps", 1000, async () => {
      await expect(
        h.client.batches.submit(line, "1h", { providers: [1] }),
      ).rejects.toThrow(/the quote carries no fee_bps/);
    });
    expect(h.calls.filter((c) => c.url.endsWith("/v1/files"))).toHaveLength(0);
  });

  // The other direction: a gas fee the quote really does name is still read and
  // still added to every line's authorized value.
  it("still signs a payment over a gas fee the quote states", async () => {
    // Differential rather than absolute: the authorized value is
    // `capFor(terms) + gasFee`, and asserting the *difference* two quotes make
    // pins the value that was read rather than the arithmetic around it — an
    // assertion on one total passes just as well for a fee that was ignored.
    const amountFor = async (fee: bigint): Promise<bigint> => {
      const h = batchHarness({ gasFee: fee });
      await h.client.batches.submit(line, "1h", { providers: [1] });
      const row = manifestRows(h.uploads[0]!)[0]!;
      return parseUsd((row as { amount: string }).amount, 6);
    };
    expect((await amountFor(9n)) - (await amountFor(7n))).toBe(2n);
  });
});

// ---------------------------------------------------------------------------
// src/batches.ts — BatchHandle: the batch it addresses and the bytes it returns
// ---------------------------------------------------------------------------

describe("batches — the batch a handle addresses and the results it returns", () => {
  /**
   * A client answering one batch row that states **no `status` key at all**,
   * which is the only shape where a bare read and a guarded one differ. The
   * scripted harness always sets one, so this is written by hand.
   */
  function statuslessClient(row: Record<string, unknown>) {
    const sent: string[] = [];
    const files: string[] = [];
    return {
      sent,
      files,
      client: {
        json: vi.fn(async () => row),
        request: vi.fn(async (method: string, path: string) => {
          sent.push(`${method} ${path}`);
          return new Response("{}", { status: 200 });
        }),
        fileContent: vi.fn(async (id: string) => {
          files.push(id);
          return "";
        }),
        fetchBlob: vi.fn(),
        chainContext: vi.fn(),
        uploadFile: vi.fn(),
        sealLine: vi.fn(),
        payLine: vi.fn(),
        models: {},
        signer: null,
        cipher: null,
        resultCipher: vi.fn(async () => null),
        verifier: null,
      } as unknown as ConstructorParameters<typeof BatchHandle>[0],
    };
  }

  // Site: `own(idOrObject, "id")` in the `BatchHandle` constructor.
  it("addresses no batch named only by the create answer's prototype", async () => {
    const h = handleHarness({ statuses: ["completed"] });
    const stolen = polluted("id", "batch_stolen", () => new BatchHandle(h.client, { object: "batch" }));
    // The consequence: every later read on this handle names the empty id, so
    // it cannot be pointed at somebody else's batch.
    expect(stolen.id).toBe("");
  });

  // Site: `own(batch, "output_file_id")` in `BatchHandle.apply`.
  //
  // The file ids decide **which rows are read**, and each row names the bytes
  // `fetchBlob` returns as a line's result — so this is a fetch of
  // attacker-named content, not a display read.
  //
  // Written against a hand-built row that **omits** the key: the scripted
  // harness sends `output_file_id: null`, which is an own property and shadows
  // the prototype in both readings, so a test written on it passes with the
  // guard reverted.
  it("reads no output file the batch row never named", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch", status: "completed" });
    const handle = new BatchHandle(c.client, "batch_1");
    await pollutedAsync("output_file_id", "file_out", async () => {
      await expect(handle.results()).resolves.toEqual([]);
    });
    expect(c.files).toEqual([]);
  });

  // Site: `own(batch, "error_file_id")` in `BatchHandle.apply`.
  it("reads no error file the batch row never named", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch", status: "completed" });
    const handle = new BatchHandle(c.client, "batch_1");
    await pollutedAsync("error_file_id", "file_err", async () => {
      await expect(handle.results()).resolves.toEqual([]);
    });
    expect(c.files).toEqual([]);
  });

  // Site: `own(batch, "completion_window")` in `BatchHandle.apply`.
  it("bounds no batch by a completion window the row never named", async () => {
    const h = handleHarness({
      statuses: ["validating", "in_progress", "in_progress", "completed"],
      completionWindow: null,
    });
    // The window is the default timeout and nothing else — a batch is paced by
    // time spent waiting. A polluted `"2m"` closes the wait at 120 s, before
    // the third sleep this batch needs; the unnamed window is `"24h"`.
    await pollutedAsync("completion_window", "2m", async () => {
      await h.handle.results();
    });
    expect(h.sleeps).toEqual([60, 60, 60]);
  });

  // Site: `own(batch, "request_counts")` in `BatchHandle.apply`.
  it("reports no request counts the batch row never carried", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch", status: "completed" });
    const handle = new BatchHandle(c.client, "batch_1");
    await pollutedAsync("request_counts", { total: 99 }, async () => {
      await handle.status();
    });
    expect(handle.requestCounts).toBeNull();
  });

  // Site: `stated("now")` / `stated("sleep")` in the `BatchHandle` constructor.
  //
  // One guard covers both reads, so reverting it reddens this one test. `now`
  // is the settle deadline's clock: `run` calls it before the loop, so a
  // prototype-supplied one is reached on a batch that is already terminal.
  it("takes no clock or sleep named only by the options record's prototype", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch", status: "completed" });
    const boom = () => {
      throw new Error("prototype clock");
    };
    const handle = polluted("now", boom, () =>
      pollutedAll([["sleep", boom]], () => new BatchHandle(c.client, "batch_1")),
    );
    await expect(handle.results()).resolves.toEqual([]);
  });

  // Site: `BatchHandle.statusOf` — the `CANCELLABLE` gate in `cancel`.
  it("cancels no batch on a status the row never reported", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch" });
    const handle = new BatchHandle(c.client, "batch_1");
    await pollutedAsync("status", "in_progress", async () => {
      await expect(handle.cancel()).rejects.toThrow(/Cannot cancel a batch with status/);
    });
    // The consequence: no cancel left this process.
    expect(c.sent).toEqual([]);
  });

  // Site: `BatchHandle.statusOf` — the terminal test in `run`.
  it("ends no wait, and reads no file, on a status the row never reported", async () => {
    const c = statuslessClient({ id: "batch_1", object: "batch", output_file_id: "file_out" });
    let clock = 0;
    const handle = new BatchHandle(c.client, "batch_1", {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms / 1000;
      },
    });
    await pollutedAsync("status", "completed", async () => {
      await expect(handle.results(1)).rejects.toThrow(/did not settle/);
    });
    expect(c.files).toEqual([]);
  });

  // Site: `own(row, "vorq")` in `BatchHandle.readFile`.
  it("fetches no result bytes named by an output row's prototype vorq block", async () => {
    const evil = new TextEncoder().encode(JSON.stringify({ output: [], usage: {} }));
    const h = handleHarness({
      statuses: ["completed"],
      output: [{ row: { id: "r1" }, cid: "evil", bytes: evil }],
    });
    await pollutedAsync("vorq", { result_cid: "evil" }, async () => {
      await expect(h.handle.results()).rejects.toThrow(/names no result_cid/);
    });
    expect(h.blobReads).toEqual([]);
  });

  // Site: `own(vorq, "result_cid")` in `BatchHandle.readFile`.
  //
  // The consequence is a **fabricated answer returned as a line's result**:
  // `decryptOutput` passes cleartext JSON through unchanged, so bytes at an
  // attacker-named CID are built into a `TextResult` and handed back.
  it("fetches no result bytes named by an output row's prototype result_cid", async () => {
    const evil = new TextEncoder().encode(
      JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "fabricated" }] }],
        usage: {},
      }),
    );
    const h = handleHarness({
      statuses: ["completed"],
      output: [{ row: { id: "r1", vorq: { job_id: "j1" } }, cid: "evil", bytes: evil }],
    });
    await pollutedAsync("result_cid", "evil", async () => {
      await expect(h.handle.results()).rejects.toThrow(/names no result_cid/);
    });
    expect(h.blobReads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// src/batches.ts — the listing
// ---------------------------------------------------------------------------

describe("batches — the page a listing is read from", () => {
  const empty = () =>
    client([...baseRoutes(), [/\/v1\/batches(\?|$)/, () => json({ object: "list" })]]);

  // Site: `own(body, "data")`, `"first_id"`, `"last_id"`, `"has_more"` in `Batches.list`.
  it("lists no batches and no cursor the page never carried", async () => {
    const h = empty();
    const page = await pollutedAllAsync(
      [
        ["data", [{ id: "batch_stolen" }]],
        ["first_id", "batch_stolen"],
        ["last_id", "batch_stolen"],
        ["has_more", true],
      ],
      () => h.client.batches.list(),
    );
    expect(page).toEqual({ batches: [], firstId: null, lastId: null, hasMore: false });
  });
});

// ---------------------------------------------------------------------------
// src/jobs.ts — the status, the window and the result bytes (H3)
// ---------------------------------------------------------------------------

describe("jobs — the row a job's result is fetched and judged from", () => {
  const RESULT = new TextEncoder().encode(
    JSON.stringify({ output: [{ content: [{ type: "output_text", text: "real" }] }], usage: {} }),
  );

  /** A client answering one fixed row, recording every blob fetched. */
  function jobClient(row: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const blobReads: string[] = [];
    const c = {
      json: vi.fn(async () => row),
      request: vi.fn(
        async () =>
          new Response(JSON.stringify(row), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      fetchBlob: vi.fn(async (cid: string) => {
        blobReads.push(cid);
        return RESULT;
      }),
      chainContext: vi.fn(async () => CTX),
      signer: { address: "0xabc", signCancel: vi.fn(async () => "0xsig") },
      cipher: null,
      resultCipher: vi.fn(async () => null),
      ...over,
    } as unknown as ConstructorParameters<typeof JobHandle>[0];
    return { client: c, blobReads };
  }

  const ticking = { now: (() => { let t = 0; return () => (t += 1); })(), sleep: async () => {} };

  // Site: `own(job, "result_cid")` in `JobHandle.settledResult`.
  //
  // Mis-classified as a read-render defect. A polluted `result_cid` turns the
  // `ResultIntegrityError` refusal into a **fetch of attacker-named bytes**,
  // and `decryptOutput` returns cleartext JSON unchanged — so a fabricated
  // answer comes back as this job's result.
  it("fetches no result bytes named by the job row's prototype", async () => {
    // The row **omits** `result_cid` rather than sending `null`: a `null` is
    // an own property and shadows the prototype in both readings, so a test
    // written that way passes with the guard reverted.
    const j = jobClient({ id: "job_1", status: "completed", vorq: { gas_fee: "0.03", fee: "0" } });
    const handle = new JobHandle(j.client, "job_1", ticking);
    await pollutedAsync("result_cid", "evil", async () => {
      await expect(handle.result()).rejects.toThrow(ResultIntegrityError);
    });
    expect(j.blobReads).toEqual([]);
  });

  // Site: `own(vorq, "gas_fee")` in `JobHandle.fetch`.
  it("accepts no job row whose gas fee only the prototype names", async () => {
    const j = jobClient({ id: "job_1", status: "queued", vorq: {} });
    const handle = new JobHandle(j.client, "job_1", ticking);
    await pollutedAsync("gas_fee", "0.03", async () => {
      await expect(handle.status()).rejects.toThrow(/vorq\.gas_fee is not a USD decimal string/);
    });
  });

  // Site: `own(vorq, "fee")` in `JobHandle.fetch`.
  it("accepts no job row whose protocol fee only the prototype names", async () => {
    const j = jobClient({ id: "job_1", status: "queued", vorq: { gas_fee: "0.03" } });
    const handle = new JobHandle(j.client, "job_1", ticking);
    await pollutedAsync("fee", "0", async () => {
      await expect(handle.status()).rejects.toThrow(/vorq\.fee is not a USD decimal string/);
    });
  });

  // Site: `statusOf` at the `=== "completed"` branch in `JobHandle.result`.
  it("settles no job on a status its row never reported", async () => {
    const j = jobClient({ id: "job_1", result_cid: "real", vorq: { gas_fee: "0.03", fee: "0" } });
    const handle = new JobHandle(j.client, "job_1", { ...ticking, sla: "1h" });
    await pollutedAsync("status", "completed", async () => {
      // Read bare, the loop ends at once and `settledResult` fetches. Guarded,
      // the row states nothing terminal and the wait runs out — which is the
      // honest answer for a row that reports no status.
      await expect(handle.result(2)).rejects.toThrow(WaitTimeout);
    });
    expect(j.blobReads).toEqual([]);
  });

  // Site: `slaSecsOf` in `JobHandle.windowFor`.
  it("refuses no job over an SLA window its row never stated", async () => {
    const j = jobClient({ id: "job_1", status: "completed", result_cid: "real", vorq: { gas_fee: "0.03", fee: "0" } });
    const handle = new JobHandle(j.client, "job_1", ticking);
    await pollutedAsync("sla_secs", 0, async () => {
      // Read bare, `windowFor` raises `not a window` for every caller.
      await expect(handle.result()).resolves.toBeInstanceOf(TextResult);
    });
  });

  // Site: `slaSecsOf` in `JobHandle.fetch`.
  it("paces no job by an SLA its row never stated", async () => {
    const j = jobClient({ id: "job_1", status: "completed", result_cid: "real", vorq: { gas_fee: "0.03", fee: "0" } });
    const handle = new JobHandle(j.client, "job_1", ticking);
    await pollutedAsync("sla_secs", 1, async () => {
      await handle.result();
    });
    // The row named none, so the handle stays at its default pacing rather than
    // adopting a one-second window that would time a healthy job out.
    expect(await handle.status()).toBe("completed");
  });

  // Site: `stated("cipher")` in the `JobHandle` constructor.
  it("opens a result with no cipher named only by the options record's prototype", async () => {
    const sealed = new TextEncoder().encode(
      JSON.stringify({
        enc: SEALED_RESULT_VERSION,
        ciphertext: Buffer.from(
          seal(curvePublicKey(RESULT_KEY), new TextEncoder().encode(JSON.stringify({
            output: [{ content: [{ type: "output_text", text: "real" }] }],
            usage: {},
          }))),
        ).toString("base64"),
      }),
    );
    const j = jobClient(
      { id: "job_1", status: "completed", result_cid: "c", vorq: { gas_fee: "0.03", fee: "0" } },
      { cipher: new SealedBoxCipher(RESULT_KEY), fetchBlob: vi.fn(async () => sealed) },
    );
    const handle = polluted("cipher", { publicKey: "00", decrypt: () => { throw new Error("stolen"); } }, () =>
      new JobHandle(j.client, "job_1", ticking),
    );
    // The client's own cipher is what opens it. Read bare, the prototype's
    // stands in and every sealed result fails to open.
    const result = await handle.result();
    expect((result as TextResult).text).toBe("real");
  });

  // Site: `stated("chainNow")` in the `JobHandle` constructor.
  it("pins no cancel reference clock named only by the options record's prototype", async () => {
    const j = jobClient({ id: "job_1", status: "queued", vorq: {} });
    const handle = polluted("chainNow", () => 0, () => new JobHandle(j.client, "job_1", ticking));
    // Read bare, the ±600 s bound is measured against unix second zero and
    // every cancel is refused as `StaleOp` before it is sent.
    await expect(handle.cancelRequest()).resolves.toBeInstanceOf(Response);
  });
});

// ---------------------------------------------------------------------------
// src/results.ts — the bytes a result hands back
// ---------------------------------------------------------------------------

describe("results — the bytes a media or embedding result decodes", () => {
  const EVIL = toBase64(new TextEncoder().encode("fabricated"));
  const jobRow = { id: "job_1", vorq: { rate_in: "0", rate_out: "0", gas_fee: "0.03", fee: "0" } };
  const bytesOf = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

  // Site: `own(frame, "b64")` in `MediaResult.bytes`.
  //
  // The refusal one line below is answered by the same prototype that supplies
  // the value, so a frame carrying nothing decoded to attacker-chosen bytes and
  // was handed back as this job's image.
  it("decodes no frame bytes a frame never carried", () => {
    const result = resultFromRaw(bytesOf({ images: [{ width: 1, height: 1 }] }), jobRow) as MediaResult;
    polluted("b64", EVIL, () => {
      expect(() => result.bytes()).toThrow(/carries no base64 'b64' member/);
    });
  });

  // Site: `own(entry, "embedding")` in `EmbeddingResult.bytes`.
  it("decodes no vector bytes an embedding entry never carried", () => {
    const result = resultFromRaw(
      bytesOf({ object: "list", data: [{ embedding: [0.1] }] }),
      jobRow,
    ) as EmbeddingResult;
    polluted("embedding", EVIL, () => {
      // The entry's own `embedding` is a float array, so the base64 refusal is
      // the honest answer. Read bare it would be shadowed — the prototype is
      // consulted first only when the key is absent, and `inherited` below is
      // the shape that proves the read itself.
      expect(() => result.bytes()).toThrow(/encoding_format='float'/);
    });
  });

  it("decodes no vector bytes from an entry that states none", () => {
    const result = resultFromRaw(
      bytesOf({ object: "list", data: [{ embedding: null }] }),
      jobRow,
    ) as EmbeddingResult;
    // The entry is rebuilt with `embedding` moved onto its prototype, which is
    // the only shape where the bare read and the guarded one differ.
    (result.embeddings as Record<string, unknown>[])[0] = inherited({ embedding: EVIL }, "embedding");
    expect(() => result.bytes()).toThrow(/encoding_format='float'/);
  });

  // Site: `own(frame, "b64")` in `openai-compat.ts`'s `responseObject`.
  it("renders no frame bytes a frame never carried", () => {
    const result = resultFromRaw(bytesOf({ images: [{ width: 1, height: 1 }] }), jobRow) as MediaResult;
    polluted("b64", EVIL, () => {
      const rendered = responseObject({ id: "job_1", status: "completed" }, { result, background: false });
      expect((rendered.output as { result?: unknown }[])[0]!.result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// src/verify.ts — the options record the whole verifier is configured from
// ---------------------------------------------------------------------------

describe("verify — the options record a Verifier is built from", () => {
  const node = () => scriptedNode({ entries: () => ACTIVE });

  // Site: `stated("mode")`.
  //
  // `mode: "mock"` disables three separate refusals — mock provider evidence,
  // mock escrow evidence and a mock allowlist entry. `options` defaults to
  // `{}`, so `new Verifier(url)` read whatever the prototype held.
  it("accepts no mock evidence in a mode the caller never asked for", async () => {
    const v = polluted("mode", "mock", () => new Verifier("http://node", { fetch: node().fetch }));
    await expect(v.verifyRecord(record())).rejects.toThrow(
      /mock evidence is refused outside mock mode/,
    );
  });

  // Site: `stated("minTcbSvn")`.
  it("floors no TCB level at a value the caller never named", async () => {
    const v = polluted(
      "minTcbSvn",
      99,
      () => new Verifier("http://node", { mode: "mock", fetch: node().fetch }),
    );
    // Read bare, an honest `svn: 1` record is refused as below the floor.
    await expect(v.verifyRecord(record())).resolves.toBeUndefined();
  });

  // Site: `stated("fetch")`.
  it("reads no attestation evidence through a transport the caller never passed", async () => {
    const n = node();
    const real = vi.spyOn(globalThis, "fetch").mockImplementation(n.fetch as never);
    const stolen = vi.fn();
    try {
      await pollutedAsync("fetch", stolen, async () => {
        const v = new Verifier("http://node", { mode: "mock" });
        await expect(v.allowlist()).resolves.toEqual(ACTIVE);
      });
    } finally {
      real.mockRestore();
    }
    expect(stolen).not.toHaveBeenCalled();
  });

  // Site: `stated("allowlistTtlS")`.
  it("expires no allowlist cache on a TTL the caller never named", async () => {
    const n = node();
    const v = polluted(
      "allowlistTtlS",
      0,
      () => new Verifier("http://node", { mode: "mock", fetch: n.fetch }),
    );
    await v.allowlist();
    await v.allowlist();
    expect(n.allowlistReads).toBe(1);
  });

  // Site: `stated("clock")`.
  //
  // An **advancing** clock, not a constant one: the TTL test is
  // `now < fetchedAt + ttl`, and both sides move together under a constant
  // clock, so a fixed value cannot tell a polluted clock from the real one.
  it("expires no allowlist cache on a clock the caller never named", async () => {
    const n = node();
    let t = 0;
    const v = polluted(
      "clock",
      () => (t += 1e6),
      () => new Verifier("http://node", { mode: "mock", fetch: n.fetch }),
    );
    await v.allowlist();
    await v.allowlist();
    expect(n.allowlistReads).toBe(1);
  });

  // Site: `stated("wallClock")`.
  it("measures no announcement's freshness against a clock the caller never named", async () => {
    const n = scriptedNode({ entries: () => ESCROW_ACTIVE });
    const now = Math.floor(Date.now() / 1000);
    const v = polluted(
      "wallClock",
      () => now + 1_000_000,
      () => new Verifier("http://node", { mode: "mock", fetch: n.fetch }),
    );
    // Read bare, an announcement stamped a moment ago is refused as stale.
    await expect(
      v.verifyEscrowKey(announcement({ issuedAt: now })),
    ).resolves.toBeDefined();
  });

  // Site: `stated("timeoutMs")`.
  //
  // The transport here **honours the abort signal**, which the scripted node
  // does not: `AbortSignal.timeout(0)` fires on the next tick, so a fetch that
  // ignores it cannot tell a zero timeout from a thirty-second one and a test
  // written on the scripted node passes with the guard reverted.
  it("bounds no chain read by a timeout the caller never named", async () => {
    const aborting = (async (_url: unknown, init: RequestInit = {}) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (init.signal?.aborted) throw new Error("The operation was aborted");
      return Response.json({ entries: ACTIVE });
    }) as unknown as typeof globalThis.fetch;
    const v = polluted(
      "timeoutMs",
      0,
      () => new Verifier("http://node", { mode: "mock", fetch: aborting }),
    );
    await expect(v.allowlist()).resolves.toEqual(ACTIVE);
  });
});

// ---------------------------------------------------------------------------
// src/crypto/cipher.ts — who a cipher seals to
// ---------------------------------------------------------------------------

describe("cipher — the recipient a sealed box is addressed to", () => {
  // Site: `own(options, "recipientPublicKey")` in the `SealedBoxCipher`
  // constructor. `SealedBoxCipher.fromSeed` — which `deriveResultCipher` calls
  // — reaches this with `options` defaulting to `{}`, so a polluted prototype
  // points **every derived result cipher** at a key the caller never named.
  it("seals to no recipient the caller never named", () => {
    const stolen = "cd".repeat(32);
    const cipher = polluted("recipientPublicKey", stolen, () =>
      SealedBoxCipher.fromSeed(new Uint8Array(32).fill(0x33)),
    );
    expect(() => cipher.encrypt(new Uint8Array([1, 2, 3]))).toThrow();
  });

  // The other direction: a recipient the caller really does pass still seals.
  it("still seals to a recipient the caller states", () => {
    const cipher = new SealedBoxCipher(new Uint8Array(32).fill(0x33), {
      recipientPublicKey: RECIPIENT_PUBLIC,
    });
    expect(cipher.encrypt(new Uint8Array([1, 2, 3])).length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// src/errors.ts — the wire error envelope
// ---------------------------------------------------------------------------

describe("errors — the envelope a wire error is rendered from", () => {
  // Site: `own(body, "error")`.
  it("renders no error envelope the response body never carried", () => {
    const error = polluted("error", { message: "fabricated", type: "fabricated_type" }, () =>
      errorFromWire(400, {}, { requestId: null }),
    );
    expect(error.message).toBe("HTTP 400");
    expect(error.type).toBeNull();
  });

  // Site: `own(record, "message")` / `own(record, "type")`.
  //
  // The body carries an **own, empty** `error` envelope, so the guard one line
  // up cannot mask this one: without it the envelope read short-circuits and
  // these two are never reached at all.
  it("renders no message or type the error envelope never carried", () => {
    const error = pollutedAll(
      [
        ["message", "fabricated"],
        ["type", "fabricated_type"],
      ],
      () => errorFromWire(400, { error: {} }, { requestId: null }),
    );
    expect(error.message).toBe("HTTP 400");
    expect(error.type).toBeNull();
  });

  it("still renders a message and type the body states", () => {
    const error = errorFromWire(400, { error: { message: "real", type: "real_type" } }, {
      requestId: null,
    });
    expect(error.message).toBe("real");
    expect(error.type).toBe("real_type");
  });
});

// ---------------------------------------------------------------------------
// src/files.ts — the gateway retry pause
// ---------------------------------------------------------------------------

describe("files — the retry pause a gateway read takes", () => {
  // Site: the `sleep` **destructuring default** in `fetchBlob`. `Client`
  // builds this record with no own `sleep`, so the default fires and the
  // prototype answered first.
  it("pauses through no sleep the caller never passed", async () => {
    let n = 0;
    const stolen = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? new Response("gone", { status: 404 }) : new Response(new Uint8Array([7]));
    });
    await pollutedAsync("sleep", stolen, async () => {
      const bytes = await fetchBlob({
        cid: "c",
        gateway: "http://gw",
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      });
      expect(bytes).toEqual(new Uint8Array([7]));
    });
    expect(stolen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// src/signer/* — the wallet key and the wallet a signer binds to
// ---------------------------------------------------------------------------

describe("signer — the key a wallet is built from and the wallet it discovers", () => {
  // The payment authorization has no caller-supplied overrides left: every
  // member but the amount is derived from the order and the `ChainContext`, so
  // `signPaymentAuthorization` reads nothing off its args record that a
  // prototype could answer for.

  // Site: `own(options, "keyEnv")` in the `PrivateKeySigner` constructor.
  it("consults no environment variable the caller never named", () => {
    polluted("keyEnv", "STOLEN_ENV", () => {
      expect(() => new PrivateKeySigner()).toThrow(/\$VORQ_WALLET_KEY/);
    });
  });

  // Site: `stated("window")` in `BrowserWalletSigner.discover`.
  //
  // Written with a **real own `globalThis.window`** in place, because that is
  // the shape the guard is observable in: in a browser `window` is an own
  // property of the global, so a caller that passes no `window` option must
  // reach it and not `Object.prototype.window`. (Under the node project there
  // is no own `globalThis.window`, so the fallback would itself walk the
  // prototype and the two readings could not be told apart — which is why this
  // test installs one rather than relying on the environment.)
  it("dispatches wallet discovery into no window the caller never passed", async () => {
    const spy = () => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const real = spy();
    const stolen = spy();
    Object.defineProperty(globalThis, "window", { value: real, configurable: true });
    try {
      const found = await pollutedAsync("window", stolen, () =>
        BrowserWalletSigner.discover({ timeoutMs: 0 }),
      );
      expect(found).toEqual([]);
      expect(real.dispatchEvent).toHaveBeenCalledTimes(1);
      expect(stolen.addEventListener).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  // Site: `stated("timeoutMs")` in `BrowserWalletSigner.discover`.
  it("waits through no discovery window the caller never passed", async () => {
    const win = {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const started = Date.now();
    // The caller states **no** `timeoutMs`, which is the only shape where the
    // prototype is consulted: read bare, a polluted 5000 parks every discovery
    // for five seconds, where the stated default is 100 ms.
    await pollutedAsync("timeoutMs", 5000, () =>
      BrowserWalletSigner.discover({ window: win as never }),
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ===========================================================================
// The environment is a record too.
//
// `process.env.X` for an **unset** `X` returns `Object.prototype.X`. The
// previous round's enumeration drew its scope at records off `JSON.parse` and
// at caller arguments, and never asked whether an environment is one — so all
// three of these sat unguarded on the **default** construction path, reachable
// with no other precondition, and every one of them reproduced against the
// built `dist/` with no mutation at all.
// ===========================================================================

describe("the environment — an unset variable is answered by the prototype", () => {
  // Site: `envValue("VORQ_PIN_GATEWAY")` in `resolveGateway`.
  //
  // The gateway is **where every result blob is fetched from**. With the
  // variable unset and no `gateway` option — the default client — a bare read
  // hands a polluted prototype the host for every `fetchBlob`, and the honest
  // CID is then requested from it. Nothing recomputes the name, and
  // `decryptOutput` returns cleartext JSON unchanged, so the bytes that come
  // back are returned as the job's result. Measured against `dist/` before the
  // fix: `https://attacker.example`.
  it("reads no gateway from the prototype when the variable is unset", () => {
    polluted("VORQ_PIN_GATEWAY", "https://attacker.example", () => {
      expect(resolveGateway(undefined)).toBe("https://ipfs.filebase.io");
    });
  });

  // The consequence, end to end: which host a settled job's bytes come from.
  it("fetches a settled job's result from no host the prototype named", async () => {
    const fetched: string[] = [];
    const body = JSON.stringify({
      output: [{ content: [{ type: "output_text", text: "honest" }] }],
      usage: {},
    });
    const impl = (async (url: string | URL) => {
      const href = String(url);
      fetched.push(href);
      if (href.includes("/ipfs/")) return new Response(body, { status: 200 });
      return json({ id: "job_1", status: "completed", result_cid: "bafyHONEST", vorq: { gas_fee: "0.03", fee: "0" } });
    }) as unknown as typeof globalThis.fetch;
    // No `gateway` option, which is the shape the defect lives on: the client
    // falls through to the environment and then to the built-in default.
    const c = Client.fromSessionToken("vorq_sess_test", { baseUrl: "http://node", fetch: impl });
    const result = await pollutedAsync("VORQ_PIN_GATEWAY", "https://attacker.example", () =>
      c.job("job_1").result(),
    );
    expect((result as TextResult).text).toBe("honest");
    expect(fetched.some((u) => u.startsWith("https://ipfs.filebase.io/ipfs/bafyHONEST"))).toBe(true);
    expect(fetched.some((u) => u.includes("attacker.example"))).toBe(false);
  });

  // Site: `envKey(keyEnv)` in the `PrivateKeySigner` constructor.
  //
  // Fail-closed turned fail-open. Measured against `dist/` before the fix:
  // `new PrivateKeySigner()` stopped throwing and built a signer over
  // `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A` — an **attacker-chosen private
  // key**. Every order would be signed by that wallet, and `deriveResultCipher`
  // derives the result key from it, so the attacker would hold the key every
  // result is sealed to.
  it("builds no wallet from a key the prototype supplied", () => {
    polluted("VORQ_WALLET_KEY", "0x" + "11".repeat(32), () => {
      expect(() => new PrivateKeySigner()).toThrow(/no wallet key/);
    });
  });

  // Site: `envValue("VORQ_SETTLEMENT_MARGIN")` in `client.ts`.
  //
  // Read at **module-evaluation time**, so the pollution has to precede the
  // import — which is what `resetModules` plus a dynamic import inside the
  // polluted window buys. It moves an order's `expiresAt`, a signed term.
  it("takes no settlement margin from the prototype", async () => {
    const margin = await pollutedAsync("VORQ_SETTLEMENT_MARGIN", "1", async () => {
      vi.resetModules();
      const fresh = (await import("../src/client.js")) as { SETTLEMENT_MARGIN_SECONDS: number };
      return fresh.SETTLEMENT_MARGIN_SECONDS;
    });
    expect(margin).toBe(3600);
    vi.resetModules();
  });

  // Site: the `Object.hasOwn(globalThis, "process")` hop in all three readers.
  //
  // A browser realm has no own `process`, so a bare read there lets a polluted
  // prototype **manufacture an environment** where the docblocks promise there
  // is none and the caller must pass the value explicitly.
  it("manufactures no environment in a realm that has no process", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "process")!;
    delete (globalThis as { process?: unknown }).process;
    try {
      pollutedAll(
        [
          ["process", { env: { VORQ_PIN_GATEWAY: "https://attacker.example" } }],
          ["VORQ_PIN_GATEWAY", "https://attacker.example"],
        ],
        () => {
          expect(resolveGateway(undefined)).toBe("https://ipfs.filebase.io");
        },
      );
    } finally {
      Object.defineProperty(globalThis, "process", saved);
    }
  });
});

// ---------------------------------------------------------------------------
// src/signer/browser-wallet.ts — the global a discovery dispatch reaches
// ---------------------------------------------------------------------------

describe("browser-wallet — the global a discovery dispatch reaches", () => {
  // Site: `Object.hasOwn(globalThis, "window")` in `discover`.
  //
  // A previous round left this bare on the reasoning that "a realm with no
  // `window` has no wallet to steal". That was wrong in the direction that
  // matters: pollution does not steal a wallet, it **manufactures** one.
  it("manufactures no wallet in a realm that has no window", async () => {
    expect(Object.hasOwn(globalThis, "window")).toBe(false);
    const provider = { request: vi.fn() };
    const stolen = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      ethereum: provider,
    };
    const found = await pollutedAsync("window", stolen, () =>
      BrowserWalletSigner.discover({ timeoutMs: 0 }),
    );
    // Read bare this answered one wallet whose `provider` was `provider`, and
    // `BrowserWalletSigner.from` would have routed every signature through it.
    expect(found).toEqual([]);
    expect(stolen.dispatchEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// src/client.ts — the sealed line a payment is authorized from
// ---------------------------------------------------------------------------

describe("client — the sealed line payLine authorizes", () => {
  // Site: `stated("terms")` / `"url"` / `"order"` / `"container"` / `"jobId"`
  // in `Client.payLine`.
  //
  // Guarded on the public-and-reachable reasoning: `payLine` is a public
  // `Client` member and `SealedLine` is on the barrel. `capFor(terms)` is the
  // cap half of `amount`, which is the value the line authorizes.
  it("authorizes no line whose members come from the prototype", async () => {
    const { client: c } = client(baseRoutes());
    const ctx = await c.chainContext();
    const honest = await c.sealLine({
      model: "m",
      payloadInput: { input: "hi" },
      window: "1h",
      url: "/v1/responses",
      rateIn: "0",
      rateOut: "0",
      provider: 1,
      ctx,
    });
    // Every member moved onto the prototype: read bare, the row builds from it
    // exactly as if the caller had passed one.
    const bare = Object.create(honest) as typeof honest;
    await expect(c.payLine(bare, 7n, ctx, 0n)).rejects.toThrow();
  });

  it("still authorizes a line that states its own members", async () => {
    const { client: c } = client(baseRoutes());
    const ctx = await c.chainContext();
    const line = await c.sealLine({
      model: "m",
      payloadInput: { input: "hi" },
      window: "1h",
      url: "/v1/responses",
      rateIn: "0",
      rateOut: "0",
      provider: 1,
      ctx,
    });
    const amountOf = async (fee: bigint): Promise<bigint> =>
      parseUsd(((await c.payLine(line, fee, ctx, 0n)) as { amount: string }).amount, 6);
    const row = await c.payLine(line, 7n, ctx, 0n);
    expect(row.url).toBe("/v1/responses");
    expect(row.container).toBe(toBase64(line.container));
    // Differential, for the reason the batch gas-fee test is: the total is
    // `capFor(terms) + gasFee`, and asserting the difference two fees make pins
    // the terms that were actually read rather than the arithmetic around them.
    expect((await amountOf(9n)) - (await amountOf(7n))).toBe(2n);
  });
});

// ---------------------------------------------------------------------------
// src/sla.ts — the window a job's declared seconds map to
// ---------------------------------------------------------------------------

describe("sla — the window a job's declared seconds name", () => {
  // Site: `Object.hasOwn(SECONDS_WINDOW, parsed)` in `windowFromSeconds`.
  //
  // The untrusted thing is the **key**: `SECONDS_WINDOW` is this package's own
  // table, but `parsed` is `Number(String(vorq.sla_secs))` off the coordinator's
  // row and is any positive integer. A previous round justified leaving this
  // bare as "the key is regex- or `Number`-constrained" — true of `slaSeconds`,
  // false here. Measured: `windowFromSeconds(12345)` returned
  // `"SUPPLIED-BY-PROTOTYPE"`.
  it("names no window from the prototype for a non-standard sla_secs", () => {
    polluted("12345", "1s", () => {
      expect(windowFromSeconds(12345)).toBe("12345s");
    });
  });

  // The consequence: the window drives `result()`'s timeout, so a polluted
  // `"1s"` raises `WaitTimeout` on a job that is running normally.
  it("gives a job on a non-standard window no one-second timeout", () => {
    polluted("12345", "1s", () => {
      expect(slaSeconds(windowFromSeconds(12345)!)).toBe(12345);
    });
  });

  // The other direction: the two windows the table really does state still map.
  it("still names the windows the table states", () => {
    expect(windowFromSeconds(3600)).toBe("1h");
    expect(windowFromSeconds(86400)).toBe("24h");
  });
});
