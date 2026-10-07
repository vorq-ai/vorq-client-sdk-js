/**
 * The `batches` namespace and `BatchHandle`.
 *
 * A batch fans many requests out at once, and **every line is sealed before
 * anything is uploaded**. Each line is a complete submission — the same order,
 * the same container v1, the same payment authorization that `POST /v1/jobs` takes —
 * so the file the coordinator receives carries routing terms and ciphertext and
 * nothing a reader could act on. The coordinator splits it, files each
 * container, and lands the lines on chain in as few transactions as the block
 * will take.
 *
 * The JSONL is not a payload the node keeps; it is a file of sealed envelopes it
 * pins like every other container. Results come back sealed to this client's own
 * key, named on each output row by `result_cid`, and are read from the storage
 * gateway rather than from the file — the row names the bytes, it never carries
 * them.
 *
 * **The imports from `./client.js` are type-only, and keeping them so keeps the
 * emitted module graph acyclic.** `client.ts` imports `Batches` as a *value* to
 * construct it, so a runtime import back the other way would close a real cycle;
 * a type-only import is erased before the emitted JS exists, so it closes
 * nothing.
 *
 * **Correcting the record: that cycle would not actually break.** This comment
 * used to claim a value import "surfaces as an undefined class at construction",
 * and it does not. The package is `"type": "module"`, and ESM tolerates this
 * shape — verified on a standalone two-module reproduction of exactly it, which
 * constructs correctly from either entry point, because `Batches` is referenced
 * only at call time and a hoisted function declaration is initialized before
 * either module body runs. So this rule is hygiene with a real benefit, not a
 * crash anyone would see, and it is stated that way because a comment asserting
 * a checkable fact that is untrue is worse than no comment at all. What the rule
 * buys is that nothing here depends on ESM's evaluation order staying forgiving:
 * move one of those references to module-evaluation time and the tolerance ends.
 *
 * Where a helper is genuinely wanted on both sides, the answer is neither a
 * cycle nor a copy — it is a third module both import and neither owns. That is
 * what `scalars.ts` is.
 */

import { BatchFailed, EscrowKeyUnverified, ValidationError, VorqError, WaitTimeout } from "./errors.js";
import { defaultSleep, monotonicNow } from "./jobs.js";
import { own } from "./own.js";
import { checkInput } from "./params.js";
import {
  JobError,
  resultFromBatchLine,
  type EmbeddingResult,
  type MediaResult,
  type TextResult,
} from "./results.js";
import { formatUsd, isUsd, parseUsd } from "./money.js";
import { parseCeiling } from "./terms.js";
import { asBigInt } from "./scalars.js";
import { declareUnits } from "./units.js";
import { normalizeSla, pollInterval, slaSeconds } from "./sla.js";
import type { SealLineArgs, SealedLine, VorqFile } from "./client.js";
import type { Models } from "./models.js";
import type { Cipher, Signer } from "./signer/types.js";
import type { ChainContext } from "./terms.js";
import type { RequestOptions } from "./transport.js";
import type { Verifier } from "./verify.js";

/**
 * What `Batches` and `BatchHandle` need from a client — the same narrow shape
 * `JobClient` is (`jobs.ts:31`), for the same reason: the namespace is testable
 * without a `Client`, and the client that satisfies this has a settled shape to
 * satisfy.
 *
 * `sealLine` and `payLine` are public `Client` members precisely so this
 * interface can name them; an interface cannot name a private one. `fetchBlob`
 * and `fileContent` are here for `BatchHandle`, which reads a finished output
 * file and then the bytes each of its rows names.
 */
export interface BatchClient {
  json<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  fetchBlob(cid: string): Promise<Uint8Array>;
  chainContext(): Promise<ChainContext>;
  uploadFile(filename: string, purpose: string, content: Uint8Array | string): Promise<VorqFile>;
  fileContent(fileId: string): Promise<string>;
  sealLine(args: SealLineArgs): Promise<SealedLine>;
  modelIdFor(model: string): Promise<number>;
  payLine(
    line: SealedLine,
    gasFee: bigint,
    ctx: ChainContext,
    feeBps: bigint,
  ): Promise<Record<string, unknown>>;
  readonly models: Models;
  readonly signer: Signer | null;
  readonly cipher: Cipher | null;
  resultCipher(): Promise<Cipher | null>;
  /**
   * Read for one question only: may this client rest an **open** batch? The
   * escrow key is verified inside `sealLine`, which is where a single open
   * `submit` verifies it too — this namespace never calls the verifier itself.
   */
  readonly verifier: Verifier | null;
}

/** The two endpoints a batch line may name. */
const ENDPOINTS = ["/v1/responses", "/v1/embeddings"] as const;
const DEFAULT_ENDPOINT = "/v1/responses";

/** The windows `POST /v1/batches` accepts (`routes/batches.ts:45`). */
const WINDOWS = ["1h", "24h"];

const MAX_CUSTOM_ID_CHARS = 64;

/**
 * Accept an array of line objects, or a **JSONL string holding the lines**.
 *
 * Deliberate divergence from the authority, and the only one this file makes to
 * its inputs: Python's `_load_requests` treats a string as a *path* and opens
 * it. This package runs in browsers, where there is no such thing to open, so a
 * string is content. A caller with a file reads it and passes the text.
 *
 * A line that will not parse is named. Python lets `json.loads` raise its own
 * decode error; here the line number is in hand and a bare `SyntaxError` out of
 * the middle of a submit tells a caller nothing about *which* of forty thousand
 * lines is the broken one.
 */
function loadRequests(requests: Record<string, unknown>[] | string): Record<string, unknown>[] {
  if (typeof requests !== "string") return [...requests];
  const lines: Record<string, unknown>[] = [];
  let n = 0;
  for (const raw of requests.split("\n")) {
    n += 1;
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as Record<string, unknown>);
    } catch (error) {
      throw new ValidationError(
        `line ${n}: the batch file is JSONL and this line is not valid JSON ` +
          `(${(error as Error).message})`,
        { type: "invalid_request_error" },
      );
    }
  }
  return lines;
}

