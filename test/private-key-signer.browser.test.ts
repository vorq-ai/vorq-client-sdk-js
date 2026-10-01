import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../src/signer/private-key.js";

/** Every `.ts` under `src/`, as [relative path, source] pairs. */
function sources(): [string, string][] {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => [entry, readFileSync(root + entry, "utf8")]);
}

/**
 * The wallet key must never be read from the environment in a browser bundle.
 *
 * Two halves, and both are needed. The behavioural half is asserted by
 * constructing with the env var set and watching the signer refuse anyway under
 * the browser condition — except that this suite runs in Node, where `process`
 * exists, so the honest assertion is the source one: no bare `process.env`
 * anywhere in the file, which is what makes a bundler inject a shim and what
 * would smuggle the lookup into the browser build.
 *
 * The stricter form — a separate browser entry point where the lookup does not
 * exist at all — needs the build split that spec 08 owns.
 */
describe("PrivateKeySigner in a browser bundle", () => {
  it("keeps a globalThis probe in the signer", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/signer/private-key.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("globalThis");
  });

  it("carries the bare environment spelling nowhere in src/", () => {
    // Scanned across the whole package rather than the signer alone: `client.ts`
    // and `files.ts` grew probes of their own, and a hard-coded list of files to
    // check is a list that the next module to reach for the environment is not
    // on. The bare spelling must not appear anywhere — comments included, which
    // is why the docblocks that explain this rule never write it.
    const offenders = sources()
      .filter(([, source]) => /\bprocess\.env\b/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("still signs when handed a key explicitly — the browser's only path", async () => {
    const signer = new PrivateKeySigner(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    );
    expect(signer.address).toBe("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
    await expect(signer.signMessage("VORQ-ENC-V1")).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });
});
