/**
 * Media unit declaration, against the table every party shares.
 *
 * The `cases` array in `media-units-v1.json` is the parity guard: this suite, the
 * Python client's and the daemon's all assert their own derivation against the
 * same literal expectations, so a divergence between two implementations fails in
 * each of their own repos rather than surfacing on a live chain as a provider
 * paid for work it did not do.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors.js";
import { MEDIA_UNITS } from "../src/media-units.js";
import { resolveAspectRatio } from "../src/media.js";
import { declareUnits } from "../src/units.js";

const cases = (
  JSON.parse(
    readFileSync(
      join(resolve(import.meta.dirname, ".."), "test", "vectors", "media-units-v1.json"),
      "utf8",
    ),
  ) as { cases: any[] }
).cases;

const ref = (width: number, height: number, extra: Record<string, unknown> = {}) => ({
  b64: "AA==",
  media_type: "image/png",
  width,
  height,
  ...extra,
});

describe("the shared cases", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(declareUnits(c.input, c.units_out_override), c.why).toEqual({
      unitsIn: c.units_in,
      unitsOut: c.units_out,
    });
  });

  it("has not quietly shrunk", () => {
    // Losing a case is silent — `it.each` just runs fewer tests. These are the
    // shapes this round exists to price correctly.
    const names = new Set(cases.map((c) => c.name));
    for (const required of [
      "legacy-image-pixels",
      "tiered-video-string-duration",
      "reference-image-to-video",
      "reference-start-and-end-frame",
      "reference-clip",
      "plain-text-is-untouched",
      "an-explicit-zero-output-survives",
    ]) {
      expect(names, required).toContain(required);
    }
  });
});

describe("aspect resolution", () => {
  it.each([
    [1280, 720, "16:9"],
    [1920, 1080, "16:9"],
    [1080, 1920, "9:16"],
    [720, 1280, "9:16"],
    [640, 480, "4:3"],
    [900, 1200, "3:4"],
    [1000, 1000, "1:1"],
    [2560, 1080, "21:9"],
  ])("reads %ix%i as %s", (w, h, expected) => {
    expect(resolveAspectRatio(undefined, [ref(w, h)])).toBe(expected);
    expect(resolveAspectRatio("auto", [ref(w, h)])).toBe(expected);
  });

  it("is scale-symmetric", () => {
    // Comparing log-ratios, not ratios: without it a 3840x2160 reference sits
    // further from 16:9 in absolute terms than a square one sits from 1:1, and
    // the metric starts preferring whichever row is numerically closest.
    expect(resolveAspectRatio("auto", [ref(1280, 720)])).toBe(
      resolveAspectRatio("auto", [ref(3840, 2160)]),
    );
  });

  it("falls back when there is nothing to measure", () => {
    expect(resolveAspectRatio("auto", [])).toBe("16:9");
  });

  it("never second-guesses an explicit ratio", () => {
    expect(resolveAspectRatio("1:1", [ref(1280, 720)])).toBe("1:1");
  });

  it("refuses a ratio the table does not name", () => {
    expect(() => resolveAspectRatio("9:21", [])).toThrow(ValidationError);
  });
});

describe("reference caps", () => {
  it("refuses a reference past the pixel cap before anything is sealed", () => {
    // Client-side, at declare time. The caps exist so the convention cannot
    // overflow the uint32 the order signs — and a caller learns that from a named
    // error rather than from a container they already paid to upload.
    expect(() => declareUnits({ prompt: "x", image: ref(4000, 4000), duration: 5 })).toThrow(
      /reference_pixels/,
    );
  });

  it("refuses more references than the cap allows", () => {
    // Every list inside its own cap, and the request still over: the total counts
    // the singular keys and the listed elements together.
    const clip = ref(64, 64, { media_type: "video/mp4", duration_secs: 1 });
    expect(() =>
      declareUnits({
        prompt: "x",
        image: ref(64, 64),
        end_image: ref(64, 64),
        video: clip,
        reference_images: Array.from({ length: 9 }, () => ref(64, 64)),
        reference_videos: [clip],
        duration: 5,
      }),
    ).toThrow(/reference_assets/);
    expect(MEDIA_UNITS.caps.reference_assets - 2).toBeGreaterThan(0);
  });

  it("refuses a reference list longer than its own cap", () => {
    expect(() =>
      declareUnits({
        prompt: "x",
        reference_images: Array.from({ length: 10 }, () => ref(64, 64)),
        duration: 5,
      }),
    ).toThrow(/reference_images/);
  });

  it("requires a listed clip to say how long it runs too", () => {
    const clip = { b64: "AAAA", media_type: "video/mp4", width: 64, height: 64 };
    expect(() => declareUnits({ prompt: "x", reference_videos: [clip], duration: 5 })).toThrow(
      /reference_videos\[0\]\.duration_secs/,
    );
  });

  it("refuses a list of references with a non-reference in it", () => {
    expect(() =>
      declareUnits({
        prompt: "x",
        reference_images: [ref(64, 64), "http://x/y.png"],
        duration: 5,
      }),
    ).toThrow(/reference_images\[1\]/);
  });

  it("bounds reference sound in bytes, because nothing else bounds it", () => {
    const big = "A".repeat(Math.floor((MEDIA_UNITS.caps.reference_audio_bytes * 4) / 3) + 8);
    expect(() =>
      declareUnits({
        prompt: "x",
        reference_audios: [{ b64: big, media_type: "audio/wav" }],
        resolution: "480p",
        duration: 5,
      }),
    ).toThrow(/reference_audio_bytes/);
  });

  it("refuses a reference clip past the duration cap", () => {
    expect(() =>
      declareUnits({
        prompt: "x",
        video: ref(64, 64, {
          media_type: "video/mp4",
          duration_secs: MEDIA_UNITS.caps.reference_duration_s + 1,
        }),
        duration: 5,
      }),
    ).toThrow(/reference_duration_s/);
  });

  it.each([
    ["no width", { b64: "AA==", media_type: "image/png", height: 720 }],
    ["a zero width", { b64: "AA==", media_type: "image/png", width: 0, height: 720 }],
    ["a negative width", { b64: "AA==", media_type: "image/png", width: -8, height: 720 }],
    ["a width as a string", { b64: "AA==", media_type: "image/png", width: "1280", height: 720 }],
    ["no bytes", { media_type: "image/png", width: 1280, height: 720 }],
    ["no media type", { b64: "AA==", width: 1280, height: 720 }],
  ])("refuses a reference with %s", (_label, bad) => {
    // Declared dimensions are what let this SDK price a reference without
    // decoding it — so an asset that omits or fudges them is refused here rather
    // than priced as zero and settled as a surprise.
    expect(() => declareUnits({ prompt: "x", image: bad, duration: 5 })).toThrow(ValidationError);
  });

  it("allows a reference at the pixel cap exactly", () => {
    expect(declareUnits({ prompt: "x", image: ref(3840, 2160), duration: 5 }).unitsIn).toBe(
      MEDIA_UNITS.caps.reference_pixels,
    );
  });

  it("keeps the worst case a caller can declare inside a uint32", () => {
    const { unitsIn } = declareUnits({
      prompt: "x",
      video: ref(3840, 2160, {
        media_type: "video/mp4",
        duration_secs: MEDIA_UNITS.caps.reference_duration_s,
      }),
      duration: 5,
    });
    expect(unitsIn).toBe(497_664_000);
    expect(unitsIn).toBeLessThan(2 ** 32 - 1);
  });
});

describe("what a duration is, spelled the same in three languages", () => {
  it.each([["7.5"], ["1e1"], ["+5"], [" 5 "], ["1_0"], ["0x10"], ["٣"], ["five"], [true], [[5]]])(
    "refuses %j, which is not whole seconds",
    (written) => {
      // `Number()` reads several of these and Python's `int()` reads a different
      // several. The provider re-derives the clip's length itself, so a spelling
      // two parsers disagree about is escrow for seconds that will not be rendered.
      expect(() => declareUnits({ prompt: "x", resolution: "720p", duration: written })).toThrow(
        /duration/,
      );
    },
  );

  it("requires a reference clip to say how long it runs", () => {
    // Left out, the clip is priced as a one-second still — and the provider reads
    // its real length after the claim and hands the job back.
    const clip = { b64: "AAAA", media_type: "video/mp4", width: 64, height: 64 };
    expect(() => declareUnits({ prompt: "x", video: clip, duration: 5 })).toThrow(
      /video\.duration_secs/,
    );
  });
});
