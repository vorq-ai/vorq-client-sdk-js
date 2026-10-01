/**
 * The two file paths: the content-addressed read a settled job's result arrives
 * on, and the multipart body a batch input file is uploaded with.
 */

import { VorqError } from "./errors.js";
import { own } from "./own.js";

/** The media type the upload door is handed, and the one it serves back. */
export const JSONL_MEDIA_TYPE = "application/jsonl";

/**
 * The multipart body `POST /v1/files` takes, built the same way in both runtimes.
 *
 * `FormData`, `Blob` and `File` are platform globals in Node ≥22 and in every
 * browser this package targets, so there is one implementation rather than a
 * branch — which is the point: a Node path and a browser path that are written
 * separately drift, and the failure surfaces as a node refusing one runtime's
 * uploads for a reason neither runtime can see.
 *
 * **The caller must not set `content-type`.** `fetch` sets it from the
 * `FormData`, boundary and all; a hand-set header carries no boundary and the
 * parser on the other side rejects the body.
 */
export function buildUpload(
  filename: string,
  purpose: string,
  content: Uint8Array | string,
  contentType: string = JSONL_MEDIA_TYPE,
): FormData {
  const form = new FormData();
  // The bytes are handed over as they are — one `File`, no intermediate string.
  // A `Uint8Array` re-encoded through a string would corrupt any line that is
  // not valid UTF-8, and a batch line carries base64 ciphertext: exactly the
  // kind of thing that survives one round trip and not two.
  //
  // The cast is the one `SharedArrayBuffer` gap in the DOM types: `BlobPart`
  // takes an `ArrayBufferView<ArrayBuffer>` and a plain `Uint8Array` is typed
  // over `ArrayBufferLike`, which the checker will not narrow. Every runtime
  // this ships to accepts either.
  //
  // `purpose` first, the file last: the door reads its fields ahead of the file
  // part and refuses before the bytes when it can.
  form.append("purpose", purpose);
  form.append("file", new File([content as BlobPart], filename, { type: contentType }));
  return form;
}

export const DEFAULT_GATEWAY = "https://ipfs.filebase.io";

/**
 * How many times a miss is re-read before it is believed. These bytes were
 * pinned seconds ago and a fresh name is not instantly resolvable on a read
 * gateway, so the first `404` is propagation far more often than absence.
 */
export const GATEWAY_ATTEMPTS = 8;
export const GATEWAY_BACKOFF_MS = 1500;

/**
 * Explicit argument > environment > built-in default.
 *
 * An empty string at either level disables the gateway rather than falling
 * through — "I will supply my own" must be sayable, not just the accident of
 * nothing being set. It leaves the client with no read path at all, and
 * `fetchBlob` says so rather than reaching for the coordinator, which has no
 * blob door to reach for.
 *
 * The environment is reached through `globalThis` rather than a bare
 * `process` reference — this module ships in a browser bundle too, and a bare
 * reference is what makes a bundler inject a `process` shim and smuggle a
 * server-side lookup into a page. In a browser this is simply `undefined` and
 * the caller must pass a gateway (or the built-in default applies).
 */
function envValue(name: string): string | undefined {
  // **An environment is a record, and every hop to it is read own-properties
  // only** (`own.ts`). This was missed by a sweep that drew its scope at
  // records off `JSON.parse` and never asked whether an environment is one: an
  // **unset** variable is answered by `Object.prototype`, so with the variable
  // unset — the ordinary case — a polluted prototype supplies the value this
  // function returns, on the default construction path, with no other
  // precondition.
  //
  // The `globalThis` hop is guarded for the same reason one layer up: a browser
  // realm has no own `process`, so a bare read there would let a polluted
  // prototype **manufacture an environment** where the paragraph above promises
  // there is none. Guarded, the browser answer is `undefined`, which is exactly
  // what that paragraph says it should be.
  const proc = Object.hasOwn(globalThis, "process")
    ? (globalThis as { process?: unknown }).process
    : undefined;
  if (typeof proc !== "object" || proc === null) return undefined;
  const env = own(proc as Record<string, unknown>, "env");
  if (typeof env !== "object" || env === null) return undefined;
  const value = own(env as Record<string, unknown>, name);
  return typeof value === "string" ? value : undefined;
}

