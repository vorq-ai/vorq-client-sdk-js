/**
 * Local validation of a model input against its published `params_schema`.
 *
 * **Nothing serves that schema today.** `GET /v1/models` is the coordinator's
 * projection of the chain's model table, and the capability record a schema
 * would live in is off-chain curation that is not built — so `schema` is `null`
 * for every model and the schema half of this file validates nothing. That is
 * the direction the degrade has to run: a stale or invented schema would refuse
 * a param the serving provider supports, and the caller cannot fix that from
 * their side. **No schema means no validation, never wrong validation.**
 *
 * The authoritative strip is the provider's own allowlist, which drops what the
 * served model does not accept. This file is a fail-fast courtesy: it exists so
 * a caller learns before sealing and paying, not because anything depends on it.
 *
 * **The budget check is different and runs unconditionally.** It is pure
 * cross-field arithmetic on the input, needs no schema, and catches a real
 * money bug the provider's clamp will not: a reasoning budget equal to the whole
 * output cap is a perfectly valid integer that buys an empty answer at full
 * price. (Python returns early with no schema and skips it — filed as a defect.)
 *
 * No JSON Schema library: this implements the subset real schemas use and
 * **names any keyword it did not evaluate**, so the gap is loud rather than
 * silent.
 */

import { ValidationError } from "./errors.js";
import { own } from "./own.js";

