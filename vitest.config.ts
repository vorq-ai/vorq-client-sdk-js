import { configDefaults, defineConfig } from "vitest/config";

/**
 * Two suites, one config:
 *   node    — everything that may use Node built-ins and the `node` export condition
 *   browser — the same runner with the `browser` condition in force and `node` out of it
 *
 * The browser project is not a real browser and does not need to be. What it has to
 * catch is the barrel failing to resolve under the browser condition — a *resolution*
 * failure, not a runtime one. Resolving under the browser condition is therefore the whole
 * test, and it costs no browser provider, no Playwright, and no extra dependency.
 *
 * `--conditions` only ever ADDS to Node's own always-on `node` and `import` conditions,
 * which is why every `exports` object in package.json lists `browser` before `node`:
 * in an exports object, order is match order.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // The INLINE_MAX_BYTES tests seal ~15 MiB containers: ~1.7 s locally,
          // up to 5.8 s on a GitHub runner, past the 5 s default.
          testTimeout: 20_000,
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/**/*.browser.test.ts"],
        },
      },
      {
        ssr: {
          resolve: {
            conditions: ["browser", "module", "import", "default"],
          },
        },
        test: {
          name: "browser",
          environment: "node",
          include: ["test/**/*.browser.test.ts"],
          exclude: [...configDefaults.exclude],
        },
      },
    ],
  },
});
