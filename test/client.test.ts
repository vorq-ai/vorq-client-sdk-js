import { describe, expect, it, vi } from "vitest";
import { AuthenticationError, ValidationError, VorqError } from "../src/errors.js";
import { Client, mintSessionToken } from "../src/client.js";
import { PrivateKeySigner } from "../src/signer/private-key.js";

const KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const CHAIN = {
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
  head_block: 900,
  block_time_ms: 2000,
};

/** One route's answer. `Promise` so a test can hold a request in flight. */
type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fake coordinator: routes by `METHOD /path`, records every hit. */
function node(routes: Record<string, Route>) {
  const hits: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    hits.push(`${key}${url.search}`);
    const handler = routes[key];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(url, init);
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, hits };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const HANDSHAKE = {
  "GET /auth/nonce": (url: URL) => {
    expect(url.searchParams.get("address")).toBe(ADDRESS);
    return json({ nonce: "vorq-session-nonce-0001", expires_at: 4102444800, chain_id: 84532 });
  },
  "POST /auth/session": (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { address: string; signature: string };
    expect(body.address).toBe(ADDRESS);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    return json({ token: "vorq_sess_first", expires_at: 4102444800 });
  },
};

function client(routes: Record<string, Route>) {
  const { fetch, hits } = node(routes);
  return {
    hits,
    client: new Client({
      baseUrl: "http://node.test",
      signer: new PrivateKeySigner(KEY),
      fetch,
    }),
  };
}

