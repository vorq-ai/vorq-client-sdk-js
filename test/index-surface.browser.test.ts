import { expect, it } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The barrel is what a browser bundler pulls in for `import {…} from
 * "@vorq-ai/client-sdk"`.
 */
it("resolves under the browser condition", () => {
  expect(typeof sdk.Client).toBe("function");
});