/** Keywords this validator evaluates. Anything else is reported, not ignored. */
const KNOWN_KEYWORDS = new Set([
  "type", "minimum", "maximum", "enum", "oneOf", "items", "properties",
  "additionalProperties", "description", "title", "default", "x-vorq-billing",
]);

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function matches(value: unknown, schema: unknown, warnings: string[], path: string): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  if (typeof schema !== "object" || schema === null) return true;
  const s = schema as Record<string, unknown>;
  // **Own properties only on the schema itself** (`own.ts`), not merely on the
  // records it is matched against. A published `params_schema` is `JSON.parse`
  // output off `GET /v1/models`, and every keyword read below decides whether
  // `checkInput` *throws* — which happens outside `submit`'s fetch try/catch,
  // so a keyword the prototype supplies refuses **every submission from every
  // caller**. Measured on the unguarded file: `Object.prototype.properties`
  // produced `parameter 'temperature' is not supported on VORQ`, and
  // `Object.prototype.enum` and `.minimum` each produced `parameter
  // 'temperature' is invalid` — over a schema the coordinator never published.
  //
  // One guard for every keyword read in this function, so there is one thing to
  // keep true. `Object.keys` below is already own-only and stays as it is: the
  // unevaluated-keyword warning must report the keywords the schema actually
  // states, and an inherited one is not stated.
  const kw = (keyword: string): unknown => own(s, keyword);

  for (const keyword of Object.keys(s)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      warnings.push(
        `parameter ${path}: this client does not evaluate the schema keyword ` +
          `'${keyword}', so that rule was not checked here — the serving ` +
          "provider still applies its own",
      );
    }
  }

  const declaredType = kw("type");
  if (typeof declaredType === "string") {
    // `Object.hasOwn`, never a bare index — and here the untrusted thing is the
    // **key as well as the record**: `TYPE_CHECKS` is this package's own table,
    // but the coordinator's published schema chooses what to look up in it, and
    // `kw("type")` above is what stops the prototype choosing for it. A bare
    // `TYPE_CHECKS[…]` answers from `Object.prototype`, so a schema saying
    // `{"type": "valueOf"}` returns `Object.prototype.valueOf`, which is then
    // *called* — `valueOf.call(undefined)` throws a raw `TypeError` that is not
    // a `VorqError` and escapes this SDK's error taxonomy, on every submit from
    // every caller. `{"type": "isPrototypeOf"}` returns `false` instead and
    // refuses every honest request. An unknown type name must be an unevaluated
    // keyword, exactly as it is for a type this table has never heard of.
    const check = Object.hasOwn(TYPE_CHECKS, declaredType)
      ? TYPE_CHECKS[declaredType]
      : undefined;
    if (check && !check(value)) return false;
  }
  const minimum = kw("minimum");
  if (typeof minimum === "number" && typeof value === "number" && value < minimum) return false;
  const maximum = kw("maximum");
  if (typeof maximum === "number" && typeof value === "number" && value > maximum) return false;
  // SameValueZero via `Array.prototype.includes`, not JSON Schema's deep-equality
  // semantics — a deliberate simplification, left as-is: VORQ's published enums
  // are scalars, so the two coincide in practice.
  const enumeration = kw("enum");
  if (Array.isArray(enumeration) && !enumeration.includes(value as never)) return false;
  // Draft 2020-12 requires exactly one branch to match; this accepts "at least
  // one" (`.some`) — a deliberate simplification, left as-is: the oneOf schemas
  // VORQ actually publishes are disjoint by type, so the two coincide in
  // practice. (Every branch tried, matching or not, is scanned for unevaluated
  // keywords above, which is why a failed branch can still contribute a warning.)
  const branches = kw("oneOf");
  if (Array.isArray(branches)) {
    if (!branches.some((sub) => matches(value, sub, warnings, path))) return false;
  }
  const items = kw("items");
  if (items !== undefined && Array.isArray(value)) {
    if (!value.every((item) => matches(item, items, warnings, path))) return false;
  }
  const properties = kw("properties");
  if (
    properties !== undefined &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    // Recurse into a nested object schema — mirrors checkInput's own top-level
    // handling of `properties` below: a `false` subschema forbids the key
    // outright, a defined subschema is matched recursively (so a violation
    // several levels down still fails the match, not just a top-level one),
    // and a key absent from `properties` is unknown — advisory, never a
    // refusal, warned the same way the top level warns about it. Without this,
    // `properties` would sit in KNOWN_KEYWORDS claiming to be evaluated while
    // silently dropping every field-level rule nested inside oneOf/items.
    const nestedProperties = properties as Record<string, unknown>;
    const nestedBody = value as Record<string, unknown>;
    // Both sides are untrusted records, so both are read own-properties only —
    // `Object.hasOwn`, never a bare `in` or a bare index (see `own.ts`). A bare
    // `key in nestedBody` answers `true` for `constructor` and `toString`, so a
    // published schema declaring `"constructor": false` would refuse a body
    // that never carried the key.
    for (const [key, sub] of Object.entries(nestedProperties)) {
      if (sub === false && Object.hasOwn(nestedBody, key)) return false;
    }
    for (const [key, propValue] of Object.entries(nestedBody)) {
      // The same rule in the other direction: a bare `nestedProperties[key]`
      // for a caller param named `constructor` hands back
      // `Object.prototype.constructor` — a function, then matched as if it were
      // a subschema, which skips the `sub === undefined` continue below.
      const sub = own(nestedProperties, key);
      if (sub === undefined) continue; // unknown: warned below, never refused
      if (!matches(propValue, sub, warnings, `${path}.${key}`)) return false;
    }
    const nestedKnown = new Set(Object.keys(nestedProperties));
    const nestedUnknown = Object.keys(nestedBody).filter((k) => !nestedKnown.has(k)).sort();
    if (nestedUnknown.length > 0) {
      warnings.push(
        `parameter ${path}: params not in the model's schema (a provider may ` +
          "ignore them): " + nestedUnknown.join(", "),
      );
    }
  }
  return true;
}

/** The output-cap spellings, any of which drives the declared units_out. */
const OUTPUT_CAP_KEYS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

/**
 * Cross-field rules a per-property schema cannot express.
 *
 * Budget-class params spend `units_out` from the inside, so they must leave
 * room in the cap the same request sets: a reasoning budget equal to the whole
 * output budget guarantees an empty answer at full price.
 */
