/**
 * The media billing table as this SDK reads it.
 *
 * The table is hand-authored data distributed from the meta-repo by `make media`
 * and held byte-identical across four repos by `make media-check`. This SDK is
 * the odd one out: it cannot read the JSON at runtime — the package ships `dist`
 * only and the tsconfig has no `resolveJsonModule` — so it carries a generated
 * module instead. That makes a second way to drift, between the JSON and the
 * module built from it, and the last test here is what closes it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MEDIA_UNITS } from "../src/media-units.js";

const root = resolve(import.meta.dirname, "..");
const raw = JSON.parse(
  readFileSync(join(root, "test", "vectors", "media-units-v1.json"), "utf8"),
) as Record<string, any>;

describe("the media billing table", () => {
  it("is the revision this build reads", () => {
    expect(MEDIA_UNITS.format).toBe("vorq-media-units-v1");
  });

  it("yields the defaults this SDK used to spell out", () => {
    // Against the literals deliberately: this is what proves that moving them
    // into shared data changed no number.
    expect(MEDIA_UNITS.defaults.dim).toBe(1024);
    expect(MEDIA_UNITS.defaults.duration_secs).toBe(5);
    expect(MEDIA_UNITS.defaults.units_out).toBe(4096);
  });

  it("ships every constant the derivation reads, so none is written twice", () => {
    // The drift this table exists to remove. Each of these was hand-written in
    // this SDK until the generator started shipping it; the Python client reads
    // the same names from its own copy of the same file.
    expect(MEDIA_UNITS.autoFallback).toBe("16:9");
    expect(MEDIA_UNITS.referenceKeys).toEqual(["image", "end_image", "video"]);
    expect(MEDIA_UNITS.outputCeilingKeys).toEqual([
      "max_output_tokens", "max_tokens", "max_completion_tokens",
    ]);
    expect(raw.auto_fallback).toBe(MEDIA_UNITS.autoFallback);
    expect(raw.reference_keys).toEqual([...MEDIA_UNITS.referenceKeys]);
    expect(raw.output_ceiling_keys).toEqual([...MEDIA_UNITS.outputCeilingKeys]);
    // The second round's: the listed references, which keys hold clips and which
    // hold sound, and the two spellings that hand a choice to the model.
    expect(MEDIA_UNITS.adaptiveAspect).toBe("adaptive");
    expect(MEDIA_UNITS.autoDuration).toBe("auto");
    expect(MEDIA_UNITS.defaults.auto_duration_secs).toBe(15);
    expect(MEDIA_UNITS.referenceListKeys).toEqual({
      reference_images: 9, reference_videos: 3, reference_audios: 3,
    });
    expect(MEDIA_UNITS.clipKeys).toEqual(["video", "reference_videos"]);
    expect(MEDIA_UNITS.audioKeys).toEqual(["reference_audios"]);
    expect(raw.adaptive_aspect).toBe(MEDIA_UNITS.adaptiveAspect);
    expect(raw.auto_duration).toBe(MEDIA_UNITS.autoDuration);
    expect(raw.reference_list_keys).toEqual(MEDIA_UNITS.referenceListKeys);
    expect(raw.clip_keys).toEqual([...MEDIA_UNITS.clipKeys]);
    expect(raw.audio_keys).toEqual([...MEDIA_UNITS.audioKeys]);
    expect(raw.caps.reference_audio_bytes).toBe(MEDIA_UNITS.caps.reference_audio_bytes);
  });

  it("names every resolution for every aspect ratio", () => {
    expect(Object.keys(MEDIA_UNITS.frames).sort()).toEqual([...MEDIA_UNITS.autoOrder].sort());
    for (const [aspect, row] of Object.entries(MEDIA_UNITS.frames)) {
      expect(Object.keys(row).sort(), aspect).toEqual([...MEDIA_UNITS.resolutions].sort());
    }
  });

  it.each([...MEDIA_UNITS.resolutions])("makes every shape of %s the same pixel budget", (tier) => {
    // A tier is an area, not a height: the models this interface describes render
    // every shape of one tier at about the same number of pixels, and a per-second
    // upstream charges the same for all of them. One `rate_out` can only price
    // them alike if the table does too — a height-anchored square would buy barely
    // half the pixels of the 16:9 frame for the same upstream second.
    const [aw, ah] = MEDIA_UNITS.frames["16:9"][tier];
    for (const [aspect, row] of Object.entries(MEDIA_UNITS.frames)) {
      const [width, height] = row[tier];
      expect(Math.abs((width * height) / (aw * ah) - 1), `${aspect} ${tier}`).toBeLessThan(0.015);
    }
  });

  it("anchors each tier on the frame it is named for", () => {
    expect(MEDIA_UNITS.resolutions.map((tier) => MEDIA_UNITS.frames["16:9"][tier])).toEqual([
      [854, 480], [1280, 720], [1920, 1080], [3840, 2160],
    ]);
  });

  it("writes each portrait row as the transpose it claims to be", () => {
    for (const [landscape, portrait] of [
      ["16:9", "9:16"],
      ["4:3", "3:4"],
    ] as const) {
      for (const tier of MEDIA_UNITS.resolutions) {
        const [w, h] = MEDIA_UNITS.frames[landscape][tier];
        expect(MEDIA_UNITS.frames[portrait][tier]).toEqual([h, w]);
      }
    }
  });

  it("keeps the convention inside the uint32 an order signs", () => {
    // `OrderTerms` refuses an overflow rather than wrapping — but refusing is an
    // error the caller has to hit to learn about. These caps make it unreachable.
    const uint32Max = 2 ** 32 - 1;
    const { reference_pixels: px, reference_assets: n, reference_duration_s: secs } =
      MEDIA_UNITS.caps;
    const clips = 1 + MEDIA_UNITS.referenceListKeys.reference_videos;
    const stills = n - clips;
    const worst = clips * px * secs + stills * px;
    expect(stills).toBeGreaterThan(0);
    // With real headroom, not by a byte — a later tier or one more listed clip
    // must not be one edit away from overflowing.
    expect(worst * 2).toBeLessThan(uint32Max);
  });

  it("fits the widest output a tier can buy as well", () => {
    const widest = Math.max(
      ...Object.values(MEDIA_UNITS.frames).flatMap((row) =>
        Object.values(row).map(([w, h]) => w * h),
      ),
    );
    expect(widest * MEDIA_UNITS.caps.reference_duration_s).toBeLessThan(2 ** 32 - 1);
  });

  it("is exactly what the generator produces from the distributed JSON", () => {
    // The drift this SDK alone can have. `make media` copies the JSON and then
    // regenerates the module; if someone edits the module by hand, or copies a
    // new JSON without regenerating, every other repo stays right and this one
    // silently prices media differently.
    const fresh = join(mkdtempSync(join(tmpdir(), "vorq-media-")), "media-units.ts");
    execFileSync("node", [join(root, "scripts", "gen-media-units.mjs"), "--out", fresh], {
      cwd: root,
    });
    expect(readFileSync(join(root, "src", "media-units.ts"), "utf8")).toBe(
      readFileSync(fresh, "utf8"),
    );
  });

  it("ships the data the other repos read, whatever this module keeps", () => {
    // The generated module deliberately drops the master's prose and its test
    // cases — dead weight in a browser bundle. The JSON copy beside it is still
    // the whole file, because `make media-check` diffs the whole file.
    expect(Object.keys(raw)).toEqual(
      expect.arrayContaining([
        "format", "purpose", "why_a_file", "rules", "defaults",
        "caps", "resolutions", "auto_order", "frames", "cases",
      ]),
    );
    expect(raw.frames).toEqual(MEDIA_UNITS.frames);
    expect(raw.auto_order).toEqual([...MEDIA_UNITS.autoOrder]);
  });
});