/**
 * The endpoint one line names, defaulting to the Responses surface.
 *
 * An embeddings line and a responses line settle differently — one is metered
 * on input alone — so a batch is for one endpoint and the create call says
 * which. A file mixing the two is refused here rather than at the coordinator,
 * because the caller can see which line disagrees and the coordinator cannot.
 */
function endpointOf(line: Record<string, unknown>, n: number): string {
  // Own properties only: a batch line arrives from a caller's array or from
  // `JSON.parse` over a JSONL file, and the package rule (`own.ts`) covers
  // both. Read bare, a polluted `Object.prototype.url` gives every line in the
  // file the same endpoint — and a file whose lines all agree on an endpoint
  // nobody wrote is a batch metered and settled as the wrong kind.
  const rawUrl = own(line, "url");
  const url = rawUrl === undefined ? DEFAULT_ENDPOINT : String(rawUrl);
  if (!(ENDPOINTS as readonly string[]).includes(url)) {
    throw new ValidationError(
      `line ${n}: url must be one of ${ENDPOINTS.join(", ")}, got ${JSON.stringify(url)}`,
      { type: "invalid_request_error" },
    );
  }
  return url;
}

/**
 * Round-robin across the designated providers, or `undefined` for an open
 * order sealed to the escrow key — `_batches.py:272`'s `_provider_for` exactly,
 * which answers `None` on an empty list.
 *
 * The empty case is spelled out rather than left to fall out of the arithmetic.
 * `index % 0` is `NaN` and `providers[NaN]` is `undefined`, so the old
 * `as number` cast produced the right value by accident while telling every
 * reader and the type checker that it could not happen.
 */
const providerFor = (providers: number[], index: number): number | undefined =>
  providers.length === 0 ? undefined : (providers[index % providers.length] as number);

/**
 * One line's model-owned input: its body without the routing keys.
 *
 * A fresh object every time rather than a `delete` over the caller's own body:
 * `submit` is handed the caller's array and must give it back unchanged.
 */
const ROUTING_KEYS = new Set(["model", "max_rate_in", "max_rate_out", "units_out"]);
const inputOf = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([k]) => !ROUTING_KEYS.has(k)));

export interface BatchSubmitOptions {
  /**
   * The providers this batch is spread across, round-robin.
   *
   * An **empty list is an open batch**: every line is sealed to the
   * coordinator's verified escrow key instead of to a named operator. That
   * needs a client built with `verifier`, and is refused without one — which is
   * why this member is required rather than optional, so the empty case is
   * written on purpose.
   */
  providers: number[];
  /** At most 16 pairs, 64-character keys, 512-character string values. */
  metadata?: Record<string, string>;
  /** Check each distinct model's input against its schema first. Default `true`. */
  validateParams?: boolean;
}

export class Batches {
  constructor(private readonly client: BatchClient) {}

