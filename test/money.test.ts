/**
 * `money.ts` against `test/vectors/money-v1.json`, the shared table every repo
 * converts USD strings and atomic integers by.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors.js";
import { formatUsd, isUsd, parseUsd } from "../src/money.js";

interface Row {
  decimals: number;
  usd: string;
  atomic?: string;
  formats_as?: string;
  why?: string;
}

const table = JSON.parse(
  readFileSync(join(resolve(import.meta.dirname, ".."), "test", "vectors", "money-v1.json"), "utf8"),
) as { format: string; canonical: Row[]; parse_only: Row[]; refused: Row[] };

describe("money-v1", () => {
  it("is the revision this build reads", () => {
    expect(table.format).toBe("vorq-money-v1");
  });

  it.each(table.canonical)("canonical $usd at $decimals", (row) => {
    expect(parseUsd(row.usd, row.decimals)).toBe(BigInt(row.atomic!));
    expect(formatUsd(BigInt(row.atomic!), row.decimals)).toBe(row.usd);
  });

  it.each(table.parse_only)("parse-only $usd at $decimals", (row) => {
    expect(parseUsd(row.usd, row.decimals)).toBe(BigInt(row.atomic!));
    expect(formatUsd(BigInt(row.atomic!), row.decimals)).toBe(row.formats_as);
  });

  it.each(table.refused)("refuses $usd at $decimals ($why)", (row) => {
    expect(() => parseUsd(row.usd, row.decimals)).toThrow(ValidationError);
  });

  it("refuses a value that is not a string", () => {
    expect(() => parseUsd(5 as unknown as string, 6)).toThrow(ValidationError);
    expect(isUsd(5)).toBe(false);
    expect(isUsd("0.05")).toBe(true);
  });

  it("refuses a negative atomic amount", () => {
    expect(() => formatUsd(-1n, 6)).toThrow(ValidationError);
  });
});
