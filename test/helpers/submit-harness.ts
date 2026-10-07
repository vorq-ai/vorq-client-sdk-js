/**
 * The scripted-node harness the submission suites share.
 *
 * Every fixture here is on the signing path — the key the orders are signed
 * with, the chain context they are signed against, the recipient whose secret
 * opens the containers — so there is exactly one copy of each. A second copy
 * drifts, and a drifted signing-path fixture proves nothing.
 */
import { vi } from "vitest";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { Client } from "../../src/client.js";
import {
  RECEIVE_AUTHORIZATION_TYPES,
  paymentDomain,
  type ChainContext,
} from "../../src/terms.js";
import { PrivateKeySigner } from "../../src/signer/private-key.js";
import { SealedBoxCipher } from "../../src/crypto/cipher.js";
import { curvePublicKey, seal, sealOpen } from "../../src/crypto/sealed-box.js";
import { SEALED_RESULT_VERSION } from "../../src/crypto/domains.js";
import { BatchHandle } from "../../src/batches.js";
import { toHex } from "../../src/crypto/bytes.js";
import { deriveDek, openDek, splitContainer } from "../../src/crypto/container.js";
import { formatUsd, parseUsd } from "../../src/money.js";

/** Atomic units at the harness chain's 6 decimals, as the USD string the wire carries. */
export const usd = (atomic: bigint | number): string => formatUsd(BigInt(atomic), 6);

export const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** A recipient whose secret key the test holds, so a container can be opened. */
export const RECIPIENT_SECRET = new Uint8Array(32).fill(0x11);
export const RECIPIENT_PUBLIC = toHex(curvePublicKey(RECIPIENT_SECRET));

export const CHAIN = {
  chain_id: 84532,
  contracts: {
    job_registry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    provider_registry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    ask_registry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  decimals: 6,
  token_domain: { name: "USDC", version: "2" },
  fee_bps: 100,
};

export const MODELS = { data: [{ id: "m", object: "model", vorq: { model_id: 7 } }] };

/**
 * The `402` an honest node answers: the amount, and the authorization block the
 * client cross-checks member for member against the one it derives itself.
 * `amount` is atomic here; the quote states it as USD and the block's `value`
 * as the atomic integer it signs.
 *
 * `expiresAt` is the order's own, because `valid_before` is `expiresAt + 1` —
 * a caller that passed anything else is quoting another order's window.
 */
export const QUOTE = (jobId: string, expiresAt: bigint, amount = 210) => ({
  quote: {
    amount: usd(amount),
    authorization: {
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: CHAIN.contracts.usdc,
      },
      to: CHAIN.contracts.job_registry,
      value: amount,
      valid_after: 0,
      valid_before: Number(expiresAt + 1n),
      nonce: jobId,
    },
  },
  accepts: [{ scheme: "eip3009", network: "eip155:84532" }],
});

/**
 * `n` is how many times this route has been hit, `body` the parsed request
 * body, `url` the full href.
 *
 * **`url` is there so a paged route can answer by `offset` rather than by hit
 * count**, and the difference is not cosmetic: a route scripted by hit count
 * hands page two to the *second read*, whoever makes it, so two independent
 * single-page reads look exactly like one walk of two pages. A test written
 * that way passes with the paging removed.
 */
export type Answer = (
  n: number,
  body: unknown,
  url: string,
  init: RequestInit,
) => Response | null | Promise<Response | null>;
export type Route = [RegExp, Answer];
/**
 * `body` is the JSON a call carried, parsed; a `FormData`, read back as the
 * flat record the door reads (string fields, the file part as its bytes); or
 * `undefined` for anything else. `init` is what actually went to `fetch` — the
 * headers and the unparsed body — which is the only place a test can see what
 * the SDK set and what it left for `fetch` to derive.
 */
export type Call = { url: string; method: string; body: unknown; init: RequestInit };

async function formRecord(form: FormData): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const [name, value] of form.entries()) {
    record[name] = typeof value === "string" ? value : new Uint8Array(await value.arrayBuffer());
  }
  return record;
}

