import { describe, expect, it, vi } from "vitest";
import { buildUpload, fetchBlob, resolveGateway, GATEWAY_ATTEMPTS } from "../src/files.js";
import { DEFAULT_TIMEOUT_MS } from "../src/transport.js";
import { NotFoundError, ValidationError, VorqError } from "../src/errors.js";
// Reuse the harness the submission suites already have — do not build a second one.
import { clientWithFetch, json as jsonResponse } from "./helpers/submit-harness.js";

const ok = (body: string) => new Response(body, { status: 200 });
const status = (code: number) => new Response("", { status: code });
const noSleep = async () => {};

describe("fetchBlob", () => {
  it("returns the bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok("hello"));
    const out = await fetchBlob({ cid: "bafyx", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep });
    expect(new TextDecoder().decode(out)).toBe("hello");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://g/ipfs/bafyx");
  });

  it("waits out a 404 — a fresh name is not instantly resolvable", async () => {
    // These bytes were pinned seconds ago, so the first 404 is propagation far
    // more often than absence.
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n < 3 ? status(404) : ok("late")));
    const out = await fetchBlob({ cid: "c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep });
    expect(new TextDecoder().decode(out)).toBe("late");
    expect(n).toBe(3);
  });

  it("does not wait out a refusal it will keep giving", async () => {
    const fetchImpl = vi.fn(async () => status(403));
    await expect(
      fetchBlob({ cid: "c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep }),
    ).rejects.toThrow(VorqError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget", async () => {
    const fetchImpl = vi.fn(async () => status(404));
    await expect(
      fetchBlob({ cid: "c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep }),
    ).rejects.toThrow(VorqError);
    expect(fetchImpl).toHaveBeenCalledTimes(GATEWAY_ATTEMPTS);
  });

  it("wraps a connection that never answered", async () => {
    // A caller holding one `catch (e) { if (e instanceof VorqError) }` should
    // not also have to know which HTTP layer read the gateway.
    const fetchImpl = vi.fn(async () => { throw new TypeError("network down"); });
    const err = await fetchBlob({ cid: "c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VorqError);
    expect(err.message).toContain("could not reach");
  });

  it("says there is no read path rather than reaching for the coordinator", async () => {
    // The coordinator serves no blob endpoint, so there is no fallback to make.
    await expect(
      fetchBlob({ cid: "c", gateway: null, fetchImpl: (() => {}) as never }),
    ).rejects.toThrow(/no gateway configured/);
  });

  it("percent-encodes the name", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok(""));
    await fetchBlob({ cid: "a/b?c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://g/ipfs/a%2Fb%3Fc");
  });

  it("lets an explicit empty string disable the gateway", async () => {
    // "I will supply my own" must be sayable, not just the accident of nothing
    // being set.
    expect(resolveGateway("")).toBeNull();
    expect(resolveGateway("https://g/")).toBe("https://g");
    expect(resolveGateway(undefined)).toBe("https://ipfs.filebase.io");
  });

  it("prefers $VORQ_PIN_GATEWAY over the built-in default", () => {
    // Read through the same `globalThis` seam `resolveGateway` itself reads,
    // and restore it afterwards so no other test sees the override.
    const global = globalThis as { process?: { env?: Record<string, string | undefined> } };
    const proc = global.process;
    if (!proc) throw new Error("expected a Node `process` for this test");
    const env = (proc.env ??= {});
    const prev = env.VORQ_PIN_GATEWAY;
    env.VORQ_PIN_GATEWAY = "https://env-gateway.example/";
    try {
      expect(resolveGateway(undefined)).toBe("https://env-gateway.example");
    } finally {
      if (prev === undefined) delete env.VORQ_PIN_GATEWAY;
      else env.VORQ_PIN_GATEWAY = prev;
    }
  });

  it("gives a body read failure its own message — the gateway was reached", async () => {
    // The status check already passed by the time `arrayBuffer()` rejects, so
    // the gateway *was* reached; the message must not claim otherwise, or a
    // caller would go looking at connectivity instead of at the transfer.
    const fetchImpl = vi.fn(async () => {
      const response = new Response("", { status: 200 });
      response.arrayBuffer = () => Promise.reject(new Error("stream reset"));
      return response;
    });
    const err = await fetchBlob({ cid: "c", gateway: "https://g", fetchImpl: fetchImpl as never, sleep: noSleep })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VorqError);
    expect(err.message).not.toMatch(/could not reach/);
    expect(err.message).toContain("mid-transfer");
  });
});

/** What the upload door answers with: OpenAI's `FileObject` plus the `vorq` block. */
const FILE_OBJECT = {
  id: "file-abc",
  object: "file",
  bytes: 8,
  created_at: 1_800_000_000,
  expires_at: null,
  filename: "batch.jsonl",
  purpose: "batch",
  status: "uploaded",
  vorq: { cid: "bafy", lines: 1 },
};

describe("buildUpload", () => {
  it("builds a multipart body with the file and purpose parts", async () => {
    const form = buildUpload("batch.jsonl", "batch", '{"a":1}\n');
    const file = form.get("file");
    expect(form.get("purpose")).toBe("batch");
    // A field, not a part with a filename: the door reads `purpose` off
    // `part.value` and skips anything that arrives as a file.
    expect(typeof form.get("purpose")).toBe("string");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("batch.jsonl");
    expect((file as File).type).toBe("application/jsonl");
    expect(await (file as Blob).text()).toBe('{"a":1}\n');
  });

  it("puts purpose ahead of the file part, which is the order the door reads them in", () => {
    // The door reads its fields first and the file last, so it can refuse on
    // the fields before a byte of the file is taken.
    const form = buildUpload("batch.jsonl", "batch", '{"a":1}\n');
    expect([...form.keys()]).toEqual(["purpose", "file"]);
  });

  it("takes a Uint8Array as well as a string", async () => {
    // The overload, and only the overload. These bytes are valid UTF-8, so they
    // survive a decode/encode round trip unchanged and this case cannot fail on
    // a re-encode however hard it is broken — the case below is the one that
    // owns that claim.
    const bytes = new TextEncoder().encode('{"b":2}\n');
    const form = buildUpload("batch.jsonl", "batch", bytes);
    expect(new Uint8Array(await (form.get("file") as Blob).arrayBuffer())).toEqual(bytes);
  });

  it("hands bytes over without re-encoding them", async () => {
    // Not valid UTF-8: a `Uint8Array` put through a string comes back as
    // replacement characters. A batch line carries base64 ciphertext, which is
    // exactly the kind of thing that survives one round trip and not two.
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x80, 0x0a]);
    const form = buildUpload("batch.jsonl", "batch", bytes);
    expect(new Uint8Array(await (form.get("file") as Blob).arrayBuffer())).toEqual(bytes);
  });

  it("defaults to the JSONL media type and takes an override", () => {
    const stock = buildUpload("batch.jsonl", "batch", "{}\n");
    expect((stock.get("file") as File).type).toBe("application/jsonl");

    const sealed = buildUpload("container", "input", new Uint8Array([1, 2, 3]), "application/octet-stream");
    expect((sealed.get("file") as File).type).toBe("application/octet-stream");
  });
});

describe("Client.uploadFile", () => {
  it("POSTs multipart to /v1/files with no content-type of its own", async () => {
    const seen: { url: string; method: string; headers: Headers; body: unknown }[] = [];
    const client = clientWithFetch(async (url, init) => {
      seen.push({
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body,
      });
      return jsonResponse(FILE_OBJECT);
    });
    const file = await client.uploadFile("batch.jsonl", "batch", '{"a":1}\n');

    expect(file.id).toBe("file-abc");
    expect(file.lines).toBe(1);
    expect(file.cid).toBe("bafy");
    expect(file.bytes).toBe(8);
    expect(file.status).toBe("uploaded");
    expect(file.createdAt).toBe(1_800_000_000);
    expect(file.raw).toEqual(FILE_OBJECT);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://node/v1/files");
    expect(seen[0].method).toBe("POST");
    // Through the transport, so the session travels with it.
    expect(seen[0].headers.get("authorization")).toBe("Bearer vorq_sess_test");
    // The boundary is fetch's to choose. A content-type set here would carry no
    // boundary and the node's parser would reject the body.
    expect(seen[0].headers.get("content-type")).toBeNull();
    expect(seen[0].body).toBeInstanceOf(FormData);
    expect((seen[0].body as FormData).get("purpose")).toBe("batch");
    expect(((seen[0].body as FormData).get("file") as File).name).toBe("batch.jsonl");
  });

  it("sends application/octet-stream for input and result, JSONL for batch", async () => {
    const seen: FormData[] = [];
    const client = clientWithFetch(async (_url, init) => {
      seen.push(init.body as FormData);
      return jsonResponse(FILE_OBJECT);
    });
    await client.uploadFile("container", "input", new Uint8Array([1, 2, 3]));
    await client.uploadFile("result", "result", new Uint8Array([4, 5, 6]));
    await client.uploadFile("batch.jsonl", "batch", "{}\n");

    expect((seen[0]!.get("file") as File).type).toBe("application/octet-stream");
    expect((seen[1]!.get("file") as File).type).toBe("application/octet-stream");
    expect((seen[2]!.get("file") as File).type).toBe("application/jsonl");
  });

  it("never repeats an upload that may have landed", async () => {
    // A retryable 5xx is exactly what the transport would send again — and this
    // POST opted out, because a second upload the node accepted is a second
    // file it will bill and a second batch a caller never asked for.
    let calls = 0;
    const client = clientWithFetch(
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "later", type: "api_error" } }), {
          status: 503,
          headers: { "content-type": "application/json", "x-vorq-retryable": "true" },
        });
      },
      { maxRetries: 1 },
    );
    await expect(client.uploadFile("batch.jsonl", "batch", "x\n")).rejects.toThrow(VorqError);
    expect(calls).toBe(1);
  });

  it("surfaces the node's refusal of an empty file", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(
        {
          error: {
            message: "the uploaded file contains no requests",
            type: "invalid_request",
            code: "empty_file",
          },
        },
        400,
      ),
    );
    const error = await client.uploadFile("batch.jsonl", "batch", "\n\n").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as VorqError).message).toMatch(/contains no requests/);
    expect((error as VorqError).statusCode).toBe(400);
  });

  it("surfaces the two ceilings by their own messages", async () => {
    const tooManyLines = clientWithFetch(async () =>
      jsonResponse(
        {
          error: {
            message: "the uploaded file contains 50001 lines, past the 50000-line ceiling",
            type: "invalid_request",
            code: "too_many_lines",
          },
        },
        400,
      ),
    );
    await expect(tooManyLines.uploadFile("b.jsonl", "batch", "x\n")).rejects.toThrow(
      /past the 50000-line ceiling/,
    );

    const tooLarge = clientWithFetch(async () =>
      jsonResponse(
        {
          error: {
            message: "file is past this node's 209715200-byte ceiling",
            type: "invalid_request",
            code: "file_too_large",
          },
        },
        413,
      ),
    );
    const error = await tooLarge.uploadFile("b.jsonl", "batch", "x\n").catch((e: unknown) => e);
    expect((error as VorqError).message).toMatch(/byte ceiling/);
    expect((error as VorqError).statusCode).toBe(413);
    // `VorqError` itself, not a subclass: `errors.ts` maps 400/401/404/409 and
    // nothing else, and 413 is a size the caller reads off `statusCode` rather
    // than a distinct class. Pinned to the exact constructor, because every
    // class in that file passes an `instanceof VorqError` check.
    expect((error as object).constructor).toBe(VorqError);
    expect(error).not.toBeInstanceOf(ValidationError);
  });

  it("lets the node refuse a purpose it does not mint here", async () => {
    // `batch_output` is the node's own at finalization. The client does not
    // pre-empt the refusal — the enum lives on one side of the wire.
    const seen: FormData[] = [];
    const client = clientWithFetch(async (_url, init) => {
      seen.push(init.body as FormData);
      return jsonResponse(
        {
          error: {
            message:
              "purpose must be one of batch; batch_output is minted by this node at " +
              "finalization and cannot be uploaded",
            type: "invalid_request",
            code: "invalid_purpose",
          },
        },
        400,
      );
    });
    await expect(client.uploadFile("b.jsonl", "batch_output", "x\n")).rejects.toThrow(
      /cannot be uploaded/,
    );
    expect(seen[0].get("purpose")).toBe("batch_output");
  });
});

