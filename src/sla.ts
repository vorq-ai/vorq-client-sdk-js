/**
 * SLA tier-name aliases and window pacing.
 *
 * The SDK accepts tier names (`"async"` / `"batch"`) or raw windows (`"1h"` /
 * `"24h"`) anywhere an SLA is taken, and normalizes to the raw window before
 * sending. Unknown strings pass through verbatim so a network-added window
 * needs no SDK update.
 */

const TIER_ALIASES: Readonly<Record<string, string>> = { async: "1h", batch: "24h" };
const UNIT_SECONDS: Readonly<Record<string, number>> = { h: 3600, m: 60, s: 1 };

/**
 * The grammar, strictly: digits then one unit letter.
 *
 * Python reaches the same answer through `int(window[:-1])`, which additionally
 * accepts a leading sign, underscores and surrounding whitespace — and returns
 * a **negative** duration for `"-1h"`. All such spellings are junk no caller
 * writes; here they fall back to one hour rather than parsing, which is the
 * safer direction.
 */
const WINDOW_RE = /^(\d+)([hms])$/;

/** Resolve a tier alias to its raw window; pass everything else through. */
export function normalizeSla(value: string): string {
  // `Object.hasOwn`, not a bare index: an index reads through the prototype, so
  // `normalizeSla("toString")` would hand back a Function typed as a string.
  return Object.hasOwn(TIER_ALIASES, value) ? TIER_ALIASES[value]! : value;
}

/**
 * Duration of an SLA window in seconds. Accepts a raw window or a tier alias;
 * unparseable strings fall back to one hour.
 */
export function slaSeconds(window: string): number {
  const match = WINDOW_RE.exec(normalizeSla(window));
  if (match === null) return 3600;
  return Number(match[1]) * UNIT_SECONDS[match[2]!]!;
}

/**
 * The longest this SDK will wait between two reads of one job.
 *
 * Sixty seconds, which is exactly what the `"1h"` window has always polled at
 * (`3600 / 60`). The cap introduces no pacing — it stops a **longer** window
 * from being polled **more slowly** than the fast one, which is what an
 * unbounded `slaSeconds / 60` actually did: a `"24h"` job slept 1440 s, so a
 * job settling one second after a read was reported settled twenty-four minutes
 * later, and the last sleep could consume the remaining budget and raise a
 * timeout on a job that had finished well inside its window.
 */
export const MAX_POLL_INTERVAL_SECONDS = 60;

/** SLA-paced poll interval, held in `[2, MAX_POLL_INTERVAL_SECONDS]` seconds. */
export function pollInterval(window: string): number {
  return Math.min(Math.max(slaSeconds(window) / 60, 2), MAX_POLL_INTERVAL_SECONDS);
}

/** The two windows the tiers name, so a round trip comes back spelled as asked. */
const SECONDS_WINDOW: Readonly<Record<number, string>> = { 3600: "1h", 86400: "24h" };

/**
 * The window a job's `vorq.sla_secs` names, or `null` if unusable.
 *
 * **The job row carries seconds, not a window** — there is no `sla` string
 * anywhere on it. Reading a key the node does not send leaves the pacing
 * unknown, and an unknown pacing defaults to one hour: a re-attached `24h` job
 * would then be polled once a minute and given a one-hour timeout, so `result()`
 * would raise on a job that is running normally.
 */
export function windowFromSeconds(seconds: unknown): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (typeof seconds === "object") return null;
  const parsed = Number(String(seconds));
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  // `Object.hasOwn`, never a bare index — the same rule `normalizeSla` applies
  // to `TIER_ALIASES` two functions up, and for the same reason: the table is
  // this package's own, but the **key** comes from the coordinator's
  // `vorq.sla_secs` and is any positive integer. Read bare,
  // `windowFromSeconds(12345)` returned whatever `Object.prototype[12345]`
  // held; a polluted `"1s"` gives `result()` a one-second timeout and raises
  // `WaitTimeout` on every job running normally on a non-standard window.
  return Object.hasOwn(SECONDS_WINDOW, parsed) ? SECONDS_WINDOW[parsed]! : `${parsed}s`;
}

/**
 * The seconds of a window the ask book prices — a tier name (`"async"`,
 * `"batch"`) or its raw window (`"1h"`, `"24h"`) — or `null` for anything
 * else. No one-hour fallback here, unlike `slaSeconds`: this feeds a floors
 * filter, and a typo priced as the 1 h window is the wrong order signed.
 */
export function knownWindowSeconds(value: string): number | null {
  const window = normalizeSla(value);
  for (const [seconds, name] of Object.entries(SECONDS_WINDOW)) {
    if (name === window) return Number(seconds);
  }
  return null;
}
