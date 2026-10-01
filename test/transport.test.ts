import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  TransportError,
  ValidationError,
  VorqError,
} from "../src/errors.js";
import { DEFAULT_TIMEOUT_MS, Transport } from "../src/transport.js";

/** A fetch stub that answers a scripted queue and records what it was asked. */
function scripted(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error("fetch called more times than scripted");
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fail = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const RETRYABLE = { "x-vorq-retryable": "true" };

function build(responses: Response[], extra: Partial<ConstructorParameters<typeof Transport>[0]> = {}) {
  const { fetch, calls } = scripted(responses);
  const slept: number[] = [];
  const transport = new Transport({
    baseUrl: "http://node.test",
    fetch,
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
    ...extra,
  });
  return { transport, calls, slept };
}

describe("Transport", () => {
  it("joins the base url and the path, and appends params", async () => {
    const { transport, calls } = build([ok()]);
    await transport.request("GET", "/evm/asks", { params: { model: 7, skip: undefined } });
    expect(calls[0]!.url).toBe("http://node.test/evm/asks?model=7");
  });

  it("strips a trailing slash from the base url", async () => {
    const { transport, calls } = build([ok()], { baseUrl: "http://node.test/" });
    await transport.request("GET", "/key");
    expect(calls[0]!.url).toBe("http://node.test/key");
  });

  it("attaches the bearer token when a token is held, and omits it when not", async () => {
    const { transport, calls } = build([ok()], { hooks: { token: () => "vorq_sess_abc" } });
    await transport.request("GET", "/v1/models");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer vorq_sess_abc");

    const bare = build([ok()]);
    await bare.transport.request("GET", "/v1/models");
    expect(new Headers(bare.calls[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("calls ensureSession before every request", async () => {
    const ensureSession = vi.fn(async () => {});
    const { transport } = build([ok(), ok()], { hooks: { ensureSession } });
    await transport.request("GET", "/v1/models");
    await transport.request("GET", "/v1/models");
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });

  it("retries only when x-vorq-retryable is true", async () => {
    const { transport, calls } = build([
      fail(503, { error: { message: "later" } }, RETRYABLE),
      ok(),
    ]);
    const resp = await transport.request("GET", "/evm/jobs");
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 503 without the header", async () => {
    const { transport, calls } = build([fail(503, { error: { message: "later" } })]);
    await expect(transport.request("GET", "/evm/jobs")).rejects.toBeInstanceOf(VorqError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the call opted out, even with the header", async () => {
    // Submissions pass retry:false so a job that already exists is never duplicated.
    const { transport, calls } = build([fail(503, { error: { message: "later" } }, RETRYABLE)]);
    await expect(
      transport.request("POST", "/v1/jobs", { retry: false }),
    ).rejects.toBeInstanceOf(VorqError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { transport, calls } = build(
      Array.from({ length: 3 }, () => fail(503, { error: { message: "later" } }, RETRYABLE)),
      { maxRetries: 2 },
    );
    await expect(transport.request("GET", "/evm/jobs")).rejects.toThrowError("later");
    expect(calls).toHaveLength(3); // the first try plus two retries
  });

  it("backs off 0.5·2^attempt seconds plus jitter in [0, 0.25)", async () => {
    const { transport, slept } = build([
      fail(503, { error: { message: "later" } }, RETRYABLE),
      fail(503, { error: { message: "later" } }, RETRYABLE),
      ok(),
    ]);
    await transport.request("GET", "/evm/jobs");
    // random() is pinned at 0.5, so jitter is 0.125 s on both attempts.
    expect(slept).toEqual([625, 1125]);
  });

  /**
   * A rotating session: `reauthorize` swaps the token the way the `Client` will,
   * so the retry can be shown to go out with the *new* credential. Without that,
   * a re-mint that changed nothing is indistinguishable from a working one.
   */
  function rotatingSession() {
    let token = "old";
    const reauthorize = vi.fn(async () => {
      token = "new";
      return true;
    });
    return { reauthorize, hooks: { reauthorize, token: () => token } };
  }

  const authOf = (call: { init: RequestInit }) =>
    new Headers(call.init.headers).get("authorization");

  it("re-mints the session on a 401 exactly once, then retries with the new token", async () => {
    const { reauthorize, hooks } = rotatingSession();
    const { transport, calls } = build(
      [fail(401, { error: { message: "expired" } }), ok()],
      { hooks },
    );
    const resp = await transport.request("GET", "/v1/jobs/0x1");
    expect(resp.status).toBe(200);
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // The retry is only worth making if it carries the re-minted credential.
    expect(authOf(calls[0]!)).toBe("Bearer old");
    expect(authOf(calls[1]!)).toBe("Bearer new");
  });

  it("re-mints a 401 even for a call that opted out of retries", async () => {
    // No job was created, so re-authing a submission duplicates nothing.
    const { reauthorize, hooks } = rotatingSession();
    const { transport, calls } = build([fail(401, { error: { message: "expired" } }), ok()], {
      hooks,
    });
    await expect(transport.request("POST", "/v1/jobs", { retry: false })).resolves.toBeTruthy();
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(authOf(calls[1]!)).toBe("Bearer new");
  });

  it("raises on a second 401 rather than re-minting again", async () => {
    const { reauthorize, hooks } = rotatingSession();
    const { transport, calls } = build(
      [fail(401, { error: { message: "expired" } }), fail(401, { error: { message: "still" } })],
      { hooks },
    );
    await expect(transport.request("GET", "/v1/jobs/0x1")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // The one re-mint did reach the wire; the second 401 is the token being
    // refused, not the transport replaying a stale one.
    expect(authOf(calls[1]!)).toBe("Bearer new");
  });

  it("re-mints again on a later request: the one-shot flag is per call, not per client", async () => {
    const { reauthorize, hooks } = rotatingSession();
    const { transport, calls } = build(
      [
        fail(401, { error: { message: "expired" } }),
        ok(),
        fail(401, { error: { message: "expired again" } }),
        ok(),
      ],
      { hooks },
    );
    await transport.request("GET", "/v1/jobs/0x1");
    await transport.request("GET", "/v1/jobs/0x2");
    expect(reauthorize).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(4);
  });

  it("raises a 401 unchanged when there is no signer to re-mint with", async () => {
    const { transport, calls } = build([fail(401, { error: { message: "expired" } })]);
    await expect(transport.request("GET", "/v1/jobs/0x1")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("returns an allowed status to the caller instead of throwing", async () => {
    const { transport } = build([fail(402, { error: { message: "pay" } })]);
    const resp = await transport.request("POST", "/v1/jobs", { allowStatuses: [402] });
    expect(resp.status).toBe(402);
    await expect(resp.json()).resolves.toMatchObject({ error: { message: "pay" } });
  });

  it("maps the error class from the status and carries x-request-id", async () => {
    const { transport } = build([
      fail(400, { error: { message: "bad model", type: "invalid_request_error" } }, {
        "x-request-id": "req-9",
      }),
    ]);
    const err = await transport.request("GET", "/v1/models").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).requestId).toBe("req-9");
    expect((err as ValidationError).statusCode).toBe(400);
  });

  it("degrades when the error body is not JSON at all", async () => {
    const { fetch } = scripted([new Response("<html>502</html>", { status: 502 })]);
    const transport = new Transport({ baseUrl: "http://node.test", fetch });
    await expect(transport.request("GET", "/v1/models")).rejects.toThrowError("HTTP 502");
  });

  it("sends JSON with the right content-type", async () => {
    const { transport, calls } = build([ok()]);
    await transport.request("POST", "/v1/batches", { json: { a: 1 } });
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("json() parses the body for the caller", async () => {
    const { transport } = build([ok({ chain_id: 84532 })]);
    await expect(transport.json("GET", "/evm/chain")).resolves.toEqual({ chain_id: 84532 });
  });
});

describe("a request that never becomes a response", () => {
  /** A fetch that always rejects with `reason`, counting its calls. */
  function refusing(reason: unknown) {
    const fetch = vi.fn(async () => {
      throw reason;
    });
    const transport = new Transport({
      baseUrl: "http://node.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    return { transport, fetch };
  }

  it("surfaces a dropped connection as a TransportError, not a bare TypeError", async () => {
    // Without the wrap this escapes as `TypeError: fetch failed`, which a caller
    // cannot tell apart from a TypeError thrown by a bug in this SDK.
    const dropped = new TypeError("fetch failed");
    const { transport } = refusing(dropped);
    const error = await transport.request("GET", "/evm/chain").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toBeInstanceOf(VorqError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as TransportError).cause).toBe(dropped);
    expect((error as TransportError).statusCode).toBeNull();
    expect((error as TransportError).message).toContain("could not be reached");
    expect((error as TransportError).message).toContain("http://node.test/evm/chain");
  });

  it("says timed out for the transport's own abort, and reached for a dead socket", async () => {
    // The two remedies differ — raise timeoutMs, or find the coordinator — so
    // the message has to say which happened. A single "request failed" for both
    // would pass any assertion that only checked the class.
    const timeout = new DOMException("The operation was aborted.", "TimeoutError");
    const timedOut = (await refusing(timeout)
      .transport.request("GET", "/evm/chain")
      .catch((e: unknown) => e)) as TransportError;
    expect(timedOut.message).toMatch(new RegExp(`timed out after ${DEFAULT_TIMEOUT_MS} ms`));
    expect(timedOut.message).not.toMatch(/could not be reached/);
    expect(timedOut.cause).toBe(timeout);

    const aborted = (await refusing(new DOMException("aborted", "AbortError"))
      .transport.request("GET", "/evm/chain")
      .catch((e: unknown) => e)) as TransportError;
    expect(aborted.message).toMatch(/aborted before it answered/);
  });

  it("does not retry it — a request that died on the wire may have landed", async () => {
    // `retry` is left at its default and the transport has its full three
    // retries available; a transport failure carries no `x-vorq-retryable`
    // marking, so it is thrown on the first attempt and the count says so.
    const { transport, fetch } = refusing(new TypeError("fetch failed"));
    await expect(transport.request("POST", "/v1/jobs")).rejects.toBeInstanceOf(TransportError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("discarded responses", () => {
  /** A response whose body records the moment it is cancelled. */
  function tracked(status: number, headers: Record<string, string> = {}) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode('{"error":{}}')),
      cancel: () => {
        state.cancelled = true;
      },
    });
    return {
      state,
      response: new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    };
  }

  it("cancels the body of a response it retries past", async () => {
    // Under undici an abandoned body holds its connection until the socket is
    // garbage-collected, so a retry loop that never drains leaks one per attempt.
    const first = tracked(503, RETRYABLE);
    const { transport } = build([first.response, ok()]);
    await transport.request("GET", "/evm/jobs");
    expect(first.state.cancelled).toBe(true);
  });

  it("cancels the body of the 401 it re-mints past", async () => {
    const reauthorize = vi.fn(async () => true);
    const expired = tracked(401);
    const { transport } = build([expired.response, ok()], {
      hooks: { reauthorize, token: () => "t" },
    });
    await transport.request("GET", "/v1/jobs/0x1");
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(expired.state.cancelled).toBe(true);
  });

  it("leaves the body of the response it raises from intact, so the error reads", async () => {
    // The last response is the one `errorFor` parses; cancelling that one would
    // trade a leak for an unreadable error.
    const { transport } = build([fail(400, { error: { message: "bad model" } })]);
    await expect(transport.request("GET", "/v1/models")).rejects.toThrowError("bad model");
  });
});

describe("the stale token handed to reauthorize", () => {
  it("is the credential this request actually sent", async () => {
    // The client uses it to tell "my token was refused" from "somebody else
    // already rotated it while I was in flight". Without the argument the hook
    // can only read the client's *current* token, which is the rotated one.
    const seen: Array<string | null> = [];
    const reauthorize = vi.fn(async (stale: string | null) => {
      seen.push(stale);
      return true;
    });
    const { transport } = build([fail(401, { error: { message: "expired" } }), ok()], {
      hooks: { reauthorize, token: () => "vorq_sess_mine" },
    });
    await transport.request("GET", "/v1/jobs/0x1");
    expect(seen).toEqual(["vorq_sess_mine"]);
  });

  it("is null when the request carried no token at all", async () => {
    const seen: Array<string | null> = [];
    const { transport } = build([fail(401, { error: { message: "expired" } }), ok()], {
      hooks: {
        reauthorize: async (stale) => {
          seen.push(stale);
          return true;
        },
      },
    });
    await transport.request("GET", "/v1/jobs/0x1");
    expect(seen).toEqual([null]);
  });
});