describe("Client.file", () => {
  it("reads the object back and lifts the members only this network has", async () => {
    const seen: string[] = [];
    const client = clientWithFetch(async (url) => {
      seen.push(url);
      return jsonResponse(FILE_OBJECT);
    });
    const file = await client.file("file-abc");
    expect(seen[0]).toBe("http://node/v1/files/file-abc");
    expect(file.cid).toBe("bafy");
    expect(file.lines).toBe(1);
    expect(file.filename).toBe("batch.jsonl");
    expect(file.purpose).toBe("batch");
  });

  it("leaves cid and lines null when the node sent no vorq block", async () => {
    const { vorq: _vorq, ...bare } = FILE_OBJECT;
    const client = clientWithFetch(async () => jsonResponse(bare));
    const file = await client.file("file-abc");
    expect(file.cid).toBeNull();
    expect(file.lines).toBeNull();
    expect(file.id).toBe("file-abc");
  });

  it("maps expires_at as a unix-seconds number, and null only if the parse can't read one", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse({ ...FILE_OBJECT, expires_at: 1_900_000_000 }),
    );
    expect((await client.file("file-abc")).expiresAt).toBe(1_900_000_000);

    // The node always sends a number in practice — 300s from creation while
    // unattached, bumped to FILE_RETENTION_SECONDS once attached. FILE_OBJECT's
    // own `expires_at: null` exercises the defensive fallback, the same one
    // `createdAt` has, for an answer that did not carry one.
    const noExpiry = clientWithFetch(async () => jsonResponse(FILE_OBJECT));
    expect((await noExpiry.file("file-abc")).expiresAt).toBeNull();
  });

  it("keeps a stranger's file a 404 and does not turn it into a permission error", async () => {
    // A 403 on someone else's id would confirm the id is real, and a file id is
    // the only thing standing between one client's batch input and another's.
    // A miss and a stranger's file are one answer here because they are one
    // answer there, and there is nothing in this client to tell them apart with.
    const client = clientWithFetch(async () =>
      jsonResponse({ error: { message: "No such file: file-xyz", type: "not_found" } }, 404),
    );
    const error = await client.file("file-xyz").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as VorqError).statusCode).toBe(404);
    expect((error as VorqError).message).toBe("No such file: file-xyz");
    expect((error as VorqError).message).not.toMatch(/permission|forbidden|not yours/i);
  });

  it("percent-encodes the id", async () => {
    const seen: string[] = [];
    const client = clientWithFetch(async (url) => {
      seen.push(url);
      return jsonResponse(FILE_OBJECT);
    });
    await client.file("a/b?c");
    expect(seen[0]).toBe("http://node/v1/files/a%2Fb%3Fc");
  });
});

