/**
 * The packaging gate. Needs `npm run build` to have run — `npm test` must not,
 * because a test that silently passes when `dist/` is absent is worse than no
 * test at all.
 *
 *   node scripts/check-package.mjs [--expect-version vX.Y.Z]
 *
 * What it is for: the barrel must run in a browser. The manifest test asserts
 * the `exports` map; this asserts the build pulls in no Node built-in and Node's
 * own resolver serves it under the browser condition. Every finding is printed — it does not stop at the first — and any
 * finding at all exits non-zero.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);

const builtins = new Set(builtinModules);

/** `@scope/name/deep.js` → `@scope/name`; `name/deep.js` → `name`. */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The source with its comments removed, because a doc comment is not an import.
 *
 * `dist/` keeps its JSDoc — `src/openai-compat.ts` documents itself with a
 * fenced `import OpenAI from "openai";`, and `src/paging.ts` has the words
 * `from "that was the last of them"` in a sentence. Both match the specifier
 * regex below, and both would be reported as undeclared dependencies of the
 * browser entry.
 *
 * A character scanner rather than a `/\/\*[\s\S]*?\*\//g` replace, so that a
 * comment opener inside a string literal is not treated as a comment. It tracks
 * the two comment forms and the three string forms, and does **not** track
 * regex literals.
 *
 * **That last omission is reachable, not theoretical.** A regex containing an
 * escaped slash pair — `/https?:\/\//`, say — scans as `\`, `/`, `\`, then
 * `//`, which this reads as a line comment and discards the rest of the line
 * with. A regex containing a quote character would open a string state that
 * runs to the next matching quote. Neither exists in `dist/` today
 * (`dist/crypto/bytes.js` has a `/` inside a character class and is safe only
 * because it is a single slash), but that is a property of the current build
 * and one commit from expiring, so do not rely on it staying true.
 *
 * What makes the omission tolerable is its *direction*: a mis-scan discards
 * text, so it loses specifiers and never invents them. A lost specifier is a
 * check that passes when it should have failed — this gate fails open, not
 * closed. It is a layer, not the guarantee: #5 imports the barrel for real,
 * and `test/index-surface.browser.test.ts` resolves it under the browser
 * condition, neither of which reads a byte of this scanner's output.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      out += source[i++];
      while (i < source.length && source[i] !== quote) {
        // A backslash escapes the next character, quote included.
        out += source[i] === "\\" ? source.slice(i, i + 2) : source[i];
        i += source[i] === "\\" ? 2 : 1;
      }
      out += source[i] ?? "";
      i += 1;
    } else {
      out += source[i++];
    }
  }
  return out;
}

