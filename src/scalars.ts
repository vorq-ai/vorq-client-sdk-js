/**
 * Reading an untrusted numeric scalar off the wire.
 *
 * One file, imported by everything that needs it and importing nothing back, so
 * there is exactly one answer to "is this a number this SDK will treat as
 * money". `units.ts` exists for the mirror-image reason on the outbound side —
 * two copies of the canonicalizer would produce two different job ids for one
 * input — and two copies of *money validation* in a payment SDK is the same
 * hazard pointing the other way: they drift, and then a gas fee one path accepts
 * the other refuses, on the same quote, in the same submission.
 *
 * It is a separate module from `units.ts` rather than an addition to it because
 * the two have opposite trust postures, and `units.ts` says so in its own first
 * line: it is *"the encoding that feeds the commitment preimage, and the
 * accounting scalars an order declares"* — values this client computes and then
 * signs. This is the inbound half: values a **node** chose, which are believed
 * only after they survive a check. Filing a wire parser under a module about the
 * commitment preimage would make that module's stated character untrue, and a
 * comment that no longer describes its file is the defect this extraction exists
 * to remove rather than relocate.
 */

/**
 * A wire scalar as a `bigint`, or `null` if it is not one exactly.
 *
 * Every integer on the wire is a JSON number no larger than `MAX_SAFE_INTEGER`;
 * money is not one of them (it travels as a USD decimal string, `money.ts`).
 * Anything else — a float, a hex string, an object — answers `null`, for the
 * caller to shape into its own refusal, rather than escaping as a `SyntaxError`
 * or a `RangeError` thrown out of `BigInt` from the middle of whatever was in
 * progress.
 *
 * **`Number.isSafeInteger`, not `Number.isInteger`.** `BigInt(1e30)` is
 * `1000000000000000019884624838656n` — an integer, a plausible one, and the
 * wrong one. A number past `MAX_SAFE_INTEGER` has already lost digits by the
 * time this function sees it, so it is refused here the way the string branch
 * refuses anything that is not decimal digits. A figure never silently
 * acquires digits it was not sent.
 */
export function asBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}
