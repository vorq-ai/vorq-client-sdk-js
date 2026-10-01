/**
 * Generate `src/media-units.ts` from `test/vectors/media-units-v1.json`.
 *
 *   node scripts/gen-media-units.mjs [--out PATH]
 *
 * `--out` writes somewhere else, which is how the suite checks the committed
 * module without rewriting it: a test that repairs the tree it is checking
 * cannot fail twice, and leaves a dirty working copy behind when it fails once.
 *
 * The other two SDKs read the distributed JSON as shipped data. This one cannot:
 * the package ships `dist` only (`files` in package.json) and the tsconfig has no
 * `resolveJsonModule`, so a JSON import would have to be emitted into `dist`,
 * resolved through NodeNext import attributes, and understood by every bundler a
 * browser consumer might use. A generated `as const` module is the same data with
 * none of that, and it types the table exactly rather than as `any`.
 *
 * Never edit the output. `make media-check` regenerates it and diffs, so a
 * hand-edit is a failing gate rather than a silent divergence between this SDK
 * and the two that read the JSON directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "test", "vectors", "media-units-v1.json");
const outFlag = process.argv.indexOf("--out");
const target = outFlag === -1 ? join(root, "src", "media-units.ts") : process.argv[outFlag + 1];

const table = JSON.parse(readFileSync(source, "utf8"));

// Only the parts the SDK derives from. The master's prose — `purpose`,
// `why_a_file`, `rules` — is there for a reader of the table and would be dead
// weight in a published bundle; `cases` is test data the suite reads from the
// JSON copy directly, and shipping it to every browser consumer is pure cost.
const shipped = {
  format: table.format,
  defaults: table.defaults,
  caps: table.caps,
  resolutions: table.resolutions,
  autoOrder: table.auto_order,
  autoFallback: table.auto_fallback,
  adaptiveAspect: table.adaptive_aspect,
  autoDuration: table.auto_duration,
  referenceKeys: table.reference_keys,
  referenceListKeys: table.reference_list_keys,
  clipKeys: table.clip_keys,
  audioKeys: table.audio_keys,
  outputCeilingKeys: table.output_ceiling_keys,
  frames: table.frames,
};

const banner = `/**
 * The media billing table — GENERATED, do not edit.
 *
 * Source: test/vectors/media-units-v1.json, distributed from the meta-repo by
 * \`make media\`. Regenerate with \`node scripts/gen-media-units.mjs\`;
 * \`make media-check\` fails if this file is not what that produces.
 *
 * Keys are camelCased from the master's snake_case where they reach TypeScript
 * callers (\`autoOrder\`); the aspect-ratio and resolution keys are the wire
 * spellings a caller actually writes and are left exactly as they are.
 */
`;

writeFileSync(
  target,
  `${banner}\nexport const MEDIA_UNITS = ${JSON.stringify(shipped, null, 2)} as const;\n`,
);

console.log(`wrote ${target}`);