describe("the session handshake", () => {
  it("mints a token from nonce → sign → session, and reuses it", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/chain": () => json(CHAIN),
      "GET /v1/models": () => json({ object: "list", data: [] }),
    });
    await c.chainContext();
    await c.models.list();
    expect(c.sessionToken).toBe("vorq_sess_first");
    // The handshake runs once, not once per request.
    expect(hits.filter((h) => h.startsWith("GET /auth/nonce"))).toHaveLength(1);
  });

  it("sends the token as a bearer on every authenticated read", async () => {
    let seen: string | null = null;
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /evm/chain": (_u, init) => {
        seen = new Headers(init.headers).get("authorization");
        return json(CHAIN);
      },
    });
    await c.chainContext();
    expect(seen).toBe("Bearer vorq_sess_first");
  });

  it("re-mints on a 401 and fetches a FRESH nonce, never replaying the burned one", async () => {
    // The node burns a nonce on lookup, before the signature is checked, so a
    // retry that reuses it always fails.
    const nonces = ["nonce-one", "nonce-two"];
    const seen: string[] = [];
    const auth: Array<string | null> = [];
    let first = true;
    const { client: c } = client({
      "GET /auth/nonce": () => json({ nonce: nonces.shift()!, expires_at: 4102444800, chain_id: 84532 }),
      "POST /auth/session": (_u, init) => {
        seen.push((JSON.parse(String(init.body)) as { nonce: string }).nonce);
        return json({ token: `vorq_sess_${seen.length}`, expires_at: 4102444800 });
      },
      "GET /evm/chain": (_u, init) => {
        auth.push(new Headers(init.headers).get("authorization"));
        if (first) {
          first = false;
          return json({ error: { message: "expired" } }, { status: 401 });
        }
        return json(CHAIN);
      },
    });
    await expect(c.chainContext()).resolves.toBeTruthy();
    expect(seen).toEqual(["nonce-one", "nonce-two"]);
    expect(c.sessionToken).toBe("vorq_sess_2");
    // The composition, not just the layers: a client that re-mints correctly
    // while the retry goes out under the pre-mint header would satisfy every
    // other assertion here and still be sending a token the node has retired.
    expect(auth).toEqual(["Bearer vorq_sess_1", "Bearer vorq_sess_2"]);
  });

  it("does not mint a second time for a 401 another request already rotated past", async () => {
    // Two reads go out under the same token; the first 401 rotates it. The
    // second read's 401 is a *stale* credential, not a refused live one, so the
    // remedy is to retry with what the client now holds. Re-minting instead
    // burns a one-shot nonce to arrive at a token no better than the live one.
    let minted = 0;
    const auth: Array<string | null> = [];
    let gate: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const { client: c } = client({
      "GET /auth/nonce": () => json({ nonce: `nonce-${minted}`, expires_at: 4102444800, chain_id: 84532 }),
      "POST /auth/session": () => {
        minted += 1;
        return json({ token: `vorq_sess_${minted}`, expires_at: 4102444800 });
      },
      // Answers 401 to the first token it sees and 200 to anything newer, so
      // the two reads race exactly the way two in-flight requests do.
      "GET /evm/asks": async (_u, init) => {
        const header = new Headers(init.headers).get("authorization");
        auth.push(header);
        if (header === "Bearer vorq_sess_1") {
          // Hold the second read's 401 until the first has finished rotating.
          if (auth.length > 1) await held;
          return json({ error: { message: "expired" } }, { status: 401 });
        }
        return json({ asks: [], as_of_block: 1 });
      },
      "GET /evm/jobs": () => json({ jobs: [] }),
    });

    const firstRead = c.asks();
    const secondRead = c.asks();
    await firstRead;
    gate!();
    await secondRead;

    expect(minted).toBe(2); // the initial mint, and exactly one re-mint
    expect(c.sessionToken).toBe("vorq_sess_2");
    // Both reads ended up on the rotated token; neither ran a third handshake.
    expect(auth.filter((h) => h === "Bearer vorq_sess_2")).toHaveLength(2);
  });

  it("re-mints before expiry rather than after it", async () => {
    let minted = 0;
    const { client: c } = client({
      "GET /auth/nonce": () => json({ nonce: `n${minted}`, expires_at: 4102444800, chain_id: 84532 }),
      "POST /auth/session": () => {
        minted += 1;
        // Expires 30 s from now — inside the 60 s refresh skew, so the very next
        // request must rotate it.
        return json({ token: `t${minted}`, expires_at: Math.floor(Date.now() / 1000) + 30 });
      },
      "GET /evm/chain": () => json(CHAIN),
      "GET /v1/models": () => json({ object: "list", data: [] }),
    });
    await c.chainContext();
    await c.models.list();
    expect(minted).toBe(2);
  });

  it("raises the nonce route's own error rather than a session one", async () => {
    const { client: c } = client({
      "GET /auth/nonce": () =>
        json({ error: { message: "address is required", type: "invalid_request_error" } }, { status: 400 }),
    });
    await expect(c.ensureSession()).rejects.toBeInstanceOf(ValidationError);
  });

  it("mints ONE token for concurrent reads rather than burning two nonces", async () => {
    // The nonce is one-shot and burned on lookup, so a second concurrent mint is
    // not merely wasteful: it races the first, and one of the two signatures is
    // checked against a nonce that is already gone.
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /key": () => json({ escrow_public_key: "ab".repeat(32), evidence: {}, issued_at: 1 }),
    });
    await Promise.all([c.escrowKey(), c.escrowKey(), c.escrowKey()]);
    expect(hits.filter((h) => h.startsWith("GET /auth/nonce"))).toHaveLength(1);
    expect(hits.filter((h) => h.startsWith("POST /auth/session"))).toHaveLength(1);
    expect(c.sessionToken).toBe("vorq_sess_first");
  });

  it("clears the mint guard when a mint fails, rather than wedging the client", async () => {
    // A latched rejected promise would make every later call reject forever, so a
    // transient 500 on the nonce route would be indistinguishable from a dead
    // client — and unlike a 401 there is nothing to re-mint against.
    let failNonce = true;
    const { client: c } = client({
      "GET /auth/nonce": () => {
        if (failNonce) {
          failNonce = false;
          return json({ error: { message: "nonce store unavailable" } }, { status: 500 });
        }
        return json({ nonce: "vorq-session-nonce-0002", expires_at: 4102444800, chain_id: 84532 });
      },
      "POST /auth/session": () => json({ token: "vorq_sess_retried", expires_at: 4102444800 }),
    });
    await expect(c.ensureSession()).rejects.toBeInstanceOf(VorqError);
    await expect(c.ensureSession()).resolves.toBeUndefined();
    expect(c.sessionToken).toBe("vorq_sess_retried");
  });
});