/**
 * A `fetch` that answers from a routing table and records every call. Routes
 * are matched in order; a route may be a function returning a Response, so a
 * test can vary the answer per attempt. A route answering `null` passes the
 * call on to the next matching route, and that call does not count as a hit.
 */
export function scriptedFetch(routes: Route[]) {
  const calls: Call[] = [];
  const counts = new Map<RegExp, number>();
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url);
    const body =
      typeof init.body === "string"
        ? JSON.parse(init.body)
        : init.body instanceof FormData
          ? await formRecord(init.body)
          : undefined;
    calls.push({ url: href, method: init.method ?? "GET", body, init });
    for (const [pattern, answer] of routes) {
      if (!pattern.test(href)) continue;
      const n = (counts.get(pattern) ?? 0) + 1;
      const response = await answer(n, body, href, init);
      if (response === null) continue;
      counts.set(pattern, n);
      return response;
    }
    throw new Error(`no route for ${init.method ?? "GET"} ${href}`);
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

/**
 * `headers` is here for the paging suite: the coordinator's paging signals
 * travel as `x-vorq-*` headers rather than in the frozen body shapes, so a test
 * that cannot set them cannot script a truncated page at all.
 */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The candidate a market probe names: provider N at atomic rates 1000·N / 2000·N, as USD. */
export const marketCandidate = (providerId: number, boxKey: string = RECIPIENT_PUBLIC) => ({
  provider_id: providerId,
  box_key: boxKey,
  rate_in: usd(1000 * providerId),
  rate_out: usd(2000 * providerId),
});

/** A market probe: a `POST /v1/jobs` body that names no rates. */
export const isMarketProbe = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  !("rate_in" in body) &&
  !("rate_out" in body);

/** Whether a candidate's ask is at or under the ceilings a probe names. */
export const withinCeilings = (candidate: unknown, probe: unknown): boolean =>
  (["rate_in", "rate_out"] as const).every((side) => {
    const ceiling = (probe as Record<string, unknown>)[`max_${side}`];
    const ask = (candidate as Record<string, unknown>)[side];
    return typeof ceiling !== "string" || typeof ask !== "string" || parseUsd(ask, 6) <= parseUsd(ceiling, 6);
  });

/**
 * The node's answer to a market probe: the pinned provider, or provider 1,
 * less any whose ask is above a ceiling the probe names. Any other
 * `POST /v1/jobs` passes on to the test's own route.
 */
export const marketRoute = (candidates?: unknown[]): Route => [
  /\/v1\/jobs$/,
  (_n, body) => {
    if (!isMarketProbe(body)) return null;
    const pinned = Number((body as { designated?: unknown }).designated ?? 0);
    const named = candidates ?? [marketCandidate(pinned || 1)];
    return json({ candidates: named.filter((c) => withinCeilings(c, body)) }, 402);
  },
];

/** The routes every submit needs before it reaches POST /v1/jobs. */
export const baseRoutes = (providerBoxKey: string | null = RECIPIENT_PUBLIC): Route[] => [
  [/\/auth\/nonce/, () => json({ nonce: "n", chain_id: 84532 })],
  [/\/auth\/session/, () => json({ token: "t", expires_at: 4102444800 })],
  [/\/evm\/chain/, () => json(CHAIN)],
  [/\/v1\/models/, () => json(MODELS)],
  [/\/evm\/providers\/\d+/, () => json({ id: 1, box_key: providerBoxKey })],
  marketRoute(),
];

/**
 * The scalar the harness client's result cipher is built on. Exported because a
 * fixture that seals a *result* has to seal it to this exact key: a body sealed
 * to any other one opens for nobody, and a body left in the clear opens for
 * everybody — including a `BatchHandle` that forgot to pass its client's cipher
 * along, which is the break the sealing exists to catch.
 */
export const RESULT_KEY = new Uint8Array(32).fill(0x22);

/**
 * The harness client. `options` is every `ClientOptions` member except the four
 * this function owns — the base URL, the signer, the cipher and the `fetch` —
 * spelled the way `clientWithFetch` below already spells it, so a suite needing
 * `verifier` or `clock` passes one rather than restating the signing-path
 * fixtures to build a second client by hand.
 */
