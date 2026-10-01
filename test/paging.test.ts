import { describe, expect, it } from "vitest";
import { VorqError } from "../src/errors.js";
import { PAGE_DEFAULT_LIMIT, pageAgain, pageRows, readPage, walkListing } from "../src/paging.js";
import { QUOTE, baseRoutes, client, clientWithFetch, json } from "./helpers/submit-harness.js";

const withHeaders = (headers: Record<string, string>): Response =>
  new Response("{}", { headers });

describe("readPage", () => {
  it("reads both signals off the response", () => {
    // Breaks if `readPage` reads only one header, or reads the body instead:
    // `transport.json` discards headers, which is why the wired listings do not
    // use it.
    const page = readPage(
      withHeaders({ "x-vorq-page-truncated": "true", "x-vorq-next-offset": "37" }),
      [1, 2, 3],
      0,
    );
    expect(page).toEqual({ items: [1, 2, 3], truncated: true, nextOffset: 37 });
  });

  it("reports not-truncated when the header says false", () => {
    // Breaks on a `!== "false"` reading of the flag, which would call every
    // page truncated and page forever.
    const page = readPage(withHeaders({ "x-vorq-page-truncated": "false" }), [1], 0);
    expect(page).toEqual({ items: [1], truncated: false, nextOffset: null });
  });

  it("treats an absent header as not truncated", () => {
    // A browser with the header un-exposed, or a route that predates the
    // budget. Not truncated is the safe reading: `returned === limit` still
    // drives paging, so a full page is still followed. Believing an absent
    // header meant `true` would page forever against a route that never
    // truncates — which is the break this catches.
    const page = readPage(withHeaders({}), [1], 0);
    expect(page.truncated).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it("falls back to offset + returned when truncated with no cursor", () => {
    // Half a paging contract: the flag arrived and the cursor did not. The
    // offset is derivable, so derive it rather than stopping. Breaks if the
    // fallback is dropped and `nextOffset` becomes `null` — `pageAgain` would
    // then answer `null` for a page that was explicitly cut short.
    const page = readPage(withHeaders({ "x-vorq-page-truncated": "true" }), [1, 2], 10);
    expect(page.nextOffset).toBe(12);
  });

  it("refuses a cursor that does not advance past the offset it was read at", () => {
    // The coordinator emits `offset + returned`, so a cursor at or behind
    // `offset` is malformed — and following one re-reads the page that produced
    // it, forever. Breaks the moment the `parsed > offset` guard goes: `0` is a
    // safe integer, so a bare `Number.isSafeInteger` check accepts it and the
    // walk restarts from the top of the listing on every iteration.
    const stuck = readPage(
      withHeaders({ "x-vorq-page-truncated": "true", "x-vorq-next-offset": "40" }),
      [1, 2],
      40,
    );
    expect(stuck.nextOffset).toBe(42);
    const backwards = readPage(
      withHeaders({ "x-vorq-page-truncated": "true", "x-vorq-next-offset": "0" }),
      [1, 2],
      40,
    );
    expect(backwards.nextOffset).toBe(42);
  });

  it("refuses a cursor that is not plain decimal digits", () => {
    // `Number("")` is 0 and `Number(" 12 ")` is 12: a bare `Number()` would
    // read an empty header as a cursor to offset zero. The coordinator parses
    // its own paging parameters with `/^\d+$/` and so does this. Breaks if the
    // regex is replaced by a bare `Number()` conversion.
    for (const raw of ["", " 12", "1e3", "-1", "0x10", "12.5"]) {
      const page = readPage(
        withHeaders({ "x-vorq-page-truncated": "true", "x-vorq-next-offset": raw }),
        [1, 2],
        10,
      );
      expect(page.nextOffset, `cursor ${JSON.stringify(raw)}`).toBe(12);
    }
  });
});

describe("pageAgain — the two-half stop condition", () => {
  it("keeps paging on a full page that was NOT truncated", () => {
    const page = { items: new Array(100).fill(0), truncated: false, nextOffset: null };
    // An ABSOLUTE offset, not a count: 40 already read plus 100 more. Breaks if
    // this branch ever answers a count again — the two branches must agree on
    // what they mean or no call site can be correct for both.
    expect(pageAgain(page, 40, 100)).toBe(140);
  });

  it("keeps paging on a SHORT page that WAS truncated", () => {
    // The half a naive client drops. `returned < limit` used to mean "last
    // page" and stopped meaning it the moment a byte budget could end one early.
    const page = { items: new Array(12).fill(0), truncated: true, nextOffset: 52 };
    expect(pageAgain(page, 40, 100)).toBe(52);
  });

  it("stops on a short page that was not truncated", () => {
    const page = { items: new Array(12).fill(0), truncated: false, nextOffset: null };
    expect(pageAgain(page, 40, 100)).toBeNull();
  });

  it("stops on an empty page even if something claims truncation", () => {
    // Nothing was returned, so resuming at the same offset would spin. Breaks
    // if the empty-page guard is removed: `pageAgain` would answer 5 forever.
    const page = { items: [], truncated: true, nextOffset: 5 };
    expect(pageAgain(page, 40, 100)).toBeNull();
  });

});

describe("walkListing — the property, driven through the function that carries it", () => {
  it("walks every page shape to exactly the rows the listing holds", async () => {
    // This used to be a hand-rolled loop over `pageAgain`, and that was most of
    // why the walk's truncation branch went unpinned for two rounds: a walk
    // test that does not call the walk function proves nothing about it. Two
    // mutations inside `walkListing` — dropping the truncation half, and
    // reading every page at offset 0 — passed the entire suite until this test
    // called `walkListing` itself.
    //
    // Four shapes, in the order that makes each branch load-bearing:
    //   1. a FULL page the budget did not cut  → `returned === limit`, resume 100
    //   2. a SHORT page the budget cut, with a cursor → follow the header, 112
    //   3. a SHORT page the budget cut, with NO cursor → derive `offset + rows`
    //   4. a short page the budget did not cut → the end
    //
    // Page 3 is what makes `offset` load-bearing. The derived cursor is
    // relative, so a walk reading it at a fixed 0 answers 8 instead of 120 and
    // sends the next request *backwards* into rows it has already read.
    const pages: Array<[number, Record<string, string>]> = [
      [100, { "x-vorq-page-truncated": "false" }],
      [12, { "x-vorq-page-truncated": "true", "x-vorq-next-offset": "112" }],
      [8, { "x-vorq-page-truncated": "true" }],
      [7, { "x-vorq-page-truncated": "false" }],
    ];
    const asked: number[] = [];
    let n = 0;

    const rows = await walkListing<number>(async (offset) => {
      asked.push(offset);
      const [count, headers] = pages[n]!;
      n += 1;
      return { response: new Response("{}", { headers }), rows: new Array<number>(count).fill(n) };
    }, 100);

    expect(rows).toHaveLength(127);
    // The offsets are the assertion that cannot be satisfied by accident. A
    // walk that read the right number of rows from the wrong places is still a
    // broken walk — and a re-read page would show up here and nowhere else.
    expect(asked).toEqual([0, 100, 112, 120]);
    // Every page was asked for exactly once, and the walk stopped on its own.
    expect(n).toBe(pages.length);
  });

  it("stops on the first short, uncut page without asking for another", async () => {
    const asked: number[] = [];
    const rows = await walkListing<number>(async (offset) => {
      asked.push(offset);
      return {
        response: new Response("{}", { headers: { "x-vorq-page-truncated": "false" } }),
        rows: [1, 2, 3],
      };
    }, 100);
    expect(rows).toEqual([1, 2, 3]);
    expect(asked).toEqual([0]);
  });

  it("stops on an empty first page rather than spinning on it", async () => {
    // An empty page that claims truncation is a coordinator problem, not
    // something to loop on.
    //
    // **The fixture stops answering empty after the third call on purpose.** A
    // faithful one answers empty forever, and against a walk with the guard
    // removed that spins the event loop without ever yielding — so the break
    // arrives as a hung suite that no timer interrupts, which is a worse signal
    // than a failed assertion and cost this round one wedged run to learn. The
    // escape hatch makes the same break land on `calls` instead.
    let calls = 0;
    const rows = await walkListing<number>(async () => {
      calls += 1;
      // Call 4 is short and uncut, so even a guard-less walk terminates there.
      const spent = calls > 3;
      return {
        response: new Response("{}", {
          headers: spent
            ? { "x-vorq-page-truncated": "false" }
            : { "x-vorq-page-truncated": "true", "x-vorq-next-offset": String(calls * 5) },
        }),
        rows: spent ? [1] : [],
      };
    }, 100);
    expect(rows).toEqual([]);
    expect(calls).toBe(1);
  });
});

// -- the wired listings ------------------------------------------------------
//
// `transport.json` throws headers away, so these assert the listings go through
// `transport.request`. Each one is scripted with a page shape that a listing
// reading only half the rule would report as complete.

const TRUNCATED = { "x-vorq-page-truncated": "true", "x-vorq-next-offset": "112" };
const WHOLE = { "x-vorq-page-truncated": "false" };

/** `n` opaque rows — the count is the only thing these assertions read. */
const rows = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ key: `0x${i}`, status: 1 }));

