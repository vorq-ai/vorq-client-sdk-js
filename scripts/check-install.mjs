/**
 * Pack, install the tarball somewhere else, and use it the way a consumer
 * would. Needs the network and a real bundler, so it is not in `npm test` and
 * not in the default CI job — it runs at release time and on demand.
 *
 *   npm run check:install
 *
 * Everything `scripts/check-package.mjs` asserts is asserted from inside the
 * repo that wrote the manifest. This is the one check made from outside it: a
 * scratch directory that has never heard of `src/`, resolving through the
 * published `exports` map alone.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const fail = (message) => failures.push(message);

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });

/** Run a command and report whether it succeeded, instead of throwing. */
function attempt(command, args, options = {}) {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }) };
  } catch (error) {
    return { ok: false, output: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}` };
  }
}

let scratch;
let tarball;
try {
  // -------------------------------------------------------------------------
  // 1. Pack.
  // -------------------------------------------------------------------------
  const packed = JSON.parse(run("npm", ["pack", "--json"], { cwd: root }));
  tarball = join(root, packed[0].filename);
  console.log(`packed ${packed[0].filename} (${packed[0].size} bytes)`);

  // -------------------------------------------------------------------------
  // 2. Install it somewhere that has never heard of this repo.
  // -------------------------------------------------------------------------
  scratch = mkdtempSync(join(tmpdir(), "vorq-check-install-"));
  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "vorq-install-check", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
  );
  run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: scratch, stdio: ["ignore", "inherit", "inherit"] });
  console.log(`installed into ${scratch}`);

  // -------------------------------------------------------------------------
  // 3. The quickstart, from a scratch Node script.
  // -------------------------------------------------------------------------
  // The entry resolves and an object is constructed.
  writeFileSync(
    join(scratch, "consume.mjs"),
    `import { Client, sealingFetch, TextResult } from "@vorq-ai/client-sdk";

const client = new Client({ baseUrl: "https://example.invalid" });
if (typeof client.submit !== "function") throw new Error("Client has no submit");
if (typeof sealingFetch !== "function") throw new Error("sealingFetch is not a function");
if (typeof TextResult !== "function") throw new Error("TextResult is not a class");
console.log("consume.mjs: entry resolved");
`,
  );
  const consumed = attempt(process.execPath, ["consume.mjs"], { cwd: scratch });
  console.log(consumed.output.trim());
  if (!consumed.ok) fail("the consumer Node script did not exit 0");

  // -------------------------------------------------------------------------
  // 4. The Vite build — a real bundler, resolving for the browser.
  // -------------------------------------------------------------------------
  // A *client* build, not `--ssr`: an SSR build resolves under `node` and
  // externalizes dependencies, so it would neither exercise the `browser`
  // condition nor put any of this package's code in the bundle to grep.
  // `VORQ_CHECK_INSTALL_VITE` pins the spec — `vite@7`, say. Unset, this uses
  // whatever `vite` resolves to today, which is the version a consumer would
  // get and therefore the one worth asserting against.
  const viteSpec = process.env.VORQ_CHECK_INSTALL_VITE || "vite";
  run("npm", ["install", "--no-audit", "--no-fund", viteSpec], { cwd: scratch, stdio: ["ignore", "inherit", "inherit"] });
  const viteVersion = JSON.parse(
    readFileSync(join(scratch, "node_modules/vite/package.json"), "utf8"),
  ).version;
  console.log(`bundler: vite ${viteVersion}`);

  const viteConfig = (entry, outDir) =>
    `import { defineConfig } from "vite";
export default defineConfig({
  logLevel: "warn",
  build: {
    outDir: ${JSON.stringify(outDir)},
    emptyOutDir: true,
    minify: false,
    lib: { entry: ${JSON.stringify(entry)}, formats: ["es"], fileName: "bundle" },
  },
});
`;

  writeFileSync(
    join(scratch, "entry.js"),
    `import { Client, sealingFetch, TextResult } from "@vorq-ai/client-sdk";
// Referenced from an export so nothing here is tree-shaken away.
export const build = (options) => new Client(options);
export { sealingFetch, TextResult };
`,
  );
  writeFileSync(join(scratch, "vite.barrel.config.js"), viteConfig("entry.js", "out-barrel"));
  const barrelBuild = attempt("npx", ["vite", "build", "--config", "vite.barrel.config.js"], { cwd: scratch });
  if (!barrelBuild.ok) {
    fail(`vite could not bundle @vorq-ai/client-sdk:\n${barrelBuild.output}`);
  } else {
    const outDir = join(scratch, "out-barrel");
    const bundle = readdirSync(outDir)
      .map((file) => readFileSync(join(outDir, file), "utf8"))
      .join("\n");
    console.log(`vite: barrel bundled, ${bundle.length} bytes`);
  }
} finally {
  // -------------------------------------------------------------------------
  // 5. Clean up on both paths.
  // -------------------------------------------------------------------------
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const message of failures) console.error(`  FAIL: ${message}`);
  process.exit(1);
}
console.log("\nOK");