  /**
   * Seal, sign, pay and upload every line, then create the batch.
   *
   * `requests` is an array of OpenAI batch request lines (`{custom_id, method,
   * url, body: {model, …}}`) or a JSONL string holding them. Every line is
   * sealed to its recipient inside this process; nothing leaves it in the clear.
   *
   * A line's `max_rate_in` / `max_rate_out` are the most it pays, each optional.
   * Before anything is sealed the coordinator plans who takes each line within
   * its ceilings and at which ask; a planned line signs that ask and is pinned
   * to its provider. A line the plan cannot place **rests** at its ceilings, a
   * side with no ceiling at the market rate.
   *
   * `providers` is how the resting lines spread. Given a list, they are designated
   * round-robin across it — one batch running across several operators, each
   * able to open only its own lines. Given an **empty** list, each is an
   * open order: sealed to the coordinator's verified escrow key and claimable
   * by any provider that clears the terms, which spreads further than a fixed
   * list can. That path requires a client built
   * with `verifier`, exactly as a single open `submit` does — an escrow key
   * that cannot be checked is not one this SDK will seal to.
   *
   * **Deliberate divergence, in the spelling only.** Python's `providers` is
   * optional and defaults to `None` (`_batches.py:87`), so omitting it opens the
   * batch; here it is **required**, so the open case has to be written as
   * `{ providers: [] }`. The same two behaviours, one of them harder to reach
   * by accident: an open batch rests its money on a key the caller should have
   * meant to verify.
   *
   * `custom_id` is optional (1–64 characters, unique within the batch) and
   * **travels sealed inside its line's container**, coming back inside the
   * sealed result. It is never on the wire in the clear and the coordinator
   * never holds it. Lines correlate by `job_id` — the content job id, listed in
   * input order on `BatchHandle.jobIds` — until their results are opened.
   *
   * One network round trip prices the whole batch: the chain's `gas_fee` is
   * read once, from the `402` quote for the first line's own order, and every
   * line's cap is computed locally from the rates and unit counts it signs.
   */
  async submit(
    requests: Record<string, unknown>[] | string,
    completionWindow = "24h",
    options: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const window = normalizeSla(completionWindow);
    if (!WINDOWS.includes(window)) {
      // The SDK is what turned a tier name into a window, so the coordinator's
      // own `invalid_completion_window` would name a value the caller never
      // typed. Refuse it here, showing both spellings.
      throw new ValidationError(
        `a batch's completion window must be one of ${WINDOWS.join(", ")}; ` +
          `${JSON.stringify(completionWindow)} resolves to ${JSON.stringify(window)}, ` +
          "which POST /v1/batches does not accept",
        { type: "invalid_request_error" },
      );
    }
    if (this.client.signer === null || (await this.client.resultCipher()) === null) {
      throw new ValidationError(
        "batch submissions are always sealed: set $VORQ_WALLET_KEY or pass a signer " +
          "(new Client({ signer }))",
        { type: "invalid_request_error" },
      );
    }
    // Normalised **once**, rather than an optional chain at one of the three
    // reads and a bare property access at the other two. The type makes
    // `options` required, but a plain-JS caller writing `submit(lines)` should
    // meet the `providers` refusal below — which names the remedy — rather than
    // a `TypeError` about reading a property of undefined. Doing that at only
    // the first read leaves a reader to prove the other two are unreachable.
    const opts = (options ?? { providers: [] }) as unknown as Record<string, unknown>;
    // Own properties only on the options object too — it is the caller's, and
    // `providers` decides **who each line is sealed to**. A polluted
    // `Object.prototype.providers` would designate a batch the caller submitted
    // open, or vice versa: a change of who can read the payload, from a key
    // nobody passed (`own.ts`).
    const providers = (own(opts, "providers") as number[] | undefined) ?? [];
    const lines = loadRequests(requests);
    if (lines.length === 0) {
      throw new ValidationError("the batch contains no requests", {
        type: "invalid_request_error",
      });
    }
    // -- everything checkable locally, before a single byte is sealed --------
    //
    // Sealing is the expensive half and it is per line; a file with a typo on
    // line 40 000 should cost nothing but the read.
    const seen = new Set<string>();
    const byModel = new Map<string, number[]>();
    const endpoints = new Set<string>();
    lines.forEach((line, i) => {
      const n = i + 1;
      // A JSONL `null`, a bare array, a number: `loadRequests` promises that a
      // line it cannot use is **named**, and reaching for `.custom_id` on one
      // would break that promise with a bare `TypeError` carrying no line
      // number. The declared element type says this cannot happen; JSONL and a
      // plain-JS caller both say otherwise.
      const shape: unknown = line;
      if (typeof shape !== "object" || shape === null || Array.isArray(shape)) {
        throw new ValidationError(
          `line ${n}: a batch line must be a JSON object with a body, got ` +
            `${shape === null ? "null" : JSON.stringify(shape)}`,
          { type: "invalid_request_error" },
        );
      }
      // Own properties only on `line` and on `line.body` throughout this method
      // (`own.ts`). Both are the caller's records; `max_rate_in`/`max_rate_out`
      // on a body bound **signed, settled terms**, so a prototype-supplied
      // ceiling is a price this SDK would sign up to on the caller's behalf.
      const customId = own(line, "custom_id");
      if (customId !== undefined && customId !== null) {
        if (
          typeof customId !== "string" ||
          customId === "" ||
          customId.length > MAX_CUSTOM_ID_CHARS
        ) {
          throw new ValidationError(
            `line ${n}: custom_id must be a 1-${MAX_CUSTOM_ID_CHARS} character string`,
            { type: "invalid_request_error" },
          );
        }
        if (seen.has(customId)) {
          throw new ValidationError(`line ${n}: duplicate custom_id "${customId}"`, {
            type: "invalid_request_error",
          });
        }
        seen.add(customId);
      }
      const body = own(line, "body");
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !own(body as Record<string, unknown>, "model")
      ) {
        throw new ValidationError(`line ${n}: body.model is required`, {
          type: "invalid_request_error",
        });
      }
      endpoints.add(endpointOf(line, n));
      // **Masked by the `own(body, "model")` refusal four lines up**: reaching
      // here means the key is own and truthy. Kept own anyway, because nothing
      // enforces that ordering — move the refusal and this is a bare read again.
      const model = String(own(body as Record<string, unknown>, "model"));
      byModel.set(model, [...(byModel.get(model) ?? []), i]);
    });

    if (endpoints.size > 1) {
      throw new ValidationError(
        "a batch is for one endpoint and this file names " +
          `${[...endpoints].sort().join(", ")}: an embeddings line and a responses ` +
          "line are metered differently and settle differently",
        { type: "invalid_request_error" },
      );
    }
    const endpoint = [...endpoints][0] as string;

    // **This flag decides whether a submit is refused at all, not merely
    // whether a warning prints.** `checkInput` *throws* on a `false` subschema
    // — the network forbidding a param outright — and on a value that
    // contradicts the published schema, and that throw is outside the `try`
    // below, which swallows only a failed *lookup*. So `validateParams: false`
    // is a real opt-out of a real refusal, and the suite pins both directions.
    if (own(opts, "validateParams") !== false) {
      // One schema lookup per distinct model, not per line: forty thousand lines
      // over one model is one read.
      for (const [model, indexes] of byModel) {
        let schema: unknown = null;
        try {
          schema = await this.client.models.paramsSchema(model);
        } catch {
          schema = null; // a discovery hiccup never blocks a submit
        }
        for (const i of indexes) {
          // **Masked by the pre-flight loop's own `own(line, "body")` shape
          // refusal**, which every index in `byModel` has already passed.
          const body = own(lines[i] as Record<string, unknown>, "body") as Record<string, unknown>;
          // Same divergence as `submit`, in mechanism only: Python raises a
          // `UserWarning` from inside `check_input`, and there is no such
          // channel here, so the warnings are returned and this line is what
          // makes them visible.
          for (const warning of checkInput(schema, inputOf(body))) console.warn(warning);
        }
      }
    }

    // -- the plan: who takes each line, at which rates -----------------------
    const ctx = await this.client.chainContext();
    const picks = await this.plan(lines, window, ctx.decimals);
    if (
      providers.length === 0 &&
      this.client.verifier === null &&
      picks.some((pick) => pick.provider === undefined)
    ) {
      // A line the plan could not place rests, and with no providers to
      // designate it rests as an open order, sealed to the coordinator's escrow
      // key. A client built with a verifier can check that key; one built
      // without cannot, and fails closed here — before a byte is sealed, which
      // is the whole point of checking it at this door rather than at the first
      // line's `sealLine`. Same policy as a single open `submit`.
      throw new EscrowKeyUnverified(
        "no provider is within the ceilings of every line, so some would rest as open " +
          "orders, which are sealed to the coordinator's escrow key — and this client has " +
          "no verifier to check that key with. Build the client with `verifier`, or name " +
          "the providers to designate: batches.submit(lines, window, { providers: [id, …] })",
        { type: "invalid_request_error" },
      );
    }

