/**
 * The HTTP transport: one `fetch` wrapper carrying the whole retry policy.
 *
 * Session behaviour arrives as injected hooks rather than as a `Client`
 * reference, so the policy is testable on its own and the handshake — which must
 * not recurse back through this method — stays the `Client`'s.
 */

import { TransportError, errorFromWire, type VorqError } from "./errors.js";
import { own } from "./own.js";

export interface TransportHooks {
  /** Mint or rotate the session before a request. Called on every request. */
  ensureSession?(): Promise<void>;
  /** The current bearer token, or null. */
  token?(): string | null;
  /**
   * Called at most once per request, on a 401. Resolve `true` if the request
   * should be retried, `false` to let the 401 stand.
   *
   * `staleToken` is the credential *this* request actually sent, which is not
   * always the one the client currently holds: a concurrent request's 401 may
   * already have rotated the session while this one was in flight. Handing it
   * over is what lets the client answer "yours was stale, mine is fresh, go
   * again" instead of burning a second one-shot nonce to mint a token
   * equivalent to the one it already has.
   */
  reauthorize?(staleToken: string | null): Promise<boolean>;
}

export interface TransportConfig {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  timeoutMs?: number;
  hooks?: TransportHooks;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RequestOptions {
  json?: unknown;
  params?: Record<string, string | number | bigint | undefined>;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Opt out so a call that may have had an effect is never repeated. */
  retry?: boolean;
  /** Statuses handed back as data rather than thrown — the 402 challenge. */
  allowStatuses?: readonly number[];
}

/**
 * The one deadline every request gets, in milliseconds.
 *
 * `AbortSignal` bounds the whole exchange — connecting, sending the body and
 * reading the answer — so there is a single number here rather than a leg per
 * phase, and it has to cover the largest thing this SDK sends: an upload to the
 * files door, which stores up to 200 MiB and answers only once the object store
 * has taken the body. At a poor uplink that is minutes.
 *
 * Sizing it per payload meant threading a deadline through every request for the
 * sake of one call site. The cost of one generous static number is that a
 * coordinator which accepts a connection and then stops answering is noticed
 * late; callers that want to fail sooner pass their own `timeoutMs`.
 */
export const DEFAULT_TIMEOUT_MS = 900_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `fetch` rejection as something a caller can catch and read.
 *
 * The two cases are told apart in the message because the remedies differ: a
 * timeout at the SDK's own bound is a `timeoutMs` the caller chose and can
 * raise, while a connection that could not be made is a coordinator that is not
 * there. `AbortSignal.timeout` rejects with a `TimeoutError`; a caller's own
 * abort would arrive as an `AbortError`, and is reported as itself rather than
 * as this SDK's timeout.
 */
function transportFailure(
  error: unknown,
  method: string,
  url: string,
  timeoutMs: number,
): TransportError {
  const name = (error as { name?: unknown } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError") {
    return new TransportError(
      `${method} ${url} timed out after ${timeoutMs} ms without a response`,
      { cause: error },
    );
  }
  if (name === "AbortError") {
    return new TransportError(`${method} ${url} was aborted before it answered`, {
      cause: error,
    });
  }
  return new TransportError(`${method} ${url} could not be reached: ${detail}`, {
    cause: error,
  });
}

export class Transport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly hooks: TransportHooks;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(config: TransportConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // Bound to `globalThis`: an unbound `fetch` reference throws "Illegal
    // invocation" in a browser.
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.hooks = config.hooks ?? {};
    this.sleep = config.sleep ?? defaultSleep;
    this.random = config.random ?? Math.random;
  }

  /** `0.5 · 2^attempt + uniform(0, 0.25)` seconds, in milliseconds. */
  private backoffMs(attempt: number): number {
    return (0.5 * 2 ** attempt + this.random() * 0.25) * 1000;
  }

  private url(path: string, params: RequestOptions["params"]): string {
    let url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (params !== undefined) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.append(key, String(value));
      }
      const query = search.toString();
      if (query !== "") url += `?${query}`;
    }
    return url;
  }

  private async errorFor(response: Response): Promise<VorqError> {
    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      // A gateway's HTML, an empty body, a truncated stream: the status is still
      // the answer, and failing while building an error would replace a
      // diagnosable failure with an opaque one.
    }
    return errorFromWire(response.status, body, {
      requestId: response.headers.get("x-request-id"),
    });
  }

  /**
   * Issue a request under the narrow retry policy.
   *
   * Retries only when the response carries `x-vorq-retryable: true` **and** the
   * call opted in. A `401` re-mints the session once — even for a call that
   * opted out, since nothing was created. In a browser that retryable header is
   * readable only if the coordinator's CORS exposes it; retries that fire in
   * Node and never in a browser are that, and nothing else.
   */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    // **Own properties only on the caller's options record** — the package rule
    // (`own.ts`), and `request` is public API, so this record arrives from a
    // caller. A destructuring default fires only on `undefined`, and an
    // inherited property is not undefined, so `{ retry = true }` reads a
    // polluted `Object.prototype.retry` as the caller's own. The `body`/`json`
    // pair is the one that matters most: read bare, a polluted prototype puts
    // bytes nobody wrote on the wire, signed with this session's token — and it
    // does so on requests whose caller passed no body at all.
    //
    // One guard for all six reads, so there is one thing to keep true.
    const stated = <K extends keyof RequestOptions>(key: K): RequestOptions[K] =>
      own(options as Record<string, unknown>, key) as RequestOptions[K];
    const retry = stated("retry") ?? true;
    const allowStatuses = stated("allowStatuses") ?? [];
    await this.hooks.ensureSession?.();

    let reauthed = false;
    let attempt = 0;
    for (;;) {
      const headers = new Headers(stated("headers"));
      const token = this.hooks.token?.();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      let body = stated("body");
      const json = stated("json");
      if (json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(json);
      }

      const url = this.url(path, stated("params"));
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // Deliberately outside the retry loop: `throw`, never `continue`. The
        // policy retries what the coordinator marks retryable and nothing else,
        // and a transport failure carries no such marking — a POST that died on
        // the wire may well have been received. Callers that can reconcile opt
        // in per site.
        throw transportFailure(error, method, url, this.timeoutMs);
      }

      // The response is returned unread: a caller's `.json()` needs the body
      // intact. Only a response about to be discarded is ever consumed here.
      if (response.ok || allowStatuses.includes(response.status)) return response;

      if (response.status === 401 && !reauthed && this.hooks.reauthorize !== undefined) {
        reauthed = true;
        if (await this.hooks.reauthorize(token ?? null)) {
          // Nothing will read this body, and under undici an unread one holds
          // its connection until the socket is garbage-collected.
          void response.body?.cancel();
          continue;
        }
      }

      const retryable = response.headers.get("x-vorq-retryable") === "true";
      if (retry && retryable && attempt < this.maxRetries) {
        void response.body?.cancel();
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }
      throw await this.errorFor(response);
    }
  }

  /** `request` plus `.json()` — the shape every read actually wants. */
  async json<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(method, path, options);
    return (await response.json()) as T;
  }
}