describe("a 200 that is not an answer", () => {
  it("names the missing token rather than reporting a rejected signature", async () => {
    // A stored `undefined` passes `this.token !== null`, so the transport
    // retries with no Authorization header at all, takes a second 401, and
    // tells the caller their signature was refused — when what happened is that
    // the coordinator returned a malformed session.
    const { client: c } = client({
      ...HANDSHAKE,
      "POST /auth/session": () => json({}),
    });
    const error = await c.ensureSession().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(VorqError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect((error as VorqError).message).toContain("token");
    expect((error as VorqError).type).toBe("invalid_response");
    expect(c.sessionToken).toBeNull();
  });

  it("refuses an empty or non-string token just as firmly", async () => {
    for (const token of [null, "", 42, { token: "x" }]) {
      const { client: c } = client({ ...HANDSHAKE, "POST /auth/session": () => json({ token }) });
      await expect(c.ensureSession()).rejects.toThrowError(/no usable `token`/);
    }
  });

  it("names the missing nonce before it signs anything", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /auth/nonce": () => json({ expires_at: 4102444800 }),
    });
    await expect(c.ensureSession()).rejects.toThrowError(/GET \/auth\/nonce/);
    // And it stopped there: nothing was signed and no session was attempted.
    expect(hits.some((h) => h.startsWith("POST /auth/session"))).toBe(false);
  });

  it("keeps sessionToken `string | null`, never `undefined`", async () => {
    const { client: c } = client({ ...HANDSHAKE, "POST /auth/session": () => json({}) });
    await c.ensureSession().catch(() => {});
    expect(c.sessionToken).toBeNull();
    expect(c.sessionToken).not.toBeUndefined();
  });
});

describe("Client.fromSessionToken", () => {
  it("uses a pre-minted token and never mints one", async () => {
    const { fetch, hits } = node({ "GET /evm/chain": () => json(CHAIN) });
    const c = Client.fromSessionToken("vorq_sess_given", { baseUrl: "http://node.test", fetch });
    await c.chainContext();
    expect(hits.some((h) => h.includes("/auth/"))).toBe(false);
  });

  it("without a signer, a 401 is raised rather than re-minted", async () => {
    const { fetch } = node({
      "GET /evm/chain": () => json({ error: { message: "expired" } }, { status: 401 }),
    });
    const c = Client.fromSessionToken("vorq_sess_given", { baseUrl: "http://node.test", fetch });
    await expect(c.chainContext()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("chainContext", () => {
  it("reads GET /evm/chain once and caches it for the client's life", async () => {
    const { client: c, hits } = client({ ...HANDSHAKE, "GET /evm/chain": () => json(CHAIN) });
    const first = await c.chainContext();
    const second = await c.chainContext();
    expect(second).toBe(first);
    expect(hits.filter((h) => h.startsWith("GET /evm/chain"))).toHaveLength(1);
  });

  it("refuses a body missing a contract instead of signing against a guess", async () => {
    const { job_registry, ...rest } = CHAIN.contracts;
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /evm/chain": () => json({ ...CHAIN, contracts: rest }),
    });
    await expect(c.chainContext()).rejects.toBeInstanceOf(ValidationError);
  });

  it("shares one read between concurrent callers, never handing out two contexts", async () => {
    // Caching the value rather than the promise leaves a window in which both
    // callers see an empty cache. Two contexts in flight is the thing the cache
    // exists to prevent: they can disagree about the registry being signed against.
    const { client: c, hits } = client({ ...HANDSHAKE, "GET /evm/chain": () => json(CHAIN) });
    const [first, second] = await Promise.all([c.chainContext(), c.chainContext()]);
    expect(second).toBe(first);
    expect(hits.filter((h) => h.startsWith("GET /evm/chain"))).toHaveLength(1);
  });

  it("does not latch a failed read — the next call retries it", async () => {
    // Caching the promise must not cache a rejection: one bad minute on the relay
    // would otherwise take the client down for its whole life.
    let failing = true;
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/chain": () => {
        if (failing) {
          failing = false;
          return json({ error: { message: "relay unavailable" } }, { status: 500 });
        }
        return json(CHAIN);
      },
    });
    await expect(c.chainContext()).rejects.toBeInstanceOf(VorqError);
    expect((await c.chainContext()).chainId).toBe(84532);
    expect(hits.filter((h) => h.startsWith("GET /evm/chain"))).toHaveLength(2);
  });
});

