import { describe, expect, it } from "vitest";
import { checkInput } from "../src/params.js";
import { ValidationError } from "../src/errors.js";

const SCHEMA = {
  type: "object",
  properties: {
    input: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    max_tokens: { type: "integer", minimum: 1, maximum: 8192 },
    n: false, stream: false, stream_options: false,
  },
  additionalProperties: true,
};

describe("checkInput", () => {
  it("passes a valid input with no warnings", () => {
    expect(checkInput(SCHEMA, { input: "hi", temperature: 0.7 })).toEqual([]);
  });

  it("refuses a key the network forbids", () => {
    expect(() => checkInput(SCHEMA, { input: "hi", stream: true }))
      .toThrow(/stream/);
  });

  it("refuses a type violation", () => {
    expect(() => checkInput(SCHEMA, { input: "hi", temperature: "hot" }))
      .toThrow(ValidationError);
  });

  it("refuses a value outside its bounds", () => {
    expect(() => checkInput(SCHEMA, { max_tokens: 0 })).toThrow(ValidationError);
    expect(() => checkInput(SCHEMA, { temperature: 2.5 })).toThrow(ValidationError);
  });

  it("warns on an unknown key but passes it through", () => {
    // The serving provider strips what it does not serve, so an unknown key is
    // advisory here and never a refusal.
    expect(checkInput(SCHEMA, { input: "hi", reasoning_effort: "high" }))
      .toEqual([expect.stringContaining("reasoning_effort")]);
  });

  // R3: the cross-field check needs no schema, so it runs without one. Python
  // returns early here, which is filed as a defect.
  describe("budget fits cap — with or without a schema", () => {
    it.each([[SCHEMA], [null], [undefined]])("refuses a reasoning budget that fills the cap (schema=%s)", (schema) => {
      expect(() => checkInput(schema, { max_tokens: 1000, reasoning_max_tokens: 1000 }))
        .toThrow(/reasoning_max_tokens/);
    });

    it("refuses min_tokens above the cap", () => {
      expect(() => checkInput(null, { max_tokens: 100, min_tokens: 101 }))
        .toThrow(/min_tokens/);
    });

    it("takes the smallest cap when several spellings are present", () => {
      expect(() => checkInput(null, { max_tokens: 900, max_output_tokens: 100, reasoning_max_tokens: 500 }))
        .toThrow(/100/);
    });

    it("is silent when no cap is declared", () => {
      expect(checkInput(null, { reasoning_max_tokens: 999_999 })).toEqual([]);
    });
  });

  // R4: the validator must say what it could not evaluate.
  it("names a keyword it does not implement instead of passing silently", () => {
    const warnings = checkInput(
      { type: "object", properties: { x: { type: "string", pattern: "^a+$" } } },
      { x: "bbb" },
    );
    expect(warnings).toEqual([expect.stringContaining("pattern")]);
  });

  describe("nested properties (inside oneOf/items)", () => {
    // `properties` is in KNOWN_KEYWORDS, so it must actually be evaluated below
    // the top level, not just accepted without a warning while doing nothing.
    const NESTED_SCHEMA = {
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { enum: ["user", "assistant"] },
              content: { type: "string" },
            },
          },
        },
      },
    };

    it("refuses a nested field that violates its own rule", () => {
      expect(() =>
        checkInput(NESTED_SCHEMA, { messages: [{ role: "hacker", content: 12345 }] }),
      ).toThrow(ValidationError);
    });

    it("accepts a nested field that satisfies its rule, with no warnings", () => {
      expect(
        checkInput(NESTED_SCHEMA, { messages: [{ role: "user", content: "hi" }] }),
      ).toEqual([]);
    });
  });

  it("deduplicates a warning scanned on more than one oneOf branch", () => {
    // Every oneOf branch tried, including ones that fail, is scanned for
    // unevaluated keywords — so a value that fails an early branch on `type`
    // but shares an unevaluated keyword with the branch that matches produces
    // the same warning twice unless deduplicated.
    const warnings = checkInput(
      {
        properties: {
          x: { oneOf: [{ type: "number", pattern: "x" }, { type: "string", pattern: "x" }] },
        },
      },
      { x: "hi" },
    );
    expect(warnings).toEqual([expect.stringContaining("pattern")]);
  });
});
