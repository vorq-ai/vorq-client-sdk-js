import { readFileSync } from "node:fs";

import { expect, it } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The surface, spelled out. This list is the package's promise; a symbol
 * appearing here without a doc entry, or disappearing without a CHANGELOG
 * line, is a break a caller finds at runtime and this test finds first.
 */
const SURFACE = [
  "AuthenticationError", "BatchFailed", "BrowserWalletSigner", "Client", "ContainerError",
  "DerivedKeyMismatch", "EmbeddingResult", "EscrowKeyUnverified", "JobError", "JobFailed",
  "JobHandle", "MediaResult", "NoWalletError", "NotFoundError", "PrivateKeySigner",
  "ResultIntegrityError", "SealedBoxCipher", "StateConflictError", "TextResult",
  "TransportError", "ValidationError", "VerificationError", "Verifier", "VorqError",
  "WaitTimeout", "WalletRejectedError", "deriveResultCipher", "mintSessionToken",
  "sealingFetch",
].sort();

/** The namespace by name, for the assertions that iterate `SURFACE`. */
const api = sdk as unknown as Record<string, unknown>;

/**
 * One construction per error class, because the taxonomy is not uniform:
 * `JobFailed` takes a required `{ errorType }` and `ContainerError` takes a
 * fault code *before* its message. A single `new Cls("x")` loop would not
 * assert that every class descends from `VorqError` — it would throw building
 * the two that do not take that shape, and a loop that had to be relaxed to
 * `try/catch` around them would stop asserting anything about them at all.
 */
const ERRORS: ReadonlyArray<readonly [string, () => sdk.VorqError]> = [
  ["VorqError", () => new sdk.VorqError("x")],
  ["AuthenticationError", () => new sdk.AuthenticationError("x")],
  ["TransportError", () => new sdk.TransportError("x")],
  ["NotFoundError", () => new sdk.NotFoundError("x")],
  ["StateConflictError", () => new sdk.StateConflictError("x")],
  ["ValidationError", () => new sdk.ValidationError("x")],
  ["VerificationError", () => new sdk.VerificationError("x")],
  ["EscrowKeyUnverified", () => new sdk.EscrowKeyUnverified("x")],
  ["ResultIntegrityError", () => new sdk.ResultIntegrityError("x")],
  ["WaitTimeout", () => new sdk.WaitTimeout("x")],
  ["JobFailed", () => new sdk.JobFailed("x", { errorType: "provider_fail" })],
  ["BatchFailed", () => new sdk.BatchFailed("x")],
  ["ContainerError", () => new sdk.ContainerError("too_short", "x")],
  ["DerivedKeyMismatch", () => new sdk.DerivedKeyMismatch("x")],
  ["NoWalletError", () => new sdk.NoWalletError("x")],
  ["WalletRejectedError", () => new sdk.WalletRejectedError("x")],
];

it("exports exactly the documented surface", () => {
  expect(Object.keys(sdk).sort()).toEqual(SURFACE);
});

it("every error class descends from VorqError", () => {
  for (const [name, build] of ERRORS) {
    const error = build();
    expect(error, name).toBeInstanceOf(sdk.VorqError);
    expect(error, name).toBeInstanceOf(Error);
    // `VorqError` names itself from `new.target`, so a class that reached this
    // barrel through the wrong module would report the wrong name here.
    expect(error.name, name).toBe(name);
  }
  // `instanceof VorqError` is true of every class here, so on its own it would
  // not notice one arriving from the wrong module. These pin each of the five
  // that declare something more specific — a nearer base, or a `type` string
  // its own module is the only place that sets.
  expect(new sdk.EscrowKeyUnverified("x")).toBeInstanceOf(sdk.VerificationError);
  expect(new sdk.ContainerError("too_short", "x").fault).toBe("too_short");
  expect(new sdk.DerivedKeyMismatch("x").type).toBe("derived_key_mismatch");
  expect(new sdk.NoWalletError("x").type).toBe("no_wallet");
  expect(new sdk.WalletRejectedError("x").type).toBe("wallet_rejected");
  // The loop above is only the taxonomy if it covers it. Every exported class
  // that descends from `VorqError` must have a construction in `ERRORS`, so a
  // new error added to the barrel and not to this file reddens here rather
  // than shipping unasserted.
  const named = new Set(ERRORS.map(([name]) => name));
  const taxonomy = SURFACE.filter((name) => {
    const value = api[name];
    return typeof value === "function" &&
      (value === sdk.VorqError || value.prototype instanceof sdk.VorqError);
  });
  expect(taxonomy.length).toBe(ERRORS.length);
  expect(taxonomy.filter((name) => !named.has(name))).toEqual([]);
});