export function client(
  routes: Route[],
  options: Partial<ConstructorParameters<typeof Client>[0]> = {},
) {
  const { impl, calls } = scriptedFetch(routes);
  return {
    calls,
    fetchImpl: impl,
    client: new Client({
      baseUrl: "http://node",
      signer: new PrivateKeySigner(KEY),
      cipher: new SealedBoxCipher(RESULT_KEY),
      fetch: impl,
      ...options,
    }),
  };
}

/**
 * A client over one hand-written `fetch`, with a pre-minted session token so no
 * handshake stands between the test and the call under it.
 *
 * The routing table above is what a submission needs — five routes before it
 * reaches `POST /v1/jobs`. A single-door test wants the opposite: every request
 * the SDK makes, in the order it made it, with the raw `RequestInit` in hand.
 */
export function clientWithFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof Client>[0]> = {},
): Client {
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) =>
    handler(String(url), init),
  );
  return Client.fromSessionToken("vorq_sess_test", {
    baseUrl: "http://node",
    fetch: impl as unknown as typeof globalThis.fetch,
    ...options,
  });
}

/** Every order POST to /v1/jobs in a call log — challenges and complete submissions alike. */
export const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/jobs") && !isMarketProbe(c.body));

/** Every market probe in a call log: the unsigned, rate-less POST /v1/jobs. */
export const probes = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/jobs") && isMarketProbe(c.body));

/**
 * The funded submissions only: the ones carrying a signed payment authorization.
 *
 * A refusal that happens after the terms-only challenge has already gone out is
 * still a refusal that signed nothing, and this is what says so.
 */
export const funded = (calls: Call[]) =>
  posts(calls).filter((c) => (c.body as { auth_sig?: unknown } | undefined)?.auth_sig !== undefined);

/**
 * Submit through both phases and hand back the container the client uploaded,
 * plus the order it signed. Shared by every describe below — several need the
 * sealed bytes, and re-deriving them per block would let two copies of this
 * drift.
 *
 * Both are read off JSON bodies now: the challenge keeps the order's own
 * types, and the paid submission's `container` is base64, decoded back to
 * bytes here so every caller of this helper keeps working with raw ones.
 */
export async function sealedByASubmit(input: string | Record<string, unknown>, over: Record<string, unknown> = {}) {
  const captured: { container?: Uint8Array; order?: Record<string, unknown> } = {};
  const { client: c, calls } = client([
    ...baseRoutes(),
    [
      /\/v1\/jobs$/,
      (n, body) => {
        if (n === 1) captured.order = body as Record<string, unknown>;
        else captured.container = Buffer.from((body as { container: string }).container, "base64");
        const wire = body as never as { job_id: string; expires_at: number };
        return n === 1
          ? json(QUOTE(wire.job_id, BigInt(wire.expires_at)), 402)
          : json({
              job_id: (body as never as { job_id: string }).job_id,
              task_cid: "bafy",
              tx_hash: "0x1",
            });
      },
    ],
  ]);
  await c.submit({ model: "m", input, provider: 1, ...over });
  return { container: captured.container!, order: captured.order!, calls };
}

/**
 * The scripted node a batch submit talks to: the five base routes, the
 * terms-only `POST /v1/jobs` that prices the file, `POST /v1/files`, and
 * `POST /v1/batches`.
 *
 * The uploaded manifest is read back out of the `FormData` rather than
 * reconstructed, because the multipart body is the only place a test can see
 * the bytes the SDK actually put on the wire.
 */