    // -- seal every line ----------------------------------------------------
    const sealed: SealedLine[] = [];
    for (const [i, line] of lines.entries()) {
      // Read the routing keys off the body rather than removing them from it:
      // the routing keys and the model-owned input go to different places, and
      // the body belongs to the caller.
      // **`body` here is masked by the pre-flight loop's own read of the same
      // key**, which refused every line whose body was not an own object with a
      // model. `units_out` and `custom_id` below are **not** masked by
      // anything: they are read here and nowhere else.
      const body = own(line, "body") as Record<string, unknown>;
      const unitsOut = own(body, "units_out");
      const pick = picks[i]!;
      sealed.push(
        await this.client.sealLine({
          // Masked by the same pre-flight refusal as the `body` read above.
          model: String(own(body, "model")),
          payloadInput: inputOf(body),
          window,
          url: endpoint,
          rateIn: pick.rateIn,
          rateOut: pick.rateOut,
          // Not planned: the line rests, spread across `providers`.
          provider: pick.provider ?? providerFor(providers, i),
          // **Handed over as it is, never `Number(...)`.** `declareUnits`
          // refuses a `units_out` that is not an integer *by type*, exactly as
          // the authority does, and coercing here would defeat that: `true`
          // becomes a perfectly good `1` and `"5"` a perfectly good `5`, so this
          // SDK would sign an order for units the other one rejects outright.
          // Only absence is normalised, because `null` means "unset" on a wire
          // line and `Number(null)` is `0` — an order with no output leg at all.
          unitsOut:
            unitsOut === undefined || unitsOut === null ? undefined : (unitsOut as number),
          customId:
            typeof own(line, "custom_id") === "string"
              ? (own(line, "custom_id") as string)
              : undefined,
          ctx,
        }),
      );
    }

    // -- one quote for the whole batch --------------------------------------
    //
    // Read **after** the sealing loop, and the order is the design. A client
    // that read the fee first and sealed afterwards would be the same client;
    // one that read it first and *re-sealed* afterwards would mint a fresh seed,
    // a fresh commitment and a fresh job id for every line it had already paid
    // to encrypt. The quote below is asked with the first line's own signed
    // order, which only exists because the loop above has already run.
    const { gasFee, feeBps } = await this.fees(sealed[0] as SealedLine, ctx);
    const rows: string[] = [];
    for (const line of sealed) {
      // Serialized as it is produced.
      rows.push(JSON.stringify(await this.client.payLine(line, gasFee, ctx, feeBps)));
    }
    const content = `${rows.join("\n")}\n`;