it("every value export is constructible or callable", () => {
  for (const name of SURFACE) {
    expect(typeof api[name], name).toBe("function");
  }
});

it("Client is the class, not a type re-export", () => {
  expect(new sdk.Client({})).toBeInstanceOf(sdk.Client);
});

it("results are real classes", () => {
  // A caller narrowing a `BatchResult` reaches for `instanceof`, which a type
  // re-export would take away without any other symptom.
  expect(typeof sdk.TextResult).toBe("function");
  expect(typeof sdk.MediaResult).toBe("function");
  expect(typeof sdk.EmbeddingResult).toBe("function");
  expect(typeof sdk.JobError).toBe("function");
});

/**
 * The type-only half of the surface, pinned at *run* time as well.
 *
 * `pinTypeOnlySurface` below is never executed, so dropping a type from
 * `src/index.ts` reddens `npm run typecheck` and leaves `npm test` green. That
 * makes the release gate `npm run typecheck && npm test` rather than `npm test`
 * — which is fine as long as everyone knows it. This reads the barrel's own
 * text so the plan-11 types have a red test either way, with no build step.
 */
it("keeps the aggregate types on the barrel", () => {
  const barrel = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const name of ["Floor", "FloorBook", "JobsSummary", "JobsSummaryModel", "SlaWindow"]) {
    expect(barrel).toMatch(new RegExp(`\\b${name}\\b`));
  }
});

/**
 * The type-only half of the surface, pinned at compile time.
 *
 * `Object.keys` cannot see an `export type`, so tests 1–6 are blind to these:
 * deleting one from `src/index.ts` would leave every assertion above green and
 * break the next caller who tried to annotate a `Client` member. `npx tsc
 * --noEmit` is therefore the gate for this block, which is why it is written as
 * code and not as a comment.
 *
 * It is never executed and never called — `client` is an ambient declaration,
 * so nothing here constructs a `Client` or reaches the network. The `void` at
 * the end keeps the bindings live if `noUnusedLocals` is ever switched on.
 */
declare const client: sdk.Client;

async function pinTypeOnlySurface(): Promise<void> {
  const models: sdk.Models = client.models;
  const model: sdk.ModelRecord = await models.retrieve("a-model");
  const ctx: sdk.ChainContext = await client.chainContext();
  const allowlist: sdk.Allowlist = await client.allowlist();
  const entry: sdk.AllowlistEntry = allowlist.entries[0];
  const sealArgs: sdk.SealLineArgs = { ...({} as sdk.SealLineArgs), ctx };
  const line: sdk.SealedLine = await client.sealLine(sealArgs);
  await client.payLine(line, 0n, ctx, 0n);
  const options: sdk.RequestOptions = { retry: false };
  await client.json("GET", "/v1/models", options);
  await client.request("GET", "/v1/models", options);
  const floors: sdk.FloorBook = await client.floors({ model: 3 });
  const floor: sdk.Floor = floors.floors[0];
  const summary: sdk.JobsSummary = await client.jobsSummary({ owner: "0x0" });
  const perModel: sdk.JobsSummaryModel = summary.byModel[0];
  void [models, model, ctx, allowlist, entry, sealArgs, line, options, floors, floor, summary, perModel];
}

void pinTypeOnlySurface;