describe("the listings carry the paging signals", () => {
  it("reports where to resume after a FULL page the budget did not cut", async () => {
    // The failure this whole helper exists for. `truncated` is `false` and the
    // cursor header is absent, and there are still rows behind this page: a
    // listing that copied `readPage`'s `nextOffset` straight through would
    // answer `null` here and the caller would stop at 100 of 150.
    const c = clientWithFetch(() => json({ asks: rows(PAGE_DEFAULT_LIMIT) }, 200, WHOLE));
    const book = await c.asks();
    expect(book.truncated).toBe(false);
    expect(book.nextOffset).toBe(PAGE_DEFAULT_LIMIT);
  });

  it("ends the listing on a short page the budget did not cut", async () => {
    // The mirror: nothing to resume from, and a `nextOffset` that was not
    // `null` would walk a caller off the end of the listing forever.
    const c = clientWithFetch(() => json({ asks: rows(7) }, 200, WHOLE));
    const book = await c.asks();
    expect(book.truncated).toBe(false);
    expect(book.nextOffset).toBeNull();
  });

  it("reports a truncated SHORT page as resumable, and where", async () => {
    // 12 rows of a 100-row page. Breaks the moment `asks` goes back through
    // `transport.json`: the headers vanish, `truncated` reads `false`, the page
    // is short, and the listing reports itself complete having read 12 rows.
    const c = clientWithFetch(() => json({ asks: rows(12) }, 200, TRUNCATED));
    const book = await c.asks({ offset: 100 });
    expect(book.asks).toHaveLength(12);
    expect(book.truncated).toBe(true);
    expect(book.nextOffset).toBe(112);
  });

  it("honours the caller's own limit rather than the default", async () => {
    // 50 rows is a full page for `limit: 50` and a short one for the default.
    // Breaks if `pageOf` hard-codes `PAGE_DEFAULT_LIMIT` instead of preferring
    // the limit the request actually carried — the listing would stop at 50
    // rows of however many the query matches.
    const c = clientWithFetch(() => json({ asks: rows(50) }, 200, WHOLE));
    expect((await c.asks({ limit: 50 })).nextOffset).toBe(50);
    expect((await c.asks({ limit: 60 })).nextOffset).toBeNull();
  });

  it("carries the signals on the job book too, with its query intact", async () => {
    // The wiring is per-listing, so each one is asserted; the query check is
    // here because moving a call off `transport.json` is exactly where a
    // `params` object gets dropped.
    const seen: string[] = [];
    const c = clientWithFetch((url) => {
      seen.push(url);
      const jobs = rows(12).map((row) => ({ ...row, gas_fee: "0.03", fee: "0" }));
      return json({ jobs, as_of_block: 900 }, 200, TRUNCATED);
    });
    const book = await c.jobs({ state: "Open", model: 3, offset: 100 });
    expect(book.jobs).toHaveLength(12);
    expect(book.truncated).toBe(true);
    expect(book.nextOffset).toBe(112);
    expect(book.asOfBlock).toBe(900n);
    expect(seen.at(-1)).toContain("state=Open");
    expect(seen.at(-1)).toContain("model=3");
    expect(seen.at(-1)).toContain("offset=100");
  });

  it("carries the signals on the allowlist too", async () => {
    const c = clientWithFetch(() => json({ entries: rows(12) }, 200, TRUNCATED));
    const list = await c.allowlist({ offset: 100 });
    expect(list.entries).toHaveLength(12);
    expect(list.truncated).toBe(true);
    expect(list.nextOffset).toBe(112);
  });

  it("walks a listing to its end across all three page shapes", async () => {
    // The end-to-end property, driven through the real client: a full page, a
    // page the budget cut at 12, and a short final page. A listing honouring
    // only one half of the rule stops at 100 or at 112 and reports a complete
    // book. The offsets requested are asserted too — re-reading a page is the
    // other way to get the count right and the walk wrong.
    const scripted: Array<[Record<string, unknown>[], Record<string, string>]> = [
      [rows(PAGE_DEFAULT_LIMIT), WHOLE],
      [rows(12), TRUNCATED],
      [rows(7), WHOLE],
    ];
    const asked: (string | null)[] = [];
    let n = 0;
    const c = clientWithFetch((url) => {
      asked.push(new URL(url).searchParams.get("offset"));
      const [page, headers] = scripted[n]!;
      n += 1;
      return json({ entries: page }, 200, headers);
    });

    let offset: number | null = 0;
    let total = 0;
    while (offset !== null && n < scripted.length) {
      const list: Awaited<ReturnType<typeof c.allowlist>> = await c.allowlist({ offset });
      total += list.entries.length;
      offset = list.nextOffset;
    }
    expect(total).toBe(119);
    expect(asked).toEqual(["0", "100", "112"]);
  });
});