    const file = await this.client.uploadFile("batch.jsonl", "batch", content);
    const create: Record<string, unknown> = {
      input_file_id: file.id,
      endpoint,
      completion_window: window,
    };
    // Truthy-equivalent, matching the authority's `if metadata:`: an empty map
    // and an absent one are the same request, so the key is omitted for both
    // rather than sending a `{}` the coordinator would parse into the `{}` it
    // already defaults to.
    // Own properties only, same rule: batch metadata is plaintext by design and
    // goes on the wire, so a prototype-supplied map would label somebody's
    // batch with keys they never wrote (`own.ts`).
    const metadata = own(opts, "metadata") as Record<string, string> | undefined;
    if (metadata !== undefined && Object.keys(metadata).length > 0) {
      create.metadata = metadata;
    }
    const batch = await this.client.json<Record<string, unknown>>("POST", "/v1/batches", {
      json: create,
      retry: false,
    });
    const handle = new BatchHandle(this.client, batch);
    handle.jobIds = sealed.map((line) => line.jobId);
    return handle;
  }

  /**
   * The two fees a line's payment has to cover, read once, from a real quote for
   * a real order.
   *
   * A terms-only `POST /v1/jobs` is stateless and posts nothing — it is the
   * challenge half of the single-job exchange — so asking it costs one request
   * and commits nothing. Using the first line's own signed order rather than an
   * invented one keeps the question honest: the answer is the fee that line
   * will actually be charged, and every other line in the batch is charged the
   * same fee in the same block.
   *
   * **Only `gas_fee` and `fee_bps` are read out of this quote.** The token and
   * the payee each authorization names come from the chain context and never
   * from here, which is what keeps a node from naming what a signature approves.
   */
  /**
   * Provider and rates for every line, from the coordinator's plan.
   *
   * One `POST /v1/batches` with no file: per model and pair of ceilings, the
   * line count and the summed units. The node answers which providers within
   * the ceilings take how many lines, never past a provider's on-chain capacity,
   * and a placed line signs its provider's ask. A line left over rests, with no
   * provider, at its ceilings; a side with no ceiling rests at the market rate,
   * read by one more plan that names none. A line with no ceiling at all cannot
   * rest, so a batch that leaves one over is refused before anything is signed.
   */
  private async plan(
    lines: Record<string, unknown>[],
    window: string,
    decimals: number,
  ): Promise<{ provider: number | undefined; rateIn: string; rateOut: string }[]> {
    interface Group {
      model: string;
      maxIn: bigint | null;
      maxOut: bigint | null;
      indexes: number[];
      unitsIn: number;
      unitsOut: number;
    }
    interface Share {
      provider: number;
      rateIn: bigint;
      rateOut: bigint;
      lines: bigint;
    }
    const groups = new Map<string, Group>();
    for (const [i, line] of lines.entries()) {
      const body = own(line, "body") as Record<string, unknown>;
      const model = String(own(body, "model"));
      const maxIn = parseCeiling(own(body, "max_rate_in"), `line ${i + 1}: max_rate_in`, decimals);
      const maxOut = parseCeiling(own(body, "max_rate_out"), `line ${i + 1}: max_rate_out`, decimals);
      const key = JSON.stringify([model, maxIn?.toString() ?? null, maxOut?.toString() ?? null]);
      const group = groups.get(key) ?? { model, maxIn, maxOut, indexes: [], unitsIn: 0, unitsOut: 0 };
      const unitsOut = own(body, "units_out");
      const declared = declareUnits(
        inputOf(body),
        unitsOut === undefined || unitsOut === null ? undefined : (unitsOut as number),
      );
      group.indexes.push(i);
      group.unitsIn += declared.unitsIn;
      group.unitsOut += declared.unitsOut;
      groups.set(key, group);
    }

    /** Per entry, the shares the node plans; `ceilings: false` asks for the market instead. */
    const allocations = async (
      entries: { group: Group; lines: number }[],
      ceilings = true,
    ): Promise<Share[][]> => {
      const request = {
        completion_window: window,
        models: await Promise.all(
          entries.map(async ({ group, lines: count }) => ({
            model_id: await this.client.modelIdFor(group.model),
            lines: count,
            units_in: group.unitsIn,
            units_out: group.unitsOut,
            ...(ceilings && group.maxIn !== null
              ? { max_rate_in: formatUsd(group.maxIn, decimals) }
              : {}),
            ...(ceilings && group.maxOut !== null
              ? { max_rate_out: formatUsd(group.maxOut, decimals) }
              : {}),
          })),
        ),
      };
      const response = await this.client.request("POST", "/v1/batches", {
        json: request,
        retry: false,
        allowStatuses: [402],
      });
      let body: unknown = {};
      try {
        body = await response.json();
      } catch {
        // An unreadable body carries no plan, and is refused below as one.
      }
      const plan =
        response.status === 402 && typeof body === "object" && body !== null
          ? own(body as Record<string, unknown>, "plan")
          : undefined;
      if (!Array.isArray(plan) || plan.length !== entries.length) {
        throw new VorqError(
          `POST /v1/batches answered ${response.status} to a plan without one plan entry per entry asked`,
          { type: "api_error", statusCode: response.status },
        );
      }
      return (plan as unknown[]).map((entry) => {
        const allocation =
          typeof entry === "object" && entry !== null
            ? own(entry as Record<string, unknown>, "allocation")
            : undefined;
        if (!Array.isArray(allocation)) {
          throw new VorqError("a plan entry carries no allocation list", {
            type: "api_error",
            statusCode: 402,
          });
        }
        return (allocation as unknown[]).map((share) => {
          const record = (typeof share === "object" && share !== null ? share : {}) as Record<
            string,
            unknown
          >;
          const pid = asBigInt(own(record, "provider_id"));
          const count = asBigInt(own(record, "lines"));
          const rateIn = own(record, "rate_in");
          const rateOut = own(record, "rate_out");
          if (pid === null || pid <= 0n || count === null || !isUsd(rateIn) || !isUsd(rateOut)) {
            throw new VorqError("a plan allocation names no provider, line count or ask", {
              type: "api_error",
              statusCode: 402,
            });
          }
          try {
            return {
              provider: Number(pid),
              rateIn: parseUsd(rateIn, decimals),
              rateOut: parseUsd(rateOut, decimals),
              lines: count,
            };
          } catch (error) {
            throw new VorqError(`a plan allocation is unreadable: ${(error as Error).message}`, {
              type: "api_error",
              statusCode: 402,
            });
          }
        });
      });
    };

    const all = [...groups.values()];
    const picks: { provider: number | undefined; rateIn: string; rateOut: string }[] = [];
    const left = new Map<Group, number[]>();
    const planned = await allocations(all.map((group) => ({ group, lines: group.indexes.length })));
    for (const [k, group] of all.entries()) {
      let placed = 0;
      for (const share of planned[k]!) {
        if (
          (group.maxIn !== null && share.rateIn > group.maxIn) ||
          (group.maxOut !== null && share.rateOut > group.maxOut)
        ) {
          throw new VorqError(
            `the node planned provider ${share.provider} at an ask above the ceilings the plan set`,
            { type: "api_error", statusCode: 402 },
          );
        }
        for (let n = 0n; n < share.lines && placed < group.indexes.length; n += 1n) {
          picks[group.indexes[placed]!] = {
            provider: share.provider,
            rateIn: formatUsd(share.rateIn, decimals),
            rateOut: formatUsd(share.rateOut, decimals),
          };
          placed += 1;
        }
      }
      if (placed < group.indexes.length) left.set(group, group.indexes.slice(placed));
    }

    const refuse = (group: Group): ValidationError =>
      new ValidationError(
        `the network can take ${group.indexes.length - left.get(group)!.length} of the ` +
          `${group.indexes.length} ${group.model} lines without both ceilings in the ${window} ` +
          "window right now, so nothing was signed. Split the file, try the other window, or " +
          "name max_rate_in and max_rate_out on the lines",
        { type: "invalid_request_error" },
      );

    // -- the lines that rest: at their ceilings, the market rate where there is none
    for (const group of left.keys()) {
      if (group.maxIn === null && group.maxOut === null) throw refuse(group);
    }
    const unnamed = [...left.keys()].filter((g) => g.maxIn === null || g.maxOut === null);
    const market = new Map<Group, Share>();
    if (unnamed.length > 0) {
      const asks = await allocations(
        unnamed.map((group) => ({ group, lines: left.get(group)!.length })),
        false,
      );
      for (const [k, group] of unnamed.entries()) {
        const first = asks[k]![0];
        if (first === undefined) throw refuse(group);
        market.set(group, first);
      }
    }
    for (const [group, indexes] of left) {
      const ask = market.get(group);
      const rest = {
        provider: undefined,
        rateIn: formatUsd(group.maxIn ?? ask!.rateIn, decimals),
        rateOut: formatUsd(group.maxOut ?? ask!.rateOut, decimals),
      };
      for (const i of indexes) picks[i] = rest;
    }
    return picks;
  }

  private async fees(
    line: SealedLine,
    ctx: ChainContext,
  ): Promise<{ gasFee: bigint; feeBps: bigint }> {
    const response = await this.client.request("POST", "/v1/jobs", {
      json: line.order,
      retry: false,
      allowStatuses: [402],
    });
    if (response.status !== 402) {
      // `.catch`, not `void`: nothing will read this body, and under undici an
      // unread one holds its connection until the socket is collected — but a
      // `cancel()` that rejects would become an unhandled rejection thrown out
      // of a process about to be told the real reason below.
      response.body?.cancel().catch(() => {});
      throw new VorqError(
        `POST /v1/jobs answered ${response.status} to a terms-only body; only a 402 ` +
          "quote is a valid answer to one, and a batch cannot price its lines without it",
        { type: "api_error", statusCode: response.status },
      );
    }
    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      // A gateway's HTML, an empty body: the refusal below reads no gas fee out
      // of `{}` and says exactly that.
    }
    // **Own properties only on the 402 body and on its quote block** (`own.ts`),
    // and this is the sharpest application of the rule in the package: both
    // values flow to `payLine`, where `amount = cap + cap*feeBps/10000 + gasFee`
    // is **the value every line in this batch puts a signature over**.
    //
    // Read bare, the refusal below is answered by the same prototype that
    // supplies the value, so it does not fire. Measured against a freshly built
    // `dist/` on the unguarded file: *refusal thrown: NONE; signed
    // authorization value: 1000000000000000000000000* — every line authorized
    // for a number no quote ever named.
    const quote =
      typeof body === "object" && body !== null
        ? own(body as Record<string, unknown>, "quote")
        : undefined;
    // A USD string on the wire; atomic here, because it is summed into the
    // value each line signs.
    const quoted =
      typeof quote === "object" && quote !== null
        ? own(quote as Record<string, unknown>, "gas_fee")
        : undefined;
    const fee = isUsd(quoted) ? parseUsdOrNull(quoted, ctx.decimals) : null;
    if (fee === null) {
      throw new VorqError(
        "the quote carries no gas_fee, so this batch cannot compute what each line's " +
          "payment has to cover",
        { type: "api_error", statusCode: 402 },
      );
    }
    const bps =
      typeof quote === "object" && quote !== null
        ? own(quote as Record<string, unknown>, "fee_bps")
        : undefined;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 1000) {
      throw new VorqError(
        "the quote carries no fee_bps, so this batch cannot compute what each line's " +
          "payment has to cover",
        { type: "api_error", statusCode: 402 },
      );
    }
    return { gasFee: fee, feeBps: BigInt(bps) };
  }

  /** Re-attach to a batch from a persisted id — no network call. */
  get(batchId: string): BatchHandle {
    return new BatchHandle(this.client, batchId);
  }

  /**
   * `GET /v1/batches` — this session's batches, newest first.
   *
   * **Cursor paging, not the offset paging `paging.ts` implements.** This route
   * asks its store for `limit + 1` and reports `has_more` rather than counting,
   * and it never goes through the coordinator's byte budget — so it carries
   * neither `x-vorq-page-truncated` nor `x-vorq-next-offset`, and the two-half
   * stop condition `pageAgain` exists for does not apply to it. Page by handing
   * `lastId` back as `after` while `hasMore` is true.
   *
   * One request, one page: nothing here walks. A listing of batches is a
   * caller's own loop, because a caller reading the newest ten does not want the
   * other forty thousand read on their behalf.
   */
  async list(query: { limit?: number; after?: string } = {}): Promise<BatchPage> {
    const body = await this.client.json<Record<string, unknown>>("GET", "/v1/batches", {
      params: { limit: query.limit, after: query.after },
    });
    // Own properties only on the listing body (`own.ts`). Nothing here decides
    // a signed term or a seal recipient, but a polluted `Object.prototype`
    // supplies rows and a cursor for a page that carried neither, so a caller
    // paging on `lastId` walks a listing the coordinator never served.
    const rows = own(body, "data");
    const firstId = own(body, "first_id");
    const lastId = own(body, "last_id");
    return {
      batches: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
      firstId: typeof firstId === "string" ? firstId : null,
      lastId: typeof lastId === "string" ? lastId : null,
      hasMore: own(body, "has_more") === true,
    };
  }
}

