import { expect, it } from "vitest";
import { where } from "condition-probe";

/** The other half of `conditions.browser.test.ts`: the node project must NOT see it. */
it("resolves the node condition when browser is not in force", () => {
  expect(where).toBe("node");
});