describe("the reads", () => {
  it("reads ask rates as the USD strings the node sent", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/asks": () =>
        json({
          asks: [{ provider_id: 7, model_id: 3, sla: 3600, rate_in: "340282366920938463463374607431768.211455", rate_out: "0" }],
          as_of_block: 900,
        }),
    });
    const book = await c.asks({ model: 3 });
    expect(hits.at(-1)).toContain("?model=3");
    // Past any double, and exact: a string is never rounded on the way in.
    expect(book.asks[0]!.rateIn).toBe("340282366920938463463374607431768.211455");
    expect(book.asks[0]!.rateOut).toBe("0");
    expect(book.asks[0]!.providerId).toBe(7);
    expect(book.asOfBlock).toBe(900n);
  });

  it("reads an ask rate that is not a USD string as zero, and a double past 2^53 as no block", async () => {
    // `1e30` does not survive a double: it comes back as
    // 1000000000000000019884624838656, thirteen digits invented, so the
    // block number is refused. A rate as a JSON number is not a USD string at
    // all; the display listing's policy is "0".
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /evm/asks": () =>
        new Response(
          '{"asks":[{"provider_id":1,"model_id":1,"sla":1,"rate_in":1e30,' +
            '"rate_out":"0.05"}],"as_of_block":1e30}',
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const book = await c.asks();
    expect(book.asOfBlock).toBeNull();
    expect(book.asks[0]!.rateIn).toBe("0");
    expect(book.asks[0]!.rateOut).toBe("0.05");
    expect(book.asks[0]!.providerId).toBe(1);
  });

  it("filters the job book by chain-state name, model id, provider id and owner", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs": () => json({ jobs: [], as_of_block: 900 }),
    });
    await c.jobs({ state: "Open", model: 3, provider: 7, owner: ADDRESS, limit: 50 });
    const query = hits.at(-1)!;
    expect(query).toContain("state=Open");
    expect(query).toContain("model=3");
    expect(query).toContain("provider=7");
    expect(query).toContain(`owner=${encodeURIComponent(ADDRESS)}`);
    expect(query).toContain("limit=50");
  });

  it("reads a job's client-shaped status straight off the node", async () => {
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /v1/jobs/0xdead": () =>
        json({
          id: "0xdead",
          object: "job",
          model: "a/model",
          status: "in_progress",
          in_progress_at: "1786000000",
          result_cid: null,
          vorq: { job_id: "0xdead", sla_secs: 3600, rate_in: "10", rate_out: "20", gas_fee: "0.03", fee: "0" },
          as_of_block: 900,
        }),
    });
    // `Client.job` hands back the real `JobHandle`, whose `status()` is the wire
    // status string — the row itself is the handle's to hold and re-read, and
    // `result()` is what reads the terms off it.
    expect(await c.job("0xdead").status()).toBe("in_progress");
  });

  it("percent-encodes a job id into the path", async () => {
    // The chain-shaped read is where this is still assertable. `JobHandle`'s own
    // reads interpolate the id unescaped, exactly as the authority does
    // (`vorq/_handles.py:88`), and a job id is 32 hex bytes for which the two
    // spellings are the same string — so pinning an escape there would be this
    // SDK answering differently from the other for an id neither can be handed.
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs/a%2Fb": () => json({ job_id: "a/b", gas_fee: "0.03", fee: "0" }),
    });
    await c.evmJob("a/b");
    expect(hits.at(-1)).toBe("GET /evm/jobs/a%2Fb");
  });

  it("reads the chain-shaped job row through evmJob, passed through untouched", async () => {
    const row = { job_id: "0xdead", state: 1, provider_id: 7, model_id: 3, gas_fee: "0.03", fee: "0", as_of_block: 900 };
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs/0xdead": () => json(row),
    });
    // The chain shape is the node's, not the client's: no camel-casing and no
    // coercion, so a column this spec never named still reaches the caller.
    expect(await c.evmJob("0xdead")).toEqual(row);
    expect(hits.at(-1)).toBe("GET /evm/jobs/0xdead");
  });

  it("reads a provider record and an allowlist", async () => {
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /evm/providers/7": () =>
        json({ provider_id: 7, operator: ADDRESS, box_key: `0x${"ab".repeat(32)}`, listed: true, as_of_block: 900 }),
      "GET /evm/allowlist": () =>
        json({ entries: [{ key: `0x${"cd".repeat(32)}`, status: 1, entry: {} }], as_of_block: 900 }),
    });
    expect((await c.providers(7)).providerId).toBe(7);
    expect((await c.allowlist()).entries).toHaveLength(1);
  });

  it("reads the escrow key announcement, which serves its key bare", async () => {
    const bare = "ab".repeat(32);
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /key": () => json({ escrow_public_key: bare, evidence: { kind: "mock" }, issued_at: 1786000000 }),
    });
    const announcement = await c.escrowKey();
    // No 0x: `GET /key` builds this by hand, while every `bytes` column on the
    // /evm wire is prefixed. Spec 04 normalizes both at one door.
    expect(announcement.escrowPublicKey).toBe(bare);
  });

  it("retrieves a model whose name spans path segments", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      // The fake node keys on the raw pathname, so the key carries the `%3A`
      // that `encodeURIComponent` produces for `:`. The real node decodes the
      // wildcard remainder (`catalog.ts:70`), so both spellings land on the
      // one stored name; the slashes stay literal so the wildcard spans them.
      "GET /v1/models/org/model%3Afp8": () =>
        json({ id: "org/model:fp8", object: "model", owned_by: "vorq", vorq: { model_id: 3, enabled: true } }),
    });
    await c.models.retrieve("org/model:fp8");
    expect(hits.at(-1)).toBe("GET /v1/models/org/model%3Afp8");
  });

  it("reads the floors listing through the paged transport, rates as USD strings", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/asks/floors": () =>
        json(
          {
            floors: [{ model_id: 7, sla: 3600, rate_in: "0.44", rate_out: "9007199254.740993" }],
            as_of_block: 900,
          },
          { headers: { "x-vorq-page-truncated": "false" } },
        ),
    });
    const book = await c.floors({ model: 7, limit: 1000, offset: 0 });
    expect(hits.at(-1)).toContain("/evm/asks/floors?");
    expect(hits.at(-1)).toContain("model=7");
    expect(hits.at(-1)).toContain("limit=1000");
    // `offset=0` is the value a truthiness check would drop, and dropping it
    // makes a floors walk re-read page one forever.
    expect(hits.at(-1)).toContain("offset=0");
    expect(book.floors).toEqual([{ modelId: 7, sla: 3600, rateIn: "0.44", rateOut: "9007199254.740993" }]);
    expect(book.asOfBlock).toBe(900n);
    // One row against a limit of 1000: the last page.
    expect(book.nextOffset).toBeNull();
  });

  it("sends the floors window and a non-zero offset, and no window when none was named", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/asks/floors": () => json({ floors: [], as_of_block: 900 }),
    });
    // The tier names `submit` takes, resolved to the window's seconds on the wire.
    await c.floors({ model: 7, sla: "batch", limit: 10, offset: 20 });
    expect(hits.at(-1)).toContain("sla=86400");
    expect(hits.at(-1)).toContain("offset=20");
    await c.floors({ sla: "async" });
    expect(hits.at(-1)).toContain("sla=3600");
    await c.floors({ sla: "24h" });
    expect(hits.at(-1)).toContain("sla=86400");
    await c.floors();
    expect(hits.at(-1)).not.toContain("sla=");
  });

  it("refuses a floors window it does not know, with nothing on the wire", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/asks/floors": () => json({ floors: [], as_of_block: 900 }),
    });
    const before = hits.length;
    // No one-hour fallback: a typo priced as the 1 h window is the wrong order signed.
    await expect(c.floors({ sla: "batc" as "batch" })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.floors({ sla: 3600 as unknown as "async" })).rejects.toBeInstanceOf(ValidationError);
    expect(hits.length).toBe(before);
  });

  it("hands back the floors page's next offset absolute, not added to the one asked for", async () => {
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /evm/asks/floors": () =>
        json(
          {
            floors: [{ model_id: 7, sla: 3600, rate_in: "0.000001", rate_out: "0.000002" }],
            as_of_block: 900,
          },
          { headers: { "x-vorq-page-truncated": "true", "x-vorq-next-offset": "40" } },
        ),
    });
    const book = await c.floors({ limit: 1000, offset: 20 });
    expect(book.truncated).toBe(true);
    // The header's own value — not `offset + rows.length`, and not `offset + 40`.
    expect(book.nextOffset).toBe(40);
  });

  it("refuses a floor it cannot read as a USD string, rather than quoting zero", async () => {
    // A floor is the rate an order signs, so a `"0"` standing in for an
    // unreadable rate is a model quoted as free.
    const bad = (body: unknown) =>
      client({ ...HANDSHAKE, "GET /evm/asks/floors": () => json(body) }).client.floors({ model: 7 });
    const row = { model_id: 7, sla: 3600, rate_in: "0.000001", rate_out: "0.000002" };
    const page = (floors: unknown[]) => ({ floors, as_of_block: 900 });
    await expect(bad(page([row]))).resolves.toBeDefined();
    await expect(bad(page([{ ...row, rate_in: 1 }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, rate_out: undefined }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, rate_in: "1e30" }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, rate_in: "-1" }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, model_id: 7.5 }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, model_id: "x" }]))).rejects.toBeInstanceOf(VorqError);
    await expect(bad(page([{ ...row, sla: null }]))).rejects.toBeInstanceOf(VorqError);
    // A `null` element is a `VorqError` too — `Object.hasOwn(null, …)` would
    // throw a `TypeError` straight out of the SDK's error taxonomy.
    await expect(bad(page([null]))).rejects.toBeInstanceOf(VorqError);
  });

  it("refuses a job row whose gas_fee is not a USD string, on every job read", async () => {
    // `gas_fee` is money the owner paid on claim; a row without it cannot say
    // what the job cost.
    const row = { job_id: "0xdead", state: 1, gas_fee: "0.03", fee: "0" };
    const book = (jobs: unknown[]) =>
      client({ ...HANDSHAKE, "GET /evm/jobs": () => json({ jobs, as_of_block: 900 }) }).client.jobs();
    const one = (body: unknown) =>
      client({ ...HANDSHAKE, "GET /evm/jobs/0xdead": () => json(body) }).client.evmJob("0xdead");
    const status = (vorq: unknown) =>
      client({
        ...HANDSHAKE,
        "GET /v1/jobs/0xdead": () => json({ id: "0xdead", status: "queued", vorq }),
      }).client.job("0xdead").status();
    await expect(book([row])).resolves.toBeDefined();
    await expect(one(row)).resolves.toEqual(row);
    await expect(status({ gas_fee: "0.03", fee: "0" })).resolves.toBe("queued");
    for (const gas_fee of [1, undefined, "1e30", "-1", "$0.03"]) {
      await expect(book([{ ...row, gas_fee }])).rejects.toBeInstanceOf(VorqError);
      await expect(one({ ...row, gas_fee })).rejects.toBeInstanceOf(VorqError);
      await expect(status({ gas_fee, fee: "0" })).rejects.toBeInstanceOf(VorqError);
    }
    await expect(book([null])).rejects.toBeInstanceOf(VorqError);
    await expect(status(null)).rejects.toBeInstanceOf(VorqError);
  });

  it("refuses a job row whose fee is not a USD string, on every job read", async () => {
    // `fee` is the protocol fee settlement took; a row without it cannot say
    // what the job cost.
    const row = { job_id: "0xdead", state: 4, gas_fee: "0.03", fee: "0.00125" };
    const book = (jobs: unknown[]) =>
      client({ ...HANDSHAKE, "GET /evm/jobs": () => json({ jobs, as_of_block: 900 }) }).client.jobs();
    const one = (body: unknown) =>
      client({ ...HANDSHAKE, "GET /evm/jobs/0xdead": () => json(body) }).client.evmJob("0xdead");
    const status = (vorq: unknown) =>
      client({
        ...HANDSHAKE,
        "GET /v1/jobs/0xdead": () => json({ id: "0xdead", status: "queued", vorq }),
      }).client.job("0xdead").status();
    await expect(book([row])).resolves.toBeDefined();
    await expect(one(row)).resolves.toEqual(row);
    await expect(status({ gas_fee: "0.03", fee: "0" })).resolves.toBe("queued");
    for (const fee of [1, undefined, null, "1e30", "-1", "$0.03"]) {
      await expect(book([{ ...row, fee }])).rejects.toThrow(/fee is not a USD decimal string/);
      await expect(one({ ...row, fee })).rejects.toThrow(/fee is not a USD decimal string/);
      await expect(status({ gas_fee: "0.03", fee })).rejects.toThrow(/vorq\.fee is not a USD decimal string/);
    }
  });

  it("sends the job order the caller asked for, and nothing when it did not", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs": () => json({ jobs: [], as_of_block: 900 }),
    });
    await c.jobs({ owner: ADDRESS, order: "newest", limit: 50 });
    expect(hits.at(-1)).toContain("order=newest");
    await c.jobs({ owner: ADDRESS });
    expect(hits.at(-1)).not.toContain("order=");
  });

  it("reads a wallet's summary: counts as numbers, the sum as a USD string", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs/summary": () =>
        json({
          jobs: 4,
          completed: 1,
          escrowed: "0.000213",
          by_model: [
            { model_id: 3, jobs: 2, completed: 0, escrowed: "0.000001" },
            { model_id: 7, jobs: 2, completed: 1, escrowed: "0.000212" },
          ],
          as_of_block: 900,
        }),
    });
    const summary = await c.jobsSummary({ owner: ADDRESS });
    expect(hits.at(-1)).toContain(`owner=${encodeURIComponent(ADDRESS)}`);
    expect(summary).toEqual({
      jobs: 4,
      completed: 1,
      escrowed: "0.000213",
      byModel: [
        { modelId: 3, jobs: 2, completed: 0, escrowed: "0.000001" },
        { modelId: 7, jobs: 2, completed: 1, escrowed: "0.000212" },
      ],
      asOfBlock: 900n,
    });
  });

  it("refuses a summary whose figures are unreadable, rather than printing zero", async () => {
    const bad = (body: Record<string, unknown>) =>
      client({ ...HANDSHAKE, "GET /evm/jobs/summary": () => json(body) }).client.jobsSummary({
        owner: ADDRESS,
      });
    const base = { jobs: 1, completed: 0, escrowed: "5", by_model: [], as_of_block: 1 };
    await expect(bad(base)).resolves.toBeDefined();
    await expect(bad({ ...base, escrowed: 5 })).rejects.toBeInstanceOf(VorqError);
    await expect(bad({ ...base, escrowed: "5." })).rejects.toBeInstanceOf(VorqError);
    await expect(bad({ ...base, jobs: "1" })).rejects.toBeInstanceOf(VorqError);
    await expect(bad({ ...base, jobs: 1e30 })).rejects.toBeInstanceOf(VorqError);
    await expect(bad({ ...base, by_model: "none" })).rejects.toBeInstanceOf(VorqError);
    // A `null` row, not a `TypeError` out of `Object.hasOwn(null, …)`.
    await expect(bad({ ...base, by_model: [null] })).rejects.toBeInstanceOf(VorqError);
  });

  it("refuses a summary owner that is not a string, with nothing on the wire", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /evm/jobs/summary": () => json({}),
    });
    // The owner is the whole filter: a non-string one is either a wallet the
    // caller did not name or a whole-book scan, and neither is worth a request.
    await expect(
      c.jobsSummary({ owner: 7 as unknown as string }),
    ).rejects.toBeInstanceOf(VorqError);
    await expect(
      c.jobsSummary({} as { owner: string }),
    ).rejects.toBeInstanceOf(VorqError);
    // No query at all: a `VorqError`, not a `TypeError` out of `Object.hasOwn(undefined, …)`.
    await expect(
      c.jobsSummary(undefined as unknown as { owner: string }),
    ).rejects.toBeInstanceOf(VorqError);
    expect(hits).toEqual([]);
  });
});

