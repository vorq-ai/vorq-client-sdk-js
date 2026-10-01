/**
 * The two clocks, in one place.
 *
 * They answer two different questions and are not interchangeable. A cache TTL
 * is an elapsed-time question and must not move when the system clock is
 * stepped, so it reads the monotonic one. An `issued_at` is a wall-clock
 * instant a node stamped, so comparing against it needs a wall clock — a
 * monotonic reading is a count of seconds since an arbitrary origin and would
 * refuse every announcement ever made.
 *
 * One file with zero imports, for the same reason `scalars.ts` is one: a second
 * definition of "now" is a second answer to "has this expired", and the two
 * drift. Both are in **seconds**, matching Python's `time.monotonic()` and
 * `time.time()`, so a ported bound (600, 60) is the same number here.
 */

/**
 * Seconds since an arbitrary origin. Never steps backwards on a clock change.
 *
 * **Deliberate divergence from Python**, which reads the event loop's clock and
 * so is already monotonic. `Date.now()` is not: an NTP correction or a manual
 * change mid-poll would shorten or extend a window the caller asked for in
 * elapsed seconds, and `result()` would time out early on a job that was
 * running normally.
 *
 * Exported from one module so `JobHandle`, `BatchHandle` and the verifier's
 * allowlist cache poll the **same** clock rather than each keeping a copy of
 * this reasoning. Two clocks that differ is a bug nobody finds: a copy that
 * reached for `Date.now()` would time out a healthy batch the moment NTP
 * corrected the host.
 */
export const monotonicNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now() / 1000
    : () => Date.now() / 1000;

/** Unix seconds. Steps when the system clock does — which is the point. */
export const wallNow = (): number => Date.now() / 1000;