/** One page of `GET /v1/batches`. */
export interface BatchPage {
  batches: Record<string, unknown>[];
  firstId: string | null;
  lastId: string | null;
  /** Whether a further page exists. Cursor on `lastId`, not on an offset. */
  hasMore: boolean;
}

/**
 * A batch is terminal in **four** states.
 *
 * `JobHandle`'s own `TERMINAL` (`jobs.ts:70`) has three and no `expired`, which
 * is correct for a job — a job that nobody claimed ends `cancelled` with cause
 * `expired` — and wrong for a batch, whose window closing *is* a status. Reusing
 * that set would poll an expired batch until the caller's timeout, which from
 * outside looks exactly like a hung network.
 */
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "expired", "cancelled"]);

/** The statuses `POST /v1/batches/{id}/cancel` accepts (`routes/batches.ts:236`). */
const CANCELLABLE: ReadonlySet<string> = new Set(["validating", "in_progress", "cancelling"]);

export type BatchResult = TextResult | MediaResult | EmbeddingResult;

export interface BatchHandleOptions {
  /**
   * Seconds from a **monotonic** source, for the settle deadline only. See
   * `monotonicNow` in `clock.ts` for why this is not the wall clock.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A live batch: its status, its results, and its cancel. */
export class BatchHandle {
  readonly id: string;
  /**
   * Per-line content job ids in input order, set by `Batches.submit`. The
   * correlation key for every line until its sealed result is opened.
   */
  jobIds: string[] | null = null;
  outputFileId: string | null = null;
  errorFileId: string | null = null;
  requestCounts: Record<string, unknown> | null = null;

