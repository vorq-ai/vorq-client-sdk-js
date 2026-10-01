import { describe, expect, it } from "vitest";
import {
  MAX_POLL_INTERVAL_SECONDS,
  knownWindowSeconds,
  normalizeSla,
  pollInterval,
  slaSeconds,
  windowFromSeconds,
} from "../src/sla.js";

describe("normalizeSla", () => {
  it("resolves the two tier aliases and passes everything else through", () => {
    expect(normalizeSla("async")).toBe("1h");
    expect(normalizeSla("batch")).toBe("24h");
    // Unknown strings pass through verbatim, so a network-added window needs no
    // SDK release.
    expect(normalizeSla("1h")).toBe("1h");
    expect(normalizeSla("15m")).toBe("15m");
    expect(normalizeSla("weekly")).toBe("weekly");
  });

  it("reads own properties only, so a prototype key is passed through", () => {
    // The `Object.hasOwn` guard, pinned. A bare `TIER_ALIASES[value] ?? value`
    // reads through the prototype chain and hands back `Function.prototype`
    // members typed as `string` — `normalizeSla("toString")` would return a
    // function, and a `constructor` would go on the wire as `[object Object]`.
    expect(normalizeSla("toString")).toBe("toString");
    expect(normalizeSla("constructor")).toBe("constructor");
    expect(normalizeSla("__proto__")).toBe("__proto__");
    expect(typeof normalizeSla("valueOf")).toBe("string");
    // And the same key reaching the pacing arithmetic falls back, not throws.
    expect(slaSeconds("toString")).toBe(3600);
  });
});

describe("slaSeconds", () => {
  it("parses the three units, through the aliases too", () => {
    expect(slaSeconds("1h")).toBe(3600);
    expect(slaSeconds("24h")).toBe(86400);
    expect(slaSeconds("30m")).toBe(1800);
    expect(slaSeconds("45s")).toBe(45);
    expect(slaSeconds("async")).toBe(3600);
    expect(slaSeconds("batch")).toBe(86400);
  });

  it("falls back to one hour on anything unparseable", () => {
    for (const bad of ["", "h", "abc", "1.5h", "1d", "-1h", "1 h", "weekly"]) {
      expect(slaSeconds(bad)).toBe(3600);
    }
  });
});

describe("pollInterval", () => {
  it("is slaSeconds/60 held inside [2, 60]", () => {
    expect(pollInterval("1h")).toBe(60);
    expect(pollInterval("30m")).toBe(30);
    // The floor: a 45 s window would otherwise be polled every 0.75 s.
    expect(pollInterval("45s")).toBe(2);
    // The cap is the point of the clamp: without it a 24h job sleeps 1440 s and
    // is reported settled twenty-four minutes late.
    expect(pollInterval("24h")).toBe(MAX_POLL_INTERVAL_SECONDS);
    expect(pollInterval("batch")).toBe(60);
  });
});

describe("windowFromSeconds", () => {
  it("names the two tier windows and spells the rest as seconds", () => {
    expect(windowFromSeconds(3600)).toBe("1h");
    expect(windowFromSeconds(86400)).toBe("24h");
    expect(windowFromSeconds(900)).toBe("900s");
    // The job row carries seconds as a decimal string on some paths.
    expect(windowFromSeconds("3600")).toBe("1h");
  });

  it("returns null for anything that is not a positive duration", () => {
    for (const bad of [null, undefined, 0, -1, "abc", {}]) {
      expect(windowFromSeconds(bad)).toBeNull();
    }
  });
});

describe("knownWindowSeconds", () => {
  it("resolves the tier names and their raw windows to seconds", () => {
    expect(knownWindowSeconds("async")).toBe(3600);
    expect(knownWindowSeconds("batch")).toBe(86400);
    expect(knownWindowSeconds("1h")).toBe(3600);
    expect(knownWindowSeconds("24h")).toBe(86400);
  });

  it("answers null, never the one-hour fallback, for anything else", () => {
    expect(knownWindowSeconds("batc")).toBeNull();
    expect(knownWindowSeconds("2h")).toBeNull();
    expect(knownWindowSeconds("")).toBeNull();
    expect(knownWindowSeconds("toString")).toBeNull();
  });
});
