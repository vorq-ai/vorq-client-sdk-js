import { expect, it } from "vitest";
import { where } from "condition-probe";

/**
 * Proves the `browser` vitest project actually resolves the `browser` export condition.
 *
 * A project whose conditions were silently not applied would go on passing the browser
 * suite forever. This is the tripwire for it.
 */
it("resolves the browser condition, not the node one", () => {
  expect(where).toBe("browser");
});
