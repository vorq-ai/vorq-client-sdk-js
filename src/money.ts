/**
 * The one conversion between the USD decimal strings the coordinator API speaks
 * and the atomic token integers the chain signs and settles.
 *
 * Defined by `vectors/money-v1.json`: ASCII digits, no sign, exponent,
 * whitespace, grouping or leading zeros, a fraction with digits on both sides of
 * the point and at most `decimals` of them — more is refused, never rounded.
 * `atomic = usd × 10^decimals`; formatting strips trailing fractional zeros.
 *
 * A rate is USD per 1M units of work. `RATE_SCALE` is 10^6 units, so the same
 * shift gives the on-chain rate: `"0.05"` at 6 decimals is `50000`.
 */

import { ValidationError } from "./errors.js";

const USD = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Whether `value` is a USD decimal string by the grammar alone. */
export function isUsd(value: unknown): value is string {
  return typeof value === "string" && USD.test(value);
}

function checkDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new ValidationError(`decimals must be a non-negative integer, got ${decimals}`, {
      type: "invalid_request_error",
    });
  }
}

/** A USD decimal string as atomic token units at `decimals`. */
export function parseUsd(text: string, decimals: number): bigint {
  checkDecimals(decimals);
  const match = typeof text === "string" ? USD.exec(text) : null;
  if (match === null) {
    throw new ValidationError(
      `${JSON.stringify(text)} is not a USD amount: a decimal string such as "0.05"`,
      { type: "invalid_request_error" },
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new ValidationError(
      `${JSON.stringify(text)} has ${fraction.length} fraction digits; the payment token ` +
        `carries ${decimals}`,
      { type: "invalid_request_error" },
    );
  }
  return BigInt(`${match[1]}${fraction.padEnd(decimals, "0")}`);
}

/** Atomic token units at `decimals` as a canonical USD decimal string. */
export function formatUsd(atomic: bigint, decimals: number): string {
  checkDecimals(decimals);
  if (atomic < 0n) {
    throw new ValidationError(`a USD amount is never negative, got ${atomic}`, {
      type: "invalid_request_error",
    });
  }
  const digits = atomic.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
