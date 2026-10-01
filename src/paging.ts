/**
 * Offset paging for the coordinator's budgeted listings, and the stop condition
 * that goes with it.
 *
 * **This is not the batch pager.** `GET /v1/batches` is OpenAI cursor paging —
 * `limit` + `after`, answering `has_more` / `first_id` / `last_id` — and emits
 * neither header read here. The listings this serves are the ones the
 * coordinator pages through its byte budget: `/evm/providers`, `/evm/jobs`,
 * `/evm/asks`, `/evm/allowlist` and `/v1/models`. One helper for both contracts
 * would be silently wrong for whichever it was not written for, so the cursor
 * contract gets its own.
 *
 * **The stop condition has two halves and both are required.** Keep paging
 * while `returned === limit` **or** the page was truncated. The truncation
 * header means "the byte budget cut this page", not "there is more data" — a
 * 150-row table answers a default 100-row page with `truncated: false`, and a
 * client that stops on the flag alone silently reads 100 of 150. The mirror
 * error is just as bad: a client that stops on a short page alone silently
 * drops everything behind a page the budget cut at 12 rows. Neither failure
 * looks like a bug from outside — the response is a well-formed list that is
 * quietly incomplete.
 *
 * Both headers are CORS-exposed by the coordinator, so this works in a browser.
 * If a deployment ever stops exposing them a browser reads `null` for both,
 * `truncated` is `false`, and paging degrades to the `returned === limit` half
 * — short, not wrong-in-a-loop.
 */

import { VorqError } from "./errors.js";
import { own } from "./own.js";

export const PAGE_TRUNCATED_HEADER = "x-vorq-page-truncated";
export const PAGE_NEXT_OFFSET_HEADER = "x-vorq-next-offset";

/**
 * The coordinator's own default `limit`, mirrored because the second half of
 * the stop condition cannot be evaluated without it.
 *
 * A caller that sends no `limit` is answered a page of this size, and
 * `returned === limit` is the only thing that distinguishes "the page is full,
 * ask again" from "that was the last of them". There is no header carrying the
 * effective limit back, so the value is mirrored rather than inferred.
 *
 * **If you are here to change this number, read on — the failure it causes is
 * silent.** This is one half of a cross-repo pin that nothing enforces. Lower
 * it below what the coordinator actually applies and every listing ends at the
 * first page that returns more rows than this claims a page holds: the client
 * reads `returned !== limit`, calls the page short, and reports a complete
 * listing that is missing everything behind it. No request fails, no assertion
 * trips, and the answer is a well-formed list. Raise it above the coordinator's
 * value and a full page reads as short in the same way. The number is only
 * correct while it equals the coordinator's `PAGE_DEFAULT_LIMIT`.
 *
 * The way out of the pin, where a call site controls its own requests, is to
 * **send** an explicit `limit` and compare against the value sent rather than
 * against this constant — which is what {@link walkListing}'s callers do, and
 * why a walk is immune to this drift even though a single-page read is not.
 */
export const PAGE_DEFAULT_LIMIT = 100;

/**
 * How far a walk can get before the coordinator refuses to page further.
 *
 * `offset` is capped at a million rows, because `OFFSET n` costs O(n) inside
 * the database however good the index is — so an unbounded `offset` is the same
 * unbounded work the row and byte bounds exist to prevent, one layer down. Past
 * that the answer is to narrow the query (`/evm/jobs` takes `state`, `model`,
 * `provider`, `owner`, `min_rate_in`, `min_rate_out` and `posted_before`), not
 * to page further into it.
 *
 * **A walk therefore has a hard end, and it arrives as an error rather than as
 * a stop.** The request past the cap is a `400` and surfaces as a `VorqError`,
 * not as a `nextOffset` of `null`. That is the right direction — a listing this
 * client could not finish reading must not be mistaken for one it finished —
 * but it means a caller walking a very large listing has to be ready to catch
 * one, and that the rows already collected are worth keeping.
 *
 * Mirrored for documentation only: nothing here branches on it, so unlike
 * {@link PAGE_DEFAULT_LIMIT} a drift in this number costs a caller a surprise
 * and never a silently short listing.
 */
export const PAGE_MAX_OFFSET = 1_000_000;

export interface PageResult<T> {
  items: T[];
  /** The byte budget cut this page short. Not the same as "there is more". */
  truncated: boolean;
  /** Where the *truncation* says to resume; `null` when the page was not cut. */
  nextOffset: number | null;
}

/**
 * The row array out of a listing body, or a refusal naming what arrived.
 *
 * **An empty page is a meaningful answer, which is exactly why one must not be
 * manufactured here.** "No asks on this network" and "the SDK could not find
 * the asks in this response" are different facts, and a caller acts on the
 * first — stops bidding, reports an empty book, waits. Handing back `[]` for a
 * body this client could not read gives them the second dressed as the first:
 * a well-formed, quietly wrong, *complete-looking* listing, which is the one
 * failure this module exists to prevent.
 *
 * The response shapes on these routes are frozen and asserted exactly by the
 * coordinator's own suite, so a missing or non-array key is a protocol
 * violation rather than a variation to absorb. It is refused the way a
 * malformed session response is refused in `client.ts` — a named
 * `invalid_response` that says which route and what arrived — rather than as
 * the bare `TypeError` a `.map()` over a non-array would have produced.
 */