export interface BatchHarnessOptions {
  /**
   * The `gas_fee` the 402 quote carries, in atomic units; the wire states it as
   * USD. `null` omits the key entirely.
   */
  gasFee?: bigint | number | null;
  /**
   * The `gas_fee` the quote carries **verbatim**, whatever JSON type it is —
   * a string, a fraction, an integer past `MAX_SAFE_INTEGER`. Takes precedence
   * over `gasFee`.
   */
  gasFeeRaw?: unknown;
  /**
   * The `fee_bps` the 402 quote carries, as the JSON number it is on the wire.
   * Default `0`; `null` omits the key entirely.
   */
  feeBps?: number | null;
  /** What the terms-only `POST /v1/jobs` answers. Default `402`. */
  gasStatus?: number;
  /** A payee the node names in its quote. The signed authorization must not carry it. */
  quoteTo?: string;
  fileId?: string;
  /** The batch object `POST /v1/batches` answers with. */
  batch?: Record<string, unknown>;
  /**
   * What a plan (`POST /v1/batches` with no file) allots per entry: a list, or
   * a function of the entry. Unset: provider 1 takes every line of an entry
   * that names no ceiling at "0.001"/"0.002", and nobody is within an entry
   * that names one, so those lines rest at their own terms.
   */
  allocation?: unknown[] | ((entry: Record<string, unknown>) => unknown[]);
  /**
   * The status `POST /v1/batches` answers. Default `200`.
   *
   * Anything else answers an error envelope carrying **`x-vorq-retryable:
   * true`** — the header the transport's retry policy actually reads. That is
   * the only way to tell a create sent with `retry: false` from one sent with
   * `retry: true`: both send a first request, and only the flag decides whether
   * there is a second.
   */
  createStatus?: number;
  /**
   * The catalog `GET /v1/models` answers with, replacing `MODELS`.
   *
   * The only way to give a model a real `vorq.params_schema`, which is what
   * makes `checkInput` reachable — and `checkInput` *throws*, so this is what
   * lets `validateParams` be pinned as the refusal switch it is rather than as
   * a warning switch.
   */
  models?: unknown;
  /**
   * What `GET /key` answers. Absent leaves the route unrouted, so an open batch
   * on a client with a verifier fails loudly ("no route for GET …") rather than
   * quietly reading somebody else's fixture.
   */
  escrowAnnouncement?: () => unknown;
  /**
   * Passed to the `Client` constructor — `verifier` and `clock`, for the open
   * batch path. The harness still owns the base URL, signer, cipher and fetch.
   */
  clientOptions?: Partial<ConstructorParameters<typeof Client>[0]>;
}

export function batchHarness(options: BatchHarnessOptions = {}) {
  const gasStatus = options.gasStatus ?? 402;
  const fileId = options.fileId ?? "file_test";
  /** Every terms-only `POST /v1/jobs` body, parsed. */
  const termsOnlyPosts: Record<string, string>[] = [];
  /** Every manifest handed to `POST /v1/files`, as text. */
  const uploads: string[] = [];
  /** Every `POST /v1/batches` body. */
  const creates: Record<string, unknown>[] = [];
  /** Every plan asked for: a `POST /v1/batches` body with no file. */
  const plans: Record<string, unknown>[] = [];

  const quote: Record<string, unknown> = {
    authorization: {
      // Deliberately hostile when the test names it: a node that gets to choose
      // the payee a signature authorizes is the finding this batch path exists
      // as the reference fix for.
      to: options.quoteTo ?? CHAIN.contracts.job_registry,
    },
  };
  if (options.gasFeeRaw !== undefined) {
    quote.gas_fee = options.gasFeeRaw;
  } else if (options.gasFee !== null && options.gasFee !== undefined) {
    quote.gas_fee = usd(options.gasFee);
  }
  if (options.feeBps !== null) {
    quote.fee_bps = options.feeBps ?? 100;
  }

  const built = client([
    // Ahead of `baseRoutes`, because routes match in order and `baseRoutes`
    // serves the stock catalog on the same pattern.
    ...(options.models === undefined
      ? []
      : ([[/\/v1\/models/, () => json(options.models)]] as Route[])),
    ...(options.escrowAnnouncement === undefined
      ? []
      : ([[/\/key$/, () => json(options.escrowAnnouncement!())]] as Route[])),
    ...baseRoutes(),
    [
      /\/v1\/jobs$/,
      (_n, body) => {
        termsOnlyPosts.push(body as Record<string, string>);
        return json({ quote }, gasStatus);
      },
    ],
    [
      /\/v1\/files$/,
      async (_n, _body, _url, init) => {
        const form = init.body as FormData;
        uploads.push(await (form.get("file") as File).text());
        return json({ id: fileId, object: "file", purpose: "batch", bytes: 1 });
      },
    ],
    [
      /\/v1\/batches$/,
      (_n, body) => {
        const ask = body as Record<string, unknown>;
        if (!("input_file_id" in ask)) {
          plans.push(ask);
          const models = ask.models as (Record<string, unknown> & { model_id: number; lines: number })[];
          return json(
            {
              plan: models.map((m) => ({
                model_id: m.model_id,
                lines: m.lines,
                allocation:
                  typeof options.allocation === "function"
                    ? options.allocation(m)
                    : (options.allocation ??
                      (Object.hasOwn(m, "max_rate_in") || Object.hasOwn(m, "max_rate_out")
                        ? []
                        : [{ ...marketCandidate(1), lines: m.lines }])),
              })),
            },
            402,
          );
        }
        creates.push(body as Record<string, unknown>);
        const status = options.createStatus ?? 200;
        if (status !== 200) {
          return json(
            { error: { message: "later", type: "api_error" } },
            status,
            { "x-vorq-retryable": "true" },
          );
        }
        return json(options.batch ?? { id: "batch_test", object: "batch", status: "validating" });
      },
    ],
  ], options.clientOptions ?? {});

  return { ...built, termsOnlyPosts, uploads, creates, plans };
}