describe("Client.fileContent", () => {
  it("returns the JSONL whole, as text", async () => {
    const body = '{"custom_id":"a"}\n{"custom_id":"b"}\n';
    const seen: string[] = [];
    const client = clientWithFetch(async (url) => {
      seen.push(url);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/jsonl" },
      });
    });
    expect(await client.fileContent("file-abc")).toBe(body);
    expect(seen[0]).toBe("http://node/v1/files/file-abc/content");
  });

  it("percent-encodes the id", async () => {
    const seen: string[] = [];
    const client = clientWithFetch(async (url) => {
      seen.push(url);
      return new Response("", { status: 200 });
    });
    await client.fileContent("a/b?c");
    expect(seen[0]).toBe("http://node/v1/files/a%2Fb%3Fc/content");
  });
});

describe("what bounds an upload", () => {
  it("gives every request a deadline that covers the largest upload", () => {
    // `AbortSignal` bounds the whole exchange, body included, so one number has
    // to cover the biggest thing this SDK sends: 200 MiB to the files door,
    // which answers only once the object store has taken it. A budget sized for
    // reading a JSON answer aborts exactly the uploads this path exists to
    // carry, and does it with `retry: false`.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });

  it("holds an upload open past the deadline a JSON read used to get", async () => {
    // The regression this pins: a 30 s deadline on every request meant a 30 s
    // ceiling on the body upload too, so a payload needing longer died
    // mid-flight with no retry. Driven on real timers, because
    // `AbortSignal.timeout` does not honour vitest's fake clock.
    const open = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "TimeoutError")),
        );
      });
    const settled = (p: Promise<unknown>) => p.then(() => "done", () => "aborted");
    const after = (ms: number) => new Promise((r) => setTimeout(() => r("still-open"), ms));

    // A caller that wants to fail fast still can, and that leg doubles as the
    // control: it proves the harness really does abort when a deadline fires.
    const impatient = clientWithFetch(open, { timeoutMs: 50 });
    expect(await Promise.race([settled(impatient.file("file_1")), after(1000)])).toBe("aborted");

    // The default, which every upload relies on, is nowhere near expiring.
    const c = clientWithFetch(open);
    const upload = settled(c.uploadFile("big", "input", new Uint8Array(1024 * 1024)));
    expect(await Promise.race([upload, after(1000)])).toBe("still-open");
  });
});
