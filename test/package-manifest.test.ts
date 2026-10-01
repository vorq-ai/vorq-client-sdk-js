/**
 * The manifest, asserted without a build.
 *
 * These are the packaging facts that can be checked by reading `package.json`
 * alone: what the `exports` map lets a caller reach, in what order the
 * conditions are tried, what goes in the tarball, and that the thing is
 * publishable at all. The build-dependent half — that `dist/index.js` really
 * pulls in no Node built-in, and that it resolves under `--conditions=browser`
 * — lives in `scripts/check-package.mjs`, which needs `npm run build` to have
 * run and is therefore not a test.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Every object anywhere under `exports`, including `exports` itself. */
function conditionObjects(node: unknown): Record<string, unknown>[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  const self = node as Record<string, unknown>;
  return [self, ...Object.values(self).flatMap(conditionObjects)];
}

describe("package manifest", () => {
  it("lists browser before node in every condition object", () => {
    // In an `exports` object, key order is match order, and Node's own `node`
    // condition is always on — `--conditions=browser` only ever *adds* to it.
    // Listed the other way round, a browser bundler that also sets `node`
    // resolves the Node build silently.
    for (const object of conditionObjects(pkg.exports)) {
      const keys = Object.keys(object);
      if (!keys.includes("browser") || !keys.includes("node")) continue;
      expect(keys.indexOf("browser")).toBeLessThan(keys.indexOf("node"));
    }
  });

  it("exports only the two documented entries", () => {
    // Deep imports stay unsupported by construction: there is no `./*` here to
    // reach past these two into `dist/`.
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./package.json"]);
  });

  it("ships only dist, README and CHANGELOG", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "CHANGELOG.md"]);
  });

  it("is not private", () => {
    // `private: true` is the flag that makes `npm publish` refuse.
    expect(pkg.private).toBeUndefined();
  });

  it("keeps openai out of runtime dependencies", () => {
    // The compat transport is written against the `openai` package's shapes but
    // never imports it: a caller who does not use that surface must not install
    // it transitively.
    expect(pkg.dependencies.openai).toBeUndefined();
    expect(typeof pkg.devDependencies.openai).toBe("string");
  });

  it("declares a prerelease version", () => {
    // A deliberate tripwire on the human, not on the code: `1.0.0` waits on the
    // cross-language round trip against the Python SDK being green in CI. The
    // day that gate is cleared, this test is deleted *and* the CHANGELOG says
    // why — deleting it quietly is the failure mode it exists to catch.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+-/);
  });

  it("builds on prepack, so a manual publish cannot ship an empty package", () => {
    // `dist/` is gitignored, and `files` ships nothing else that is code. Without
    // this hook a human who clones fresh, runs `npm install` and runs
    // `npm publish` packs `package.json`, `README.md` and `CHANGELOG.md` and
    // nothing more — exit 0, no warning — and burns the version on the registry
    // permanently, on a package whose every import fails with
    // `ERR_MODULE_NOT_FOUND`. `npm publish` runs `prepack`, so the build is not
    // optional. The release workflow builds first and is safe either way; this
    // is for the manual path, which is the only one a clone has.
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts.build).toMatch(/^tsc /);
  });

  it("names a repository, for provenance", () => {
    // npm's provenance attestation is signed against the repository the build
    // ran in, and it refuses to publish without a repository URL it can match.
    expect(pkg.publishConfig.provenance).toBe(true);
    expect(pkg.repository.url).toMatch(/^git\+https:\/\//);
  });
});