/** The non-blank rows of one uploaded manifest, parsed. */
export const manifestRows = (content: string): Record<string, unknown>[] =>
  content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/**
 * Who signed one manifest row's payment, **recovered against a payee the caller
 * names**.
 *
 * The only assertion that can tell an authorization made out to `ctx.jobRegistry`
 * from one made out to whatever a node put in its quote: `ecrecover` never
 * fails, it returns a different address, so a signature over the wrong payee is
 * valid and belongs to a stranger nobody funded. Reading the payee back off the
 * row would prove nothing — the row does not carry one.
 */
export function paymentSignerOf(
  row: Record<string, unknown>,
  ctx: ChainContext,
  to: Address,
): Promise<Address> {
  const wire = row as {
    owner: Address;
    job_id: Hex;
    expires_at: number;
    auth_sig: Hex;
    amount: string;
  };
  return recoverTypedDataAddress({
    domain: paymentDomain(ctx),
    types: RECEIVE_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: wire.owner,
      to,
      value: parseUsd(wire.amount, 6),
      validAfter: 0n,
      validBefore: BigInt(wire.expires_at) + 1n,
      nonce: wire.job_id,
    },
    signature: wire.auth_sig,
  });
}

/** Open a submitted container as the recipient and read the sealed envelope. */
export function openEnvelope(container: Uint8Array, owner: string): Record<string, unknown> {
  const { seedWrap, ciphertext } = splitContainer(container);
  const seed = sealOpen(RECIPIENT_SECRET, seedWrap);
  const plaintext = openDek(ciphertext, deriveDek(seed, owner));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BatchHandle
// ---------------------------------------------------------------------------

/**
 * One row of a finished batch's output or error file, with the bytes its
 * `result_cid` names.
 *
 * The row and the bytes are minted together because that is how they exist on
 * the network: the row is a manifest entry naming content-addressed bytes, and a
 * fixture that produced one without the other could not exercise the fetch the
 * handle makes between reading a row and building its result.
 */
export interface BatchLineFixture {
  row: Record<string, unknown>;
  /** The CID the row names, or `null` for an error row, which names none. */
  cid: string | null;
  bytes: Uint8Array | null;
}

/**
 * A settled output row, its result **sealed to the harness client's own key**.
 *
 * Sealed rather than cleartext deliberately. A cleartext body opens with any
 * cipher and with none, so a handle that passed `null` where its client's cipher
 * belongs would hand back a perfectly good result and no assertion downstream
 * could tell. Sealed, that break becomes a `ResultIntegrityError`.
 */
export function okRow(
  jobId: string,
  cid: string,
  text: string,
  over: { customId?: string } = {},
): BatchLineFixture {
  const body: Record<string, unknown> = {
    object: "response",
    output: [{ content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1000, output_tokens: 1000 },
    // The provider's correlation stamp, which is where a caller's own label
    // comes back from: `custom_id` travels sealed and is never on the wire.
    vorq: { job_id: jobId, custom_id: over.customId ?? null },
  };
  const sealed = seal(curvePublicKey(RESULT_KEY), new TextEncoder().encode(JSON.stringify(body)));
  return {
    row: {
      id: `batch_req_${jobId}`,
      custom_id: null,
      response: { status_code: 200, request_id: jobId, body: null },
      error: null,
      vorq: {
        job_id: jobId,
        result_cid: cid,
        provider: 7,
        rate_in: "5",
        rate_out: "5",
        completion_tok: 1000,
        gas_fee: "0.03", fee: "0",
      },
    },
    cid,
    bytes: new TextEncoder().encode(
      JSON.stringify({
        enc: SEALED_RESULT_VERSION,
        ciphertext: Buffer.from(sealed).toString("base64"),
      }),
    ),
  };
}

/** A line that never delivered — an error-file row, which names no result. */
export function errRow(jobId: string, message: string, code = "provider_fail"): BatchLineFixture {
  return {
    row: {
      id: `batch_req_${jobId}`,
      custom_id: null,
      response: null,
      error: { code, message },
      vorq: { job_id: jobId, line: 1 },
    },
    cid: null,
    bytes: null,
  };
}

export interface HandleHarnessOptions {
  /**
   * The status each successive `GET /v1/batches/{id}` answers, in order.
   *
   * **The script is finite and running past its end throws.** A fixture that
   * answered the same status forever would turn a broken terminal set or a
   * missing deadline check into a hung run, and a hang reads as tooling trouble
   * rather than as evidence.
   */
  statuses?: string[];
  output?: BatchLineFixture[];
  errors?: BatchLineFixture[];
  /** The batch row's `completion_window`; `null` omits the key entirely. */
  completionWindow?: string | null;
  /** A status the batch read answers with instead of a row, e.g. `404`. */
  statusCode?: number;
  /** The status `POST /v1/batches/{id}/cancel` answers. Default `200`. */
  cancelStatus?: number;
}

const BATCH_ID = "batch_1";
const OUTPUT_FILE_ID = "file_out";
const ERROR_FILE_ID = "file_err";

/**
 * A `BatchHandle` over a scripted node: the batch reads, the two frozen files,
 * the gateway the rows' CIDs are fetched from, and the cancel door.
 *
 * The handle runs on a **stopped clock** that only `sleep` advances, so every
 * deadline in the suite is decided by the code under test rather than by how
 * long a test happened to take.
 */
export function handleHarness(options: HandleHarnessOptions = {}) {
  const statuses = options.statuses ?? ["completed"];
  const output = options.output ?? [];
  const errors = options.errors ?? [];
  const blobs = new Map<string, Uint8Array>();
  for (const line of [...output, ...errors]) {
    if (line.cid !== null && line.bytes !== null) blobs.set(line.cid, line.bytes);
  }

  /** Every file id whose content was read, in order. */
  const contentReads: string[] = [];
  /** Every batch id a cancel was POSTed for. */
  const cancels: string[] = [];
  /** Every CID fetched from the gateway, in order. */
  const blobReads: string[] = [];
  /** Every sleep the poll loop took, in seconds. */
  const sleeps: number[] = [];
  let reads = 0;
  let clock = 0;

  const jsonl = (lines: BatchLineFixture[]): string =>
    lines.length === 0 ? "" : `${lines.map((line) => JSON.stringify(line.row)).join("\n")}\n`;

  const built = client(
    [
      ...baseRoutes(),
      [
        /\/v1\/batches\/[^/]+\/cancel$/,
        (_n, _body, url) => {
          cancels.push(url.split("/").slice(-2)[0] as string);
          const status = options.cancelStatus ?? 200;
          return json(
            status === 200
              ? { id: BATCH_ID, object: "batch", status: "cancelling" }
              : {
                  error: {
                    message: "Cannot cancel a batch with status completed",
                    type: "invalid_request",
                    code: "batch_not_cancellable",
                  },
                },
            status,
          );
        },
      ],
      [
        /\/v1\/batches\/[^/?]+$/,
        () => {
          if (options.statusCode !== undefined) {
            return json(
              { error: { message: `No such batch: ${BATCH_ID}`, type: "not_found" } },
              options.statusCode,
            );
          }
          const status = statuses[reads];
          if (status === undefined) {
            // Bounded on purpose — see `statuses`.
            throw new Error(
              `the batch was read ${reads + 1} times and the script holds ` +
                `${statuses.length}: the poll ran past its fixture`,
            );
          }
          reads += 1;
          const row: Record<string, unknown> = {
            id: BATCH_ID,
            object: "batch",
            status,
            output_file_id: output.length > 0 ? OUTPUT_FILE_ID : null,
            error_file_id: errors.length > 0 ? ERROR_FILE_ID : null,
            request_counts: { total: output.length + errors.length },
          };
          if (options.completionWindow !== null) {
            row.completion_window = options.completionWindow ?? "24h";
          }
          return json(row);
        },
      ],
      [
        /\/v1\/files\/[^/]+\/content$/,
        async (_n, _body, url) => {
          // **A real tick boundary, because a file read is one.** Everything
          // else this harness serves comes out of memory and settles inside a
          // single microtask drain — and Node only reports an unhandled
          // rejection *after* that drain, so a run that never crosses a tick
          // cannot produce one at all. The window between a rejecting callback
          // being collected and `Promise.all` awaiting it is exactly the gap the
          // second file's read stands in; without this, a fixture asserting on
          // that window is asserting on something it made unreachable.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const fileId = url.split("/").slice(-2)[0] as string;
          contentReads.push(fileId);
          return new Response(jsonl(fileId === OUTPUT_FILE_ID ? output : errors), {
            status: 200,
            headers: { "content-type": "application/jsonl" },
          });
        },
      ],
      [
        /\/ipfs\//,
        (_n, _body, url) => {
          const cid = decodeURIComponent(url.split("/ipfs/")[1] as string);
          blobReads.push(cid);
          const bytes = blobs.get(cid);
          if (bytes === undefined) return new Response("not found", { status: 404 });
          // The one `SharedArrayBuffer` gap in the DOM types, the same one
          // `files.ts` casts past: `BodyInit` takes an
          // `ArrayBufferView<ArrayBuffer>` and a plain `Uint8Array` is typed
          // over `ArrayBufferLike`.
          return new Response(bytes as BodyInit, { status: 200 });
        },
      ],
    ],
    { gateway: "http://gw" },
  );

  const handle = new BatchHandle(built.client, BATCH_ID, {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms / 1000);
      clock += ms / 1000;
    },
  });

  return {
    ...built,
    handle,
    contentReads,
    cancels,
    blobReads,
    sleeps,
    outputFileId: OUTPUT_FILE_ID,
    errorFileId: ERROR_FILE_ID,
    batchReads: () => reads,
  };
}

/**
 * A client whose `GET /v1/batches` answers a scripted sequence of pages, and
 * which records the query string of every one of those reads.
 *
 * Answers **by hit count on purpose** here, and the query strings are what the
 * suite asserts on: what a cursor pager has to prove is that it sent the cursor
 * it was handed, which a body alone cannot show.
 */
export function listHarness(options: { pages: Record<string, unknown>[] }) {
  const queries: string[] = [];
  const built = client([
    ...baseRoutes(),
    [
      /\/v1\/batches(\?|$)/,
      (n, _body, url) => {
        queries.push(url);
        const page = options.pages[n - 1];
        if (page === undefined) {
          throw new Error(`GET /v1/batches was read ${n} times and the script holds ${options.pages.length}`);
        }
        return json({ object: "list", ...page });
      },
    ],
  ]);
  return { ...built, queries };
}