/** Every relative import reachable from an entry, following tsc's un-bundled output. */
function reach(entry) {
  const seen = new Set();
  const queue = [entry];
  const bare = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    // `from "…"` and `import("…")` cover every import tsc emits from this
    // source, plus the bare `import "…";` side-effect form — which imports a
    // module without naming a binding and would otherwise be invisible here.
    //
    // `stripComments` keeps string *contents*, because the specifier is one, so
    // the keyword must not be allowed to start inside a quote: an EIP-712 member
    // list writes `{ name: "from", type: "address" }`, and without the `"'` in
    // the lookbehind that reads as an import of `, type: `.
    const specifiers = [
      ...source.matchAll(/(?<![\w$."'])(?:from|import\()\s*["']([^"']+)["']/g),
      ...source.matchAll(/(?<![\w$."'])import\s*["']([^"']+)["']/g),
    ];
    for (const [, spec] of specifiers) {
      if (spec.startsWith(".")) {
        queue.push(resolve(dirname(file), spec));
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: seen, bare };
}

/** Run node with the given conditions; return {code, stderr} instead of throwing. */
function tryImport(specifier, conditions) {
  const args = conditions.map((c) => `--conditions=${c}`);
  args.push("--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`);
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stderr: String(error.stderr ?? "") };
  }
}

// ---------------------------------------------------------------------------
// 1. The build is there.
// ---------------------------------------------------------------------------
const entries = ["dist/index.js", "dist/index.d.ts"];
const missing = entries.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0) {
  // Absent is never a pass: everything below would be vacuously true.
  console.error(`FAIL: missing build output: ${missing.join(", ")} — run \`npm run build\` first`);
  process.exit(1);
}
console.log(`build: ${entries.length}/${entries.length} entry files present`);

// ---------------------------------------------------------------------------
// 2. Pack contents.
// ---------------------------------------------------------------------------
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
);
const packedPaths = packed[0].files.map((f) => f.path);
const packedSet = new Set(packedPaths);

for (const file of packedPaths) {
  if (file.startsWith("dist/") && file.endsWith(".js")) {
    const types = `${file.slice(0, -3)}.d.ts`;
    if (!packedSet.has(types)) fail(`packed ${file} has no sibling ${types}`);
  }
}
for (const required of ["README.md", "CHANGELOG.md"]) {
  if (!packedSet.has(required)) fail(`${required} is not in the tarball`);
}
const forbidden = packedPaths.filter(
  (file) => /(^|\/)(test|tests|fixtures|vectors)\//.test(file) || /\.test\.[jt]s$/.test(file) || /\.map$/.test(file),
);
if (forbidden.length > 0) fail(`tarball carries files it must not: ${forbidden.join(", ")}`);
console.log(`pack: ${packedPaths.length} files, ${packed[0].size} bytes packed / ${packed[0].unpackedSize} unpacked`);

// ---------------------------------------------------------------------------
// 3. The browser entry pulls in no Node built-in.
// ---------------------------------------------------------------------------
// A regex over `from "…"` / `import("…")` is enough here precisely because tsc
// does not bundle: every module in `dist/` is one source file with its imports
// written out, and NodeNext makes every relative specifier a complete filename.
const barrel = reach(join(root, "dist/index.js"));
for (const spec of barrel.bare) {
  if (spec.startsWith("node:") || builtins.has(spec)) {
    fail(`dist/index.js reaches the Node built-in ${spec}`);
    continue;
  }
  const name = packageName(spec);
  if (!Object.hasOwn(pkg.dependencies ?? {}, name)) {
    fail(`dist/index.js imports ${spec}, whose package ${name} is not in dependencies`);
  }
}
console.log(`browser entry: ${barrel.files.size} files reached, ${barrel.bare.size} bare specifiers, none built-in`);

// ---------------------------------------------------------------------------
// 4. Real resolution, under the browser condition.
// ---------------------------------------------------------------------------
if (tryImport("@vorq-ai/client-sdk", ["browser"]).code !== 0) fail("browser condition cannot resolve the barrel");
console.log("resolution: barrel resolves under browser");

// ---------------------------------------------------------------------------
// 5. Size report — printed, not asserted.
// ---------------------------------------------------------------------------
// A ceiling that legitimate growth trips is a ceiling people learn to ignore.
// #3 is the assertion; this is the number a human looks at.
const sized = [...barrel.files]
  .map((file) => ({ file: relative(root, file), bytes: statSync(file).size }))
  .sort((a, b) => b.bytes - a.bytes);
const total = sized.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`\nbrowser entry graph: ${sized.length} files, ${total} bytes`);
for (const { file, bytes } of sized.slice(0, 10)) {
  console.log(`  ${String(bytes).padStart(7)}  ${file}`);
}

// ---------------------------------------------------------------------------
// 7. License notice — a blocker to print, not a failure to invent.
// ---------------------------------------------------------------------------
if (!pkg.license) {
  console.log("\nRELEASE BLOCKER: no license field; publishing without one is a decision, not a default.");
}

// ---------------------------------------------------------------------------
// 8. --expect-version: what stops a tag publishing a version nobody bumped.
// ---------------------------------------------------------------------------
const flag = process.argv.indexOf("--expect-version");
if (flag !== -1) {
  const expected = process.argv[flag + 1];
  const actual = `v${pkg.version}`;
  if (expected !== actual) fail(`--expect-version ${expected} does not match package.json ${actual}`);
  else console.log(`version: ${actual} matches the expected tag`);
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const message of failures) console.error(`  FAIL: ${message}`);
  process.exit(1);
}
console.log("\nOK");