describe("models.list", () => {
  it("hands back a copy, so a caller sorting it does not rewrite the cache", async () => {
    // Sorting or splicing a returned list is the ordinary thing to do with it.
    // Returning the cache itself makes that rewrite the catalog every later
    // `paramsSchema` lookup reads — and an emptied cache is not a *null* one,
    // so nothing re-fetches: the lookup just quietly stops finding the model.
    const schema = { type: "object", properties: {} };
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /v1/models": () =>
        json({
          object: "list",
          data: [
            { id: "b/model", object: "model", vorq: { model_id: 2 } },
            { id: "a/model", object: "model", vorq: { model_id: 1, params_schema: schema } },
          ],
        }),
    });
    const first = await c.models.list();
    expect(first.map((m) => m.id)).toEqual(["b/model", "a/model"]);

    first.sort((x, y) => x.id.localeCompare(y.id));
    first.splice(0, first.length);

    // The catalog is untouched, and answers from cache without re-reading.
    expect(await c.models.paramsSchema("a/model")).toEqual(schema);
    expect(hits.filter((h) => h.startsWith("GET /v1/models"))).toHaveLength(1);

    // And each call gets its own array.
    const second = await c.models.list();
    expect(second).not.toBe(first);
    expect(second.map((m) => m.id)).toEqual(["b/model", "a/model"]);
    expect(await c.models.list()).not.toBe(second);
  });
});

describe("models.paramsSchema", () => {
  it("returns null for every model today — no schema, never wrong validation", async () => {
    const { client: c, hits } = client({
      ...HANDSHAKE,
      "GET /v1/models": () =>
        json({ object: "list", data: [{ id: "a/model", object: "model", vorq: { model_id: 3, enabled: true } }] }),
    });
    expect(await c.models.paramsSchema("a/model")).toBeNull();
    // Cached: the second lookup does not re-read the catalog.
    expect(await c.models.paramsSchema("a/model")).toBeNull();
    expect(hits.filter((h) => h.startsWith("GET /v1/models"))).toHaveLength(1);
  });

  it("returns null for a model the catalog does not carry", async () => {
    const { client: c } = client({
      ...HANDSHAKE,
      "GET /v1/models": () => json({ object: "list", data: [] }),
    });
    expect(await c.models.paramsSchema("nope")).toBeNull();
  });
});

describe("mintSessionToken", () => {
  it("runs the handshake once and hands back the token", async () => {
    const { fetch } = node(HANDSHAKE);
    await expect(
      mintSessionToken({ signer: new PrivateKeySigner(KEY), baseUrl: "http://node.test", fetch }),
    ).resolves.toBe("vorq_sess_first");
  });
});