function checkBudgetFitsCap(input: Record<string, unknown>): void {
  // `input` is the caller's object, so every read of it is own-properties only
  // (see `own.ts`). None of these three names is on `Object.prototype`, but a
  // caller layering its params over a defaults object with `Object.create`
  // inherits them — and `canonicalBytes` seals own properties only, so a bare
  // read would refuse a request over a value the network is never sent.
  const caps = OUTPUT_CAP_KEYS
    .map((k) => own(input, k))
    .filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  if (caps.length === 0) return; // no cap here; the schema's own maximum bounds it
  const cap = Math.min(...caps);
  const reasoning = own(input, "reasoning_max_tokens");
  if (typeof reasoning === "number" && Number.isInteger(reasoning) && reasoning >= cap) {
    throw new ValidationError(
      `reasoning_max_tokens (${reasoning}) must be below the output cap (${cap}): ` +
        "the whole budget spent on reasoning leaves no room for the answer",
      { type: "invalid_request_error" },
    );
  }
  const minTokens = own(input, "min_tokens");
  if (typeof minTokens === "number" && Number.isInteger(minTokens) && minTokens > cap) {
    throw new ValidationError(
      `min_tokens (${minTokens}) exceeds the output cap (${cap})`,
      { type: "invalid_request_error" },
    );
  }
}

/**
 * Validate an input locally. Throws `ValidationError` on a violation; returns
 * the advisory warnings (unknown keys, unevaluated keywords) for the caller to
 * surface however it likes.
 */
export function checkInput(schema: unknown, input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  const body = input as Record<string, unknown>;
  const warnings: string[] = [];

  if (typeof schema === "object" && schema !== null) {
    // Own properties only on the published schema (`own.ts`). `??` is not a
    // substitute: it fires on `undefined`, and an inherited property is not
    // undefined — so a polluted `Object.prototype.properties` carrying a
    // `false` subschema reached the refusal below and turned every submission
    // from every caller into `parameter '<k>' is not supported on VORQ`.
    const properties = (own(schema as Record<string, unknown>, "properties") ?? {}) as Record<
      string,
      unknown
    >;
    // A `false` subschema means the network forbids the key outright.
    //
    // `Object.hasOwn`, never `key in body`: `body` is the caller's object and
    // `properties` came off the network, and both are read own-properties only
    // (see `own.ts`). This is the site where a schema declaring
    // `"constructor": false` refused every request from every caller.
    for (const [key, sub] of Object.entries(properties)) {
      if (sub === false && Object.hasOwn(body, key)) {
        throw new ValidationError(`parameter '${key}' is not supported on VORQ`, {
          type: "invalid_request_error",
        });
      }
    }
    for (const [key, value] of Object.entries(body)) {
      // Own-properties only again: a bare `properties[key]` for a caller param
      // named `constructor` returns `Object.prototype.constructor`, so the
      // `sub === undefined` continue is skipped and the param is checked
      // against a *function* — a schema check silently not performed.
      const sub = own(properties, key);
      if (sub === undefined) continue; // unknown: warned below, never refused
      if (!matches(value, sub, warnings, key)) {
        throw new ValidationError(
          `parameter '${key}' is invalid: ${JSON.stringify(value)} does not match ` +
            "the model's published schema",
          { type: "invalid_request_error" },
        );
      }
    }
    const known = new Set(Object.keys(properties));
    const unknown = Object.keys(body).filter((k) => !known.has(k)).sort();
    if (unknown.length > 0) {
      warnings.push(
        "params not in the model's schema (a provider may ignore them): " +
          unknown.join(", "),
      );
    }
  }

  checkBudgetFitsCap(body);
  // A keyword scan runs on every branch a `oneOf` (or nested `properties`)
  // tries, including branches that end up failing, so the same keyword at the
  // same path can be scanned more than once for a single input. Dedupe rather
  // than make the caller clean up byte-identical warnings.
  return [...new Set(warnings)];
}