  private readonly client: BatchClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private completionWindow: string | null = null;

  constructor(
    client: BatchClient,
    idOrObject: string | Record<string, unknown>,
    options: BatchHandleOptions = {},
  ) {
    this.client = client;
    // Own properties only on the caller's options record (`own.ts`), and `??`
    // is not a substitute: it fires on `undefined`, and an inherited property
    // is not undefined. These two are the settle deadline's clock and its
    // pause.
    const stated = <K extends keyof BatchHandleOptions>(key: K): BatchHandleOptions[K] =>
      own(options as Record<string, unknown>, key) as BatchHandleOptions[K];
    this.now = stated("now") ?? monotonicNow;
    this.sleep = stated("sleep") ?? defaultSleep;
    if (typeof idOrObject === "string") {
      this.id = idOrObject;
    } else {
      // Own properties only again: this id is what **every** later poll,
      // cancel, status read and file read on this handle addresses, so a
      // prototype-supplied one points the whole handle at a batch nobody
      // created.
      this.id = String(own(idOrObject, "id") ?? "");
      this.apply(idOrObject);
    }
  }

  private apply(batch: Record<string, unknown>): void {
    // **Own properties only on the fetched batch** (`own.ts`). The two file ids
    // are the sharp ones: they name the files `readFile` reads, and each row of
    // those files names the bytes `fetchBlob` returns as a line's **result**.
    // Read bare, a polluted `Object.prototype.output_file_id` makes a batch that
    // named no output file deliver rows from a file the coordinator never
    // minted — and `decryptOutput` passes cleartext JSON through unchanged, so
    // those rows come back as this batch's answers.
    const outputFileId = own(batch, "output_file_id");
    const errorFileId = own(batch, "error_file_id");
    const counts = own(batch, "request_counts");
    const window = own(batch, "completion_window");
    this.outputFileId = typeof outputFileId === "string" ? outputFileId : null;
    this.errorFileId = typeof errorFileId === "string" ? errorFileId : null;
    this.requestCounts =
      typeof counts === "object" && counts !== null ? (counts as Record<string, unknown>) : null;
    this.completionWindow = typeof window === "string" ? window : null;
  }

  /**
   * The wire status of a fetched batch, own-properties only (`own.ts`).
   *
   * One reader for all three call sites — the terminal test, the `failed` test
   * and `status()` — because they decide, respectively, whether the wait loop
   * ends and the files are read, whether `BatchFailed` is thrown, and whether
   * `cancel()` refuses. A polluted `Object.prototype.status` of `"completed"`
   * ends the poll of a batch that is still validating.
   */
  private static statusOf(batch: Record<string, unknown>): string {
    const status = own(batch, "status");
    return status === undefined || status === null ? "" : String(status);
  }

  private async fetch(): Promise<Record<string, unknown>> {
    const batch = await this.client.json<Record<string, unknown>>(
      "GET",
      `/v1/batches/${encodeURIComponent(this.id)}`,
    );
    this.apply(batch);
    return batch;
  }

  /** One `GET /v1/batches/{id}`; returns the batch status string. */
  async status(): Promise<string> {
    return BatchHandle.statusOf(await this.fetch());
  }

  /**
   * Read one frozen file, whole.
   *
   * **No `?offset=` and no incremental drain.** The output file is built, frozen
   * and pinned once, at the end — content-addressed storage is immutable, so an
   * append would mint a different object under a different name, and a
   * partially-served file and its finished successor are two different files
   * rather than two views of one. A caller wanting progress before the end polls
   * `status()`; the file exists whole or not at all.
   */
  private async readFile(
    fileId: string,
    onResult: ((r: BatchResult) => unknown) | null,
    onError: ((e: JobError) => unknown) | null,
    pending: Promise<unknown>[],
  ): Promise<void> {
    const content = await this.client.fileContent(fileId);
    for (const raw of content.split("\n")) {
      if (raw.trim() === "") continue;
      const row = JSON.parse(raw) as Record<string, unknown>;
      // A row names its result and never carries it: the bytes are sealed to
      // this client's own key and fetched by the name the row gives. There is no
      // inline copy to fall back to, which is what stops sealed bodies being
      // swapped between lines.
      //
      // **Own properties only on the row and on its `vorq` block** (`own.ts`),
      // because this is the read that decides **what bytes come back as this
      // line's answer**. A polluted `Object.prototype.result_cid` is not a
      // display defect: `fetchBlob` reads the name it supplies, and
      // `decryptOutput` returns cleartext JSON unchanged when
      // `own(output, "enc")` is not `SEALED_RESULT_VERSION` — so a fabricated
      // body at an attacker-named CID is handed to the caller as the result of
      // a line that named none. Same class as `jobs.ts`'s `result_cid`.
      const vorqMember = own(row, "vorq");
      const vorq =
        typeof vorqMember === "object" && vorqMember !== null
          ? (vorqMember as Record<string, unknown>)
          : {};
      const namedCid = own(vorq, "result_cid");
      const resultCid = typeof namedCid === "string" ? namedCid : null;
      const body = resultCid === null ? null : await this.client.fetchBlob(resultCid);
      const parsed = resultFromBatchLine(row, await this.client.resultCipher(), body);
      // An error row with **no** `onError` falls through to `onResult`, and that
      // fallthrough is what lets a caller take one callback and see every line.
      //
      // **A deliberate divergence from the authority, and only for `consume`.**
      // Python's `_dispatch` returns early on a `None` callback
      // (`_batches.py:281-282`), so `consume(cb)` with no `on_error` **silently
      // drops** every failed line. Handing a caller's failed lines to the one
      // callback they gave is better than dropping them on the floor, so this
      // SDK routes them instead. `results()` is *not* a divergence: both SDKs
      // pass a collector as both callbacks, so both return one merged list
      // (`_batches.py:418`) — and because it always supplies an `onError`, it
      // never takes this branch at all.
      const outcome =
        parsed instanceof JobError
          ? onError !== null
            ? onError(parsed)
            : onResult?.(parsed as unknown as BatchResult)
          : onResult?.(parsed);
      // A promise-returning callback is collected rather than awaited inline, so
      // callbacks run concurrently with the rest of the file being read — and
      // every one of them is awaited before `run` returns.
      if (outcome instanceof Promise) {
        pending.push(outcome);
        // **The handler is attached now, not at the `await` below.** A rejection
        // that lands while a macrotask still stands between this push and
        // `Promise.all` — and the second file's `fileContent` read is exactly
        // that gap — is an unhandled rejection, which under Node's default
        // `--unhandled-rejections=throw` **terminates the process** before
        // `consume` ever gets to reject with the callback's own error. Python
        // has no such edge: `asyncio.ensure_future` parks the exception on the
        // task. This costs nothing — the real rejection still surfaces from the
        // `Promise.all` below, which is a second handler on the same promise.
        void outcome.catch(() => {});
      }
    }
  }

