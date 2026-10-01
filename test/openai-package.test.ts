/**
 * The stock `openai` npm package, driven through `sealingFetch`.
 *
 * `openai-compat.test.ts` calls the transport by hand — `fetch(url, init)` with
 * a body this file wrote. That proves the module's own behaviour and not the
 * thing it exists for. The contract is with the package: **its** URL building
 * decides which paths reach the dispatch, **its** headers are what a route sees,
 * and **its** response models decide whether a synthesized body parses at all.
 * So this file states nothing about the wire itself and everything about the
 * package's view of it.
 *
 * The two base URLs are different and that is the point: `new OpenAI({baseURL})`
 * carries the `/v1` the package builds its paths from, while the `Client` inside
 * `sealingFetch` talks to the harness's own origin. Nothing here scripts a
 * second node — the signing-path fixtures live in `submit-harness.ts` and a
 * drifted copy of one proves nothing.
 */
import { describe, expect, it } from "vitest";
import OpenAI, { type APIError, type ClientOptions as OpenAIOptions } from "openai";

import type { ClientOptions } from "../src/client.js";
import { sealingFetch } from "../src/openai-compat.js";
import { SEALED_RESULT_VERSION } from "../src/crypto/domains.js";
import { curvePublicKey, seal } from "../src/crypto/sealed-box.js";
import {
  QUOTE,
  RESULT_KEY,
  baseRoutes,
  client,
  json,
  posts,
  type Call,
  type Route,
} from "./helpers/submit-harness.js";

/** A valid `bytes32`: a cancel signs `Cancel(jobId, issuedAt)` over it. */
const JOB = `0x${"ab".repeat(32)}`;
/** A settled job's CID, and the only name the gateway route answers to. */
const CID = "bafyresult";

/** Result bytes sealed to the harness client's own result key. */
const sealedBlob = (body: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      enc: SEALED_RESULT_VERSION,
      ciphertext: Buffer.from(
        seal(curvePublicKey(RESULT_KEY), new TextEncoder().encode(JSON.stringify(body))),
      ).toString("base64"),
    }),
  );

const TEXT_BODY = {
  output: [{ content: [{ type: "output_text", text: "the sealed answer" }] }],
  usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
};

const BATCH = {
  id: "b1",
  object: "batch",
  endpoint: "/v1/responses",
  input_file_id: "f1",
  completion_window: "24h",
  status: "validating",
  created_at: 1_790_000_000,
};

interface NodeOptions {
  /** The status every `POST /v1/jobs` answers, with an error envelope. */
  submitStatus?: number;
  /** The status every `GET /v1/jobs/{id}` answers, with an error envelope. */
  readStatus?: number;
  /** The status `POST /v1/jobs/{id}/cancel` answers, with an error envelope. */
  cancelStatus?: number;
  /** The 2xx body `POST /v1/jobs/{id}/cancel` answers with. */
  cancelReceipt?: unknown;
  /** Routes matched ahead of the base ones — the forwarded surface. */
  extra?: Route[];
}

/**
 * The scripted node behind the transport: the harness's own five base routes,
 * the two-phase `POST /v1/jobs`, the job read, the signed cancel door, and the
 * gateway a settled result is fetched from.
 */
