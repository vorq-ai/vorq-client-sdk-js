/**
 * `buildUpload` under the browser export condition.
 *
 * The node project runs `files.test.ts` and this one does not — the two suites
 * are split by filename (`vitest.config.ts`), so a case that must hold in both
 * runtimes has to be written on both sides. `FormData`, `Blob` and `File` are
 * the parts most likely to differ, and `buildUpload` is one implementation for
 * both by design: what is checked here is that the single implementation
 * resolves and behaves identically with `node` out of the condition set.
 */
import { describe, expect, it } from "vitest";
import { buildUpload } from "../src/files.js";

describe("buildUpload (browser condition)", () => {
  it("builds a multipart body with the file and purpose parts", async () => {
    const form = buildUpload("batch.jsonl", "batch", '{"a":1}\n');
    const file = form.get("file");
    expect(form.get("purpose")).toBe("batch");
    expect(typeof form.get("purpose")).toBe("string");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("batch.jsonl");
    expect((file as File).type).toBe("application/jsonl");
    expect(await (file as Blob).text()).toBe('{"a":1}\n');
  });

  it("hands bytes over without re-encoding them", async () => {
    // Not valid UTF-8, so the case can actually fail on a re-encode.
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x80, 0x0a]);
    const form = buildUpload("batch.jsonl", "batch", bytes);
    expect(new Uint8Array(await (form.get("file") as Blob).arrayBuffer())).toEqual(bytes);
  });
});