describe("pageRows — an empty listing is an answer, so it is never manufactured", () => {
  it("hands back the rows when the key is an array, empty included", () => {
    expect(pageRows({ asks: [1, 2] }, "asks", "GET /evm/asks")).toEqual([1, 2]);
    // A genuinely empty listing still reads as one: the refusal below is about
    // a body with no row array in it, not about a body with no rows.
    expect(pageRows({ asks: [] }, "asks", "GET /evm/asks")).toEqual([]);
  });

  it("refuses a body it cannot find rows in, by name and not as a TypeError", () => {
    // Breaks on the tolerant `?? []` this replaced: that answered an empty
    // listing — indistinguishable from "nothing on the network", which a caller
    // acts on — for a response the SDK could not parse. Both halves are pinned:
    // that it throws at all, and that it is a named `invalid_response` rather
    // than the bare TypeError a `.map()` over a non-array would raise.
    for (const body of [{}, { asks: null }, { asks: { 0: 1 } }, { asks: "[]" }, null]) {
      const raised = (): unknown[] => pageRows(body, "asks", "GET /evm/asks");
      expect(raised, JSON.stringify(body)).toThrowError(VorqError);
      expect(raised, JSON.stringify(body)).toThrowError(/GET \/evm\/asks/);
    }
    expect(() => pageRows({}, "asks", "GET /evm/asks")).not.toThrowError(TypeError);
  });

  it("refuses it through the wired listing rather than reporting an empty book", async () => {
    const c = clientWithFetch(() => json({ as_of_block: 900 }, 200, WHOLE));
    const book = await c.asks().catch((e: unknown) => e);
    expect(book).toBeInstanceOf(VorqError);
    expect((book as VorqError).type).toBe("invalid_response");
  });
});