export function resolveGateway(gateway: string | undefined): string | null {
  let value = gateway;
  if (value === undefined) {
    // The gateway decides **where every result blob is fetched from**. With
    // `$VORQ_PIN_GATEWAY` unset and no `gateway` option — the default client —
    // a bare read hands a polluted prototype the host for every `fetchBlob`,
    // and the honest CID is then requested from it. Nothing recomputes the
    // name (`openResultBytes` says so outright) and `decryptOutput` returns
    // cleartext JSON unchanged, so the bytes that come back are returned as
    // the job's result. That is the identical consequence as a polluted
    // `result_cid` in `jobs.ts` and `batches.ts`, reached through the host
    // instead of the name.
    const fromEnv = envValue("VORQ_PIN_GATEWAY");
    value = fromEnv !== undefined ? fromEnv : DEFAULT_GATEWAY;
  }
  return value.replace(/\/+$/, "") || null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch content-addressed bytes by CID.
 *
 * The read needs no authorization: the CID *is* the authorization. Knowing the
 * name is the whole entitlement to the bytes, and a name nobody handed you is
 * not one you can guess.
 *
 * Three ways out and every one of them is a `VorqError`: the bytes, a status
 * the gateway answered with, or a connection that never answered at all. The
 * last one is wrapped rather than left as `fetch`'s own rejection, because a
 * caller holding one `catch (e) { if (e instanceof VorqError) }` should not
 * also have to know which HTTP layer read the gateway.
 *
 * A miss is waited out before it is believed — see `GATEWAY_ATTEMPTS`. A
 * status the gateway will keep giving (a scoped gateway refusing the name, a
 * malformed CID) is an answer about *this name*, and no amount of waiting
 * turns it into bytes: only `404` and `5xx` retry, everything else at `>= 400`
 * raises immediately.
 */
export async function fetchBlob(args: {
  cid: string;
  gateway: string | null;
  fetchImpl: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Uint8Array> {
  // `cid`, `gateway` and `fetchImpl` are always own keys of the literal
  // `Client.fetchBlob` builds; `sleep` is not, so its **destructuring default**
  // fires and reads `Object.prototype.sleep` first — a default fires on
  // `undefined`, and an inherited property is not undefined (`own.ts`). It
  // decides only the gateway retry pacing, but a non-function there throws a
  // raw `TypeError` out of the first 404 on every result read.
  const { cid, gateway, fetchImpl } = args;
  const sleep = (own(args as unknown as Record<string, unknown>, "sleep") ??
    defaultSleep) as (ms: number) => Promise<void>;
  if (gateway === null) {
    throw new VorqError(
      `no gateway configured, so there is nowhere to read ${cid} from: the ` +
        "coordinator serves no blob endpoint. Pass gateway=... or set " +
        "$VORQ_PIN_GATEWAY.",
      { type: "invalid_request_error" },
    );
  }
  const url = `${gateway}/ipfs/${encodeURIComponent(cid)}`;

  // A connection failure at either point below — the request itself, or a
  // drop mid-body — is the same kind of "ask again" as a 404: retried until
  // the last attempt, then wrapped so it never leaves as a bare `TypeError`.
  // No `statusCode`: nothing answered (or answered and then stopped), so
  // there is no status to carry. The original failure travels as `cause`,
  // same as `TransportError` in `errors.ts`. The message differs by site: a
  // request that never got a response was never reached; a body that broke
  // mid-transfer *was* reached — telling a caller "could not reach" for that
  // would send them looking at connectivity instead of at the transfer.
  const retryOrWrap = async (cause: unknown, last: boolean, message: string): Promise<void> => {
    if (!last) {
      await sleep(GATEWAY_BACKOFF_MS);
      return;
    }
    const err = new VorqError(message, { type: "api_error" });
    err.cause = cause;
    throw err;
  };

  for (let attempt = 0; attempt < GATEWAY_ATTEMPTS; attempt++) {
    const last = attempt === GATEWAY_ATTEMPTS - 1;
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "follow" });
    } catch (cause) {
      await retryOrWrap(
        cause,
        last,
        `gateway read of ${cid} could not reach ${gateway}: ${String(cause)}`,
      );
      continue;
    }
    if (response.status >= 400) {
      // 404 is "not yet" until the window closes; 5xx is the gateway itself,
      // which is the same kind of "ask again". Every other status is an
      // answer about *this name* — a scoped gateway refusing it, a malformed
      // CID — and no amount of waiting turns it into bytes.
      if (!last && (response.status === 404 || response.status >= 500)) {
        await sleep(GATEWAY_BACKOFF_MS);
        continue;
      }
      throw new VorqError(
        `gateway read of ${cid} failed with HTTP ${response.status}`,
        { type: "api_error", statusCode: response.status },
      );
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      // The gateway answered — the status check above already passed — and
      // the transfer broke afterwards. Not a reachability problem.
      await retryOrWrap(
        cause,
        last,
        `gateway read of ${cid} failed mid-transfer: ${String(cause)}`,
      );
      continue;
    }
  }
  /* c8 ignore next */
  throw new VorqError(`gateway read of ${cid} exhausted its attempts`, { type: "api_error" });
}