function node(options: NodeOptions = {}): Route[] {
  const wire = (status: number) =>
    json({ error: { message: `HTTP ${status}`, type: "coordinator_said_so" } }, status);
  return [
    ...(options.extra ?? []),
    ...baseRoutes(),
    [
      /\/v1\/jobs$/,
      (n, body) => {
        if (options.submitStatus !== undefined) return wire(options.submitStatus);
        const order = body as { job_id: string; expires_at: number };
        const jobId = order.job_id;
        if (n === 1) return json(QUOTE(jobId, BigInt(order.expires_at)), 402);
        return json({ job_id: jobId, task_cid: "bafytask", tx_hash: "0x1" }, 201);
      },
    ],
    [
      /\/v1\/jobs\/[^/]+\/cancel$/,
      (_n, _body, url) => {
        if (options.cancelStatus !== undefined) {
          return json(
            { error: { message: "already claimed", type: "state_conflict" } },
            options.cancelStatus,
          );
        }
        return json(
          options.cancelReceipt ?? { job_id: url.split("/").slice(-2)[0], tx_hash: "0xcafe" },
        );
      },
    ],
    [
      /\/v1\/jobs\/[^/?]+$/,
      (_n, _body, url) => {
        if (options.readStatus !== undefined) return wire(options.readStatus);
        return json({
          id: url.split("/").pop(),
          object: "job",
          status: "completed",
          result_cid: CID,
          vorq: { sla_secs: 3600, rate_in: "5", rate_out: "9", provider_id: 1, ended_because: 0, gas_fee: "0.03", fee: "0" },
        });
      },
    ],
    [/\/ipfs\//, () => new Response(sealedBlob(TEXT_BODY) as BodyInit, { status: 200 })],
  ];
}

/**
 * A stock `OpenAI` whose only non-default wiring is the transport.
 *
 * `attempts` is what the *package* asked for, one entry per `fetch` it issued —
 * which is the only place its retry loop is visible. The node's own `calls` see
 * one request per attempt too, but a transport-level retry underneath would show
 * there and not here, so the two count different things on purpose.
 */
function stock(
  routes: Route[] = baseRoutes(),
  over: Partial<ClientOptions> = {},
  openaiOver: Partial<OpenAIOptions> = {},
) {
  const { client: c, calls } = client(routes, over);
  const sealing = sealingFetch({ client: c });
  const attempts: string[] = [];
  const openai = new OpenAI({
    baseURL: "https://compat.test/v1",
    apiKey: "unused",
    fetch: (input, init) => {
      attempts.push(`${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input)).pathname}`);
      return sealing(input, init);
    },
    maxRetries: 0,
    ...openaiOver,
  });
  return { openai, calls, attempts };
}

/** Every `/v1/...` request the node saw, as `method path` — the auth handshake dropped. */
const surface = (calls: Call[]): string[] =>
  calls
    .map((c) => ({ path: new URL(c.url).pathname, method: c.method }))
    .filter((c) => c.path.startsWith("/v1/"))
    .map((c) => `${c.method} ${c.path}`);

/** The create body, cast because `vorq` is this network's block and not OpenAI's field. */
const params = (body: Record<string, unknown>) =>
  body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;

describe("the stock openai package over sealingFetch", () => {
  // -- 1 --------------------------------------------------------------------
  it("seals and reads a response through the stock package", async () => {
    const { openai } = stock(node(), { gateway: "http://gw" });

    const response = await openai.responses.create(
      params({ model: "m", input: "the prompt nobody upstream may read", vorq: { provider: 1 } }),
    );

    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(response.model).toBe("m");
    // `output_text` is the package's own derived field: it is only filled in
    // when the body says `object: "response"` and `output` is a list of items it
    // can walk. A body the package cannot model leaves this undefined.
    expect(response.output_text).toBe("the sealed answer");
    const message = response.output[0];
    expect(message?.type).toBe("message");
    expect(response.usage).toEqual({ input_tokens: 11, output_tokens: 22, total_tokens: 33 });
  });

  // -- 2 --------------------------------------------------------------------
  it("every batch call the package builds lands on the forward list", async () => {
    const { openai, calls } = stock(
      node({
        extra: [
          [
            /\/v1\/batches$/,
            (_n, _body, _url, init) =>
              init.method === "POST"
                ? json(BATCH)
                : json({ object: "list", data: [BATCH], has_more: false }),
          ],
          [/\/v1\/batches\/[^/]+\/cancel$/, () => json({ ...BATCH, status: "cancelling" })],
          [/\/v1\/batches\/[^/]+$/, () => json(BATCH)],
          [
            /\/v1\/files\/[^/]+\/content$/,
            () =>
              new Response("sealed output bytes", {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
              }),
          ],
        ],
      }),
    );

    const created = await openai.batches.create({
      completion_window: "24h",
      endpoint: "/v1/responses",
      input_file_id: "f1",
    });
    expect(created.id).toBe("b1");
    expect((await openai.batches.retrieve("b1")).object).toBe("batch");
    const page = await openai.batches.list();
    expect(page.data.map((b) => b.id)).toEqual(["b1"]);
    expect((await openai.batches.cancel("b1")).status).toBe("cancelling");
    expect(await (await openai.files.content("f1")).text()).toBe("sealed output bytes");

    // Nothing was refused, and nothing extra was sent: the package's own URLs,
    // exactly as the forward list spells them.
    expect(surface(calls)).toEqual([
      "POST /v1/batches",
      "GET /v1/batches/b1",
      "GET /v1/batches",
      "POST /v1/batches/b1/cancel",
      "GET /v1/files/f1/content",
    ]);
  });

  // -- 3 --------------------------------------------------------------------
  it("raises before a prompt is sent", async () => {
    const { openai, calls } = stock();

    const error = await openai.chat.completions
      .create({ model: "m", messages: [{ role: "user", content: "the prompt" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("/v1/responses");
    // Nothing left the process: not the prompt, not the handshake that would
    // have carried it. This body is a finished JSON string, so an empty log is
    // all this row can say; that the body was never even *read* is pinned by the
    // upload row below, where the package's own body is a lazy stream.
    expect(calls).toEqual([]);
  });

  it("refuses a file upload without reading a byte of it", async () => {
    const { openai, calls } = stock();

    // **The package hands this route a lazy body, and that is what makes the
    // central property observable from out here.** A `ReadableStream` uploadable
    // is a *streaming* uploadable, so `internal/uploads.js` takes the
    // `createStreamingFormRequestOptions` arm and builds a lazy multipart
    // `ReadableStream` with `duplex: "half"` rather than buffering a `FormData`.
    // Nothing is pulled from it until somebody reads the body — so a refusal
    // that reads first shows up here as `pulled > 0`, with the caller's JSONL
    // pulled into this process to be thrown away.
    let pulled = 0;
    const file = new ReadableStream(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new TextEncoder().encode('{"line":1}\n'));
          controller.close();
        },
      },
      // `highWaterMark: 0`, or the stream pulls once at construction to fill its
      // own queue and the count is 1 before `sealingFetch` is even called — an
      // instrument that reports a leak nobody performed.
      { highWaterMark: 0 },
    );

    const error = await openai.files
      .create({ file: file as never, purpose: "batch" })
      .catch((e: unknown) => e);

    expect(pulled).toBe(0);
    expect(calls).toEqual([]);
    // The multipart body is also the one a stock caller can reach that no JSON
    // parser will read, so this pins the shape of the refusal too: a status
    // error naming the sealed path. A refusal that *parsed* the body first would
    // throw a `SyntaxError` out of the deny branch — which sits outside the
    // dispatcher's `try` — and the package reports that as `APIConnectionError`,
    // blaming the network for a request that never left.
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("client.batches.submit(requests)");
  });

  // -- 4 --------------------------------------------------------------------
  it("raises on streaming instead of yielding nothing", async () => {
    const { openai } = stock(node(), { gateway: "http://gw" });

    const streaming = {
      model: "m",
      input: "the prompt",
      stream: true,
      vorq: { provider: 1 },
    } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;

    const error = await (async () => {
      const stream = await openai.responses.create(streaming);
      for await (const event of stream) {
        // A 200 that is not an event stream reads to the package as a stream
        // that ended, so a caller iterating it would see success and no answer.
        // Nothing may arrive here.
        throw new Error(`the sealed surface yielded a stream event: ${JSON.stringify(event)}`);
      }
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("background");
  });

  // -- 4b: the disagreement this file was written to find --------------------
  /**
   * The package can ask the **retrieve** route for a stream too, and it does it
   * through a query parameter no hand-rolled `fetch(url, init)` in
   * `openai-compat.test.ts` ever builds: `responses.retrieve(id, {stream: true})`
   * is `GET /v1/responses/{id}?stream=true`, and the package then reads the
   * answer as SSE. Before this test the transport answered it with a JSON 200 —
   * which the package reads as an event stream that ended, so the caller
   * iterated a settled response and got zero events and no error.
   */
  it("raises on a streaming retrieve instead of yielding nothing", async () => {
    const { openai } = stock(node(), { gateway: "http://gw" });

    let events = 0;
    const error = await (async () => {
      const stream = await openai.responses.retrieve(JOB, { stream: true } as never);
      for await (const _event of stream as unknown as AsyncIterable<unknown>) events++;
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("streaming is not available");
    expect(events).toBe(0);
  });

  it("reads a retrieve that explicitly asked for no stream", async () => {
    const { openai } = stock(node(), { gateway: "http://gw" });

    // The pair to the row above, and the reason the guard compares the value
    // instead of testing for presence. `{stream: false}` is a caller asking for
    // exactly what this surface offers, and the package renders it — `qs` writes
    // a boolean `false` as `stream=false` — and then parses the answer as JSON,
    // because it only opens a stream when `query.stream` is true. Refusing on
    // presence alone would refuse a correct call, and there would be nothing to
    // catch it: `params.stream !== undefined` leaves every other test green.
    const response = await openai.responses.retrieve(JOB, { stream: false } as never);

    expect(response.object).toBe("response");
    expect(response.id).toBe(JOB);
    expect(response.output_text).toBe("the sealed answer");
  });

  it("still reads a retrieve the package decorated with other query parameters", async () => {
    const { openai } = stock(node(), { gateway: "http://gw" });

    // `?include[]=…` is the package's own encoding, and it must not change a
    // match: this route is matched on its path, and the sealed answer is the
    // whole response either way.
    const response = await openai.responses.retrieve(JOB, {
      include: ["message.output_text.logprobs"],
    });

    expect(response.id).toBe(JOB);
    expect(response.output_text).toBe("the sealed answer");
  });

  // -- 5 --------------------------------------------------------------------
  it("renders a cancel receipt that is not a job object", async () => {
    const { openai } = stock(node());

    // The node's cancel answers a relay receipt — `{job_id, tx_hash}`, keyed
    // `job_id` and carrying no status. The package models a Response.
    const response = await openai.responses.cancel(JOB);

    expect(response.id).toBe(JOB);
    expect(response.status).toBe("cancelled");
  });

  // -- 6 --------------------------------------------------------------------
  it("names a 2xx cancel that carries no job", async () => {
    const { openai } = stock(node({ cancelReceipt: { tx_hash: "0xcafe" } }));

    const error = await openai.responses.cancel(JOB).catch((e: unknown) => e);

    // A status error — `APIError` with a `.status`, which in 7.8.0 is the
    // `BadRequestError` below — and not the `APIConnectionError` a `TypeError`
    // escaping into the package would have produced: the coordinator answered,
    // and the answer is what was wrong.
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("named no job_id");
  });

  // -- 7 --------------------------------------------------------------------
  it("surfaces a claimed-job cancel as a conflict", async () => {
    const { openai, calls } = stock(node({ cancelStatus: 409 }));

    const error = await openai.responses.cancel(JOB).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.ConflictError);
    expect((error as APIError).status).toBe(409);
    // The cancel is a signed chain op and carries nothing else: no id in the
    // body, and none of the package's own request fields.
    const sent = calls.find((c) => c.url.endsWith("/cancel"))?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["issued_at", "signature"]);
  });

  // -- 8 --------------------------------------------------------------------
  it.each([
    [400, OpenAI.BadRequestError],
    [401, OpenAI.AuthenticationError],
    [404, OpenAI.NotFoundError],
    [409, OpenAI.ConflictError],
    [429, OpenAI.RateLimitError],
    [500, OpenAI.InternalServerError],
    [503, OpenAI.InternalServerError],
  ])("preserves the coordinator's status: %i", async (status, cls) => {
    const { openai } = stock(node({ readStatus: status }));

    const error = await openai.responses.retrieve(JOB).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(cls);
    expect((error as APIError).status).toBe(status);
  });

  // -- 9 --------------------------------------------------------------------
  it.each([429, 500, 503])("never retries a failed submission: %i", async (status) => {
    const { openai, calls, attempts } = stock(node({ submitStatus: status }), {}, { maxRetries: 3 });

    const error = await openai.responses
      .create(params({ model: "m", input: "the prompt", vorq: { provider: 1 } }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.APIError);
    // Every one of these statuses is on the package's own retry list, and
    // `maxRetries: 3` would have replayed all three. `x-should-retry: false` is
    // what stopped it — and a re-seal mints a fresh job id, so a replay is not a
    // duplicate the coordinator can collapse, it is a second order paid for.
    expect(attempts).toHaveLength(1);
    expect(new Set(posts(calls).map((c) => (c.body as { job_id: string }).job_id))
      .size).toBe(1);
  });

  // -- 10 -------------------------------------------------------------------
  it("still retries an idempotent read", async () => {
    const { openai, attempts } = stock(node({ readStatus: 503 }), {}, { maxRetries: 2 });

    const error = await openai.responses.retrieve(JOB).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAI.InternalServerError);
    // The pair to the test above: a read costs nothing to repeat, so the header
    // is set on the submit and nowhere else. Without this, "never retries" is
    // satisfied just as well by a transport that suppressed every retry there is.
    expect(attempts).toEqual([
      `GET /v1/responses/${JOB}`,
      `GET /v1/responses/${JOB}`,
      `GET /v1/responses/${JOB}`,
    ]);
  });

});