export function pageRows(body: unknown, key: string, path: string): unknown[] {
  // Own properties only (`own.ts`): a bare dynamic index on a `JSON.parse`
  // body lets a polluted `Object.prototype.asks` (or `jobs`, or `entries`)
  // stand in as the coordinator's rows, so a listing is answered by the
  // prototype and this refusal never fires.
  const rows =
    body === null || typeof body !== "object"
      ? undefined
      : own(body as Record<string, unknown>, key);
  if (Array.isArray(rows)) return rows;
  throw new VorqError(
    `${path} answered a body whose \`${key}\` is ${
      rows === undefined ? "absent" : `a ${typeof rows}`
    } rather than an array of rows. Reading that as an empty listing would report ` +
      "a complete result for a response this client could not parse",
    { type: "invalid_response" },
  );
}

/**
 * Read a budgeted listing to **exhaustion**, honouring both halves of the rule.
 *
 * `readOne` is handed the offset to fetch and answers the response together
 * with its decoded rows; the walk supplies every offset after the first and
 * stops when {@link pageAgain} says the listing is done.
 *
 * **`limit` must be the limit the requests actually carry.** A walk controls
 * its own requests, so it should send an explicit `limit` and pass the same
 * value here — which is what makes a walk immune to the cross-repo drift
 * described on {@link PAGE_DEFAULT_LIMIT}, since the number compared against is
 * the number sent.
 *
 * **The loop terminates by construction, so it carries no attempt bound.**
 * Every iteration strictly increases `offset`: `pageAgain` stops on an empty
 * page before either branch can answer, the full-page branch adds `limit ≥ 1`,
 * and the truncated branch answers a cursor `readPage` has already refused
 * unless it exceeds the offset it was read at. A page bound would be the one
 * thing that could reintroduce a silently short listing — a walk that gave up
 * at N pages and returned what it had would look exactly like a complete one —
 * so the only end besides exhaustion is the coordinator's own offset ceiling,
 * which arrives as an error (see {@link PAGE_MAX_OFFSET}).
 */
export async function walkListing<T>(
  readOne: (offset: number) => Promise<{ response: Response; rows: T[] }>,
  limit: number,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { response, rows } = await readOne(offset);
    const page = readPage(response, rows, offset);
    // A loop rather than `push(...items)`: spreading a large page is an
    // argument list, and an argument list has a length limit a row count does
    // not.
    for (const item of page.items) all.push(item);
    const next = pageAgain(page, offset, limit);
    if (next === null) return all;
    offset = next;
  }
}

/**
 * Pair a decoded page's rows with the two signals its response carried.
 *
 * `offset` and the row count are taken as well as the header, because a
 * truncated page whose cursor header did not survive the trip is still
 * resumable: `offset + returned` is what the coordinator itself puts in the
 * header, so deriving it loses nothing and reading half a paging contract loses
 * rows.
 *
 * **A cursor is believed only if it advances.** The header is parsed the way
 * the coordinator parses its own paging parameters — decimal digits, a safe
 * integer — and then checked against `offset`: a cursor at or behind the offset
 * this page was fetched at would send the next request to rows already read,
 * and a caller looping on it would never terminate. An unreadable or
 * non-advancing cursor falls back to the derived `offset + returned`, which
 * advances by construction.
 */
export function readPage<T>(response: Response, items: T[], offset: number): PageResult<T> {
  const truncated = response.headers.get(PAGE_TRUNCATED_HEADER) === "true";
  if (!truncated) return { items, truncated: false, nextOffset: null };
  const raw = response.headers.get(PAGE_NEXT_OFFSET_HEADER);
  const parsed = raw !== null && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const usable = Number.isSafeInteger(parsed) && parsed > offset;
  return { items, truncated: true, nextOffset: usable ? parsed : offset + items.length };
}

/**
 * The **absolute** offset to ask for next, or `null` when the listing is
 * exhausted. `offset` is the one the page just read was fetched at, and `limit`
 * the one it was asked for.
 *
 * Absolute in both branches on purpose. The truncation header carries an
 * absolute offset and a full page carries none, so a helper that answered a
 * count for one and a cursor for the other would put the conversion on every
 * call site — and a call site that got it wrong would re-read the same page
 * forever or skip a hundred rows, neither of which looks like a bug from
 * outside.
 *
 * An empty page always stops, whatever it claimed: resuming at an offset that
 * returned nothing is a loop, and a listing that truncates to zero rows is a
 * coordinator problem rather than something to spin on.
 */
export function pageAgain(page: PageResult<unknown>, offset: number, limit: number): number | null {
  if (page.items.length === 0) return null;
  if (page.truncated) return page.nextOffset;
  return page.items.length === limit ? offset + page.items.length : null;
}