  private async run(
    onResult: ((r: BatchResult) => unknown) | null,
    onError: ((e: JobError) => unknown) | null,
    timeoutSeconds?: number,
  ): Promise<void> {
    let batch = await this.fetch();
    const window = this.completionWindow ?? "24h";
    const timeout = timeoutSeconds ?? slaSeconds(window);
    const interval = pollInterval(window);
    const deadline = this.now() + timeout;
    const pending: Promise<unknown>[] = [];

    while (!TERMINAL.has(BatchHandle.statusOf(batch))) {
      // Before the sleep, not after it: a sleep taken past the deadline is a
      // read the window paid for and never got.
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new WaitTimeout(
          `Batch ${this.id} did not settle within ${timeout}s. Nothing was cancelled: ` +
            `the lines keep running and ${this.id} can be re-attached with ` +
            "client.batches.get(...).",
          { jobId: this.id },
        );
      }
      // Clamped to what is left, for the reason `JobHandle.result` clamps: an
      // interval longer than the remaining budget would sleep past the deadline
      // this loop is about to report.
      await this.sleep(Math.min(interval, remaining) * 1000);
      batch = await this.fetch();
    }

    if (BatchHandle.statusOf(batch) === "failed") {
      // The **input file** was refused, so there are no lines and no files to
      // read. A line that failed is a row in the error file and never this.
      throw new BatchFailed(`Batch ${this.id} failed.`, { batchId: this.id });
    }

    // Terminal: both files are frozen, so this is one read each and never a loop.
    if (this.outputFileId !== null) {
      await this.readFile(this.outputFileId, onResult, onError, pending);
    }
    if (this.errorFileId !== null) {
      await this.readFile(this.errorFileId, onResult, onError, pending);
    }
    if (pending.length > 0) await Promise.all(pending);
  }

  /**
   * Suspend until terminal, then fire a callback per line.
   *
   * Delivery is in **file order** — every settled line, then every failed one —
   * not input order. Correlate on `.customId` once a result is opened, or on
   * `.jobId` (listed in input order on `jobIds`) before that and for every error
   * row, which has no sealed result to read a label out of.
   *
   * Callbacks may be plain or promise-returning; a promise-returning one is
   * dispatched concurrently and awaited before this resolves.
   */
  async consume(
    onResult: (r: BatchResult) => unknown,
    onError?: (e: JobError) => unknown,
    timeoutSeconds?: number,
  ): Promise<void> {
    await this.run(onResult, onError ?? null, timeoutSeconds);
  }

  /** Suspend until terminal, then return the full merged result list. */
  async results(timeoutSeconds?: number): Promise<(BatchResult | JobError)[]> {
    const collected: (BatchResult | JobError)[] = [];
    await this.run(
      (r) => {
        collected.push(r);
      },
      (e) => {
        collected.push(e);
      },
      timeoutSeconds,
    );
    return collected;
  }

  /**
   * Cancel the batch.
   *
   * Lines still open are cancelled; a line a provider has already **claimed**
   * runs to its own end, exactly as a standalone job does — nobody can take work
   * back out of a provider's hands mid-flight.
   *
   * The local status check is a **courtesy, not the gate**: it saves a round trip
   * and gives a better message, and the coordinator's own identical check
   * (`routes/batches.ts:236`) is what actually decides. Python does not read
   * first; this SDK does, because spec `06` asks for it.
   */
  async cancel(): Promise<void> {
    const status = await this.status();
    if (!CANCELLABLE.has(status)) {
      // `ValidationError`, because that is what this same refusal maps to when
      // the coordinator is the one making it: `batch_not_cancellable` is a `400`
      // and `errorFromWire` maps `400` to `ValidationError`. One condition must
      // not yield two classes depending on which side noticed it first, or a
      // caller's `catch` works only sometimes.
      throw new ValidationError(`Cannot cancel a batch with status ${status}`, {
        type: "invalid_request_error",
      });
    }
    const response = await this.client.request(
      "POST",
      `/v1/batches/${encodeURIComponent(this.id)}/cancel`,
      { retry: false },
    );
    // `.catch`, not `void`: nothing will read this body, and under undici an
    // unread one holds its connection until the socket is collected — but a
    // `cancel()` that rejects (an already-locked body) would become an unhandled
    // rejection, which is the same hazard `readFile` guards one function away
    // and the same one `gasFee` guards above.
    response.body?.cancel().catch(() => {});
  }
}

/** A USD string at `decimals`, or `null` when it carries more fraction than the token does. */
function parseUsdOrNull(text: string, decimals: number): bigint | null {
  try {
    return parseUsd(text, decimals);
  } catch {
    return null;
  }
}