// -- the model catalog -------------------------------------------------------
//
// `/v1/models` is a `budgeted()` route, and the bound that bites is the ROW cap
// rather than the byte budget: a request naming no limit is answered 100 rows,
// so a 101-model catalog loses model 101 today. `modelIdFor` resolves against
// this list, so a catalog cut at page one makes the SDK refuse a model that
// exists, naming the wrong cause.

/** A catalog page of `n` models nobody looks up, to fill a page exactly. */
const fillers = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ id: `filler/${i}`, object: "model" }));

const LATE_MODEL = { id: "m", object: "model", vorq: { model_id: 7 } };

describe("models.list walks the catalog", () => {
  it("reads past the first page instead of stopping at the row cap", async () => {
    // Breaks the instant the walk is removed: a single read returns 100 models
    // and `m` — the 101st — is simply absent, with nothing about the answer
    // saying so.
    const asked: (string | null)[] = [];
    const c = clientWithFetch((url) => {
      const params = new URL(url).searchParams;
      asked.push(params.get("offset"));
      return json(
        { object: "list", data: params.get("offset") === null ? fillers(PAGE_DEFAULT_LIMIT) : [LATE_MODEL] },
        200,
        WHOLE,
      );
    });
    const catalog = await c.models.list();
    expect(catalog).toHaveLength(PAGE_DEFAULT_LIMIT + 1);
    expect(catalog.at(-1)!.id).toBe("m");
    expect(asked).toEqual([null, "100"]);
  });

  it("follows a truncated catalog page even though it is short", async () => {
    // Every other `/v1/models` fixture here says `truncated: false`, which left
    // the walk's truncation branch unexercised through its only real caller.
    // 12 rows of a 100-row page is a page the byte budget cut, and a walk
    // honouring only `returned === limit` calls it the last page and hands back
    // a catalog missing everything behind it — `modelIdFor` then refuses models
    // that exist, which is the bug this round-1 fix was for, returning by a
    // different door.
    const asked: (string | null)[] = [];
    const c = clientWithFetch((url) => {
      const offset = new URL(url).searchParams.get("offset");
      asked.push(offset);
      return offset === null
        ? json({ object: "list", data: fillers(12) }, 200, {
            "x-vorq-page-truncated": "true",
            "x-vorq-next-offset": "12",
          })
        : json({ object: "list", data: [LATE_MODEL] }, 200, WHOLE);
    });
    const catalog = await c.models.list();
    expect(catalog).toHaveLength(13);
    expect(catalog.at(-1)!.id).toBe("m");
    expect(asked).toEqual([null, "12"]);
  });

  it("sends the limit it compares against rather than assuming the default", async () => {
    // The walk is immune to `PAGE_DEFAULT_LIMIT` drifting away from the
    // coordinator's only because the number is on the request. Breaks if the
    // `limit` param is dropped: the comparison would be against a value the
    // coordinator never confirmed.
    const asked: (string | null)[] = [];
    const c = clientWithFetch((url) => {
      asked.push(new URL(url).searchParams.get("limit"));
      return json({ object: "list", data: [LATE_MODEL] }, 200, WHOLE);
    });
    await c.models.list();
    expect(asked).toEqual([String(PAGE_DEFAULT_LIMIT)]);
  });

  it("resolves a model that lives past page one, end to end through submit", async () => {
    // The bug as a user meets it. `m` is the 101st model; before the walk this
    // submission died at `modelIdFor` with "the catalog carries no numeric
    // model_id for \"m\"" — an error naming the caller's model rather than the
    // client's short read. Breaks back to that refusal if the walk is removed.
    const { client: c, calls } = client([
      [
        // Answered by `offset`, never by hit count. `submit` reads the catalog
        // twice (once for `paramsSchema`, once for `modelIdFor`), so a route
        // handing page two to the second *request* would let two single-page
        // reads impersonate one two-page walk — and this test would pass with
        // the paging deleted. Verified: it did, until this changed.
        /\/v1\/models/,
        (_n, _body, url) =>
          json(
            {
              object: "list",
              data:
                new URL(url).searchParams.get("offset") === null
                  ? fillers(PAGE_DEFAULT_LIMIT)
                  : [LATE_MODEL],
            },
            200,
            WHOLE,
          ),
      ],
      ...baseRoutes(),
      [
        /\/v1\/jobs$/,
        (n, body) => {
          const { job_id, expires_at } = body as { job_id: string; expires_at: number };
          return n === 1
            ? json(QUOTE(job_id, BigInt(expires_at)), 402)
            : json({ job_id, task_cid: "bafy", tx_hash: "0x1" });
        },
      ],
    ]);
    const handle = await c.submit({ model: "m", input: "hello", provider: 1 });
    expect(handle.id).toMatch(/^0x[0-9a-f]{64}$/);
    // The order signed the id from page two, not a zero and not page one's.
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/jobs"))!;
    expect((posted.body as { model_id: number }).model_id).toBe(7);
    expect(calls.filter((call) => call.url.includes("/v1/models")).length).toBeGreaterThan(1);
  });

  it("never caches a partial catalog, even for the walk that failed", async () => {
    // The cache is a FULL-catalog cache: `paramsSchema` and `modelIdFor` answer
    // out of it without re-reading and treat a present cache as authoritative.
    // Populating it page by page would let one failed walk poison every lookup
    // for the whole TTL — models that exist, unresolvable, for five minutes.
    // Breaks if the cache is assigned inside the walk instead of after it.
    const schema = { type: "object", properties: {} };
    const good = { id: "a/model", object: "model", vorq: { model_id: 1, params_schema: schema } };
    let broken = false;
    const c = clientWithFetch((url) => {
      if (!broken) return json({ object: "list", data: [good] }, 200, WHOLE);
      return new URL(url).searchParams.get("offset") === null
        ? json({ object: "list", data: fillers(PAGE_DEFAULT_LIMIT) }, 200, WHOLE)
        : json({ error: { message: "the projection is rebuilding" } }, 503);
    });

    expect(await c.models.paramsSchema("a/model")).toEqual(schema);
    broken = true;
    await expect(c.models.list()).rejects.toBeInstanceOf(VorqError);
    // The good catalog is still there — the failed walk left no fillers behind.
    expect(await c.models.paramsSchema("a/model")).toEqual(schema);
    expect(await c.models.list().catch(() => null)).toBeNull();
  });
});
