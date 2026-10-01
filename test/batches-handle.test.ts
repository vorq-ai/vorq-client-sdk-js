/**
 * `BatchHandle`, and `Batches.list`.
 *
 * The handle is polled on a stopped clock (`handleHarness`) and every fixture
 * here is finite: a script that answered forever would turn a broken terminal
 * set or a missing deadline check into a hung run, which reads as tooling
 * trouble rather than as evidence.
 */
import { describe, expect, it, vi } from "vitest";

import { BatchHandle } from "../src/batches.js";
import {
  BatchFailed,
  NotFoundError,
  StateConflictError,
  ValidationError,
  WaitTimeout,
} from "../src/errors.js";
import { JobError, TextResult } from "../src/results.js";
import { errRow, handleHarness, listHarness, okRow } from "./helpers/submit-harness.js";

/**
 * Every macrotask and microtask the run could still be sitting on, drained.
 *
 * A single `setTimeout(0)` is not enough: the harness's file reads are timers
 * themselves, so one turn advances the run by one step rather than to its end.
 */
const drain = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("BatchHandle", () => {
  it("polls until terminal, then reads output then errors, in file order", async () => {
    const harness = handleHarness({
      statuses: ["validating", "in_progress", "completed"],
      output: [okRow("0xa", "cid-a", "first"), okRow("0xb", "cid-b", "second")],
      errors: [errRow("0xc", "provider refused")],
    });
    // 600 s of budget against a 60 s poll interval: ten reads' worth, and this
    // batch settles on the third.
    const results = await harness.handle.results(600);
    expect(results).toHaveLength(3);
    expect(results[0]).toBeInstanceOf(TextResult);
    expect((results[0] as TextResult).text).toBe("first");
    expect((results[1] as TextResult).text).toBe("second");
    // The error row is last because it is in the *second* file, not because of
    // where its line sat in the input.
    expect(results[2]).toBeInstanceOf(JobError);
    expect((results[2] as JobError).message).toBe("provider refused");
    // Read once each, after terminal — output first. Not polled, and not drained
    // incrementally: the files are frozen, so there is nothing to drain.
    expect(harness.contentReads).toEqual([harness.outputFileId, harness.errorFileId]);
    expect(harness.batchReads()).toBe(3);
    // Each row names its bytes and never carries them.
    expect(harness.blobReads).toEqual(["cid-a", "cid-b"]);
  });

  it("opens each result with the client's own cipher", async () => {
    // The fixture's bodies are sealed to the harness client's result key, so a
    // handle that passed `null` where its cipher belongs would raise
    // `ResultIntegrityError` here rather than hand back a readable result.
    const harness = handleHarness({
      statuses: ["completed"],
      output: [okRow("0xa", "cid-a", "opened", { customId: "line-7" })],
    });
    const [result] = await harness.handle.results(60);
    expect((result as TextResult).text).toBe("opened");
    // The caller's own label, back out of the sealed body — it was never on the
    // wire in the clear, so the row alone could not have produced it.
    expect((result as TextResult).customId).toBe("line-7");
    // Each row settles under its own signed rates: 1000 in and 1000 out at
    // "5" USD per 1M units, 1000 × 5 / 1e6 twice.
    expect((result as TextResult).cost).toBe("0.01");
  });

  it("raises BatchFailed when the batch itself failed", async () => {
    // The input file was refused: there are no lines and no files to read.
    const harness = handleHarness({ statuses: ["failed"] });
    const error = await harness.handle.results(60).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BatchFailed);
    expect((error as BatchFailed).batchId).toBe(harness.handle.id);
    expect(harness.contentReads).toEqual([]);
  });

  it("delivers a failed line as a JobError, never as BatchFailed", async () => {
    // The other half of the same distinction: a line that failed is a row in the
    // error file of a batch that ended `completed`.
    const harness = handleHarness({
      statuses: ["completed"],
      errors: [errRow("0xc", "the claimant could not deliver")],
    });
    const results = await harness.handle.results(60);
    expect(results).toHaveLength(1);
    expect(results[0]).toBeInstanceOf(JobError);
    expect((results[0] as JobError).type).toBe("provider_fail");
    expect((results[0] as JobError).jobId).toBe("0xc");
  });

  it("treats expired as terminal", async () => {
    // `JobHandle`'s TERMINAL set has no `expired`; a batch's does. Reusing the
    // job set would poll an expired batch until the caller's timeout — here, it
    // reads past the one-status script instead and says so.
    const harness = handleHarness({ statuses: ["expired"] });
    await expect(harness.handle.results(60)).resolves.toEqual([]);
    expect(harness.batchReads()).toBe(1);
  });

  it("treats cancelled as terminal", async () => {
    const harness = handleHarness({ statuses: ["cancelled"] });
    await expect(harness.handle.results(60)).resolves.toEqual([]);
    expect(harness.batchReads()).toBe(1);
  });

  it("times out without cancelling, and says the batch can be re-attached", async () => {
    const harness = handleHarness({ statuses: ["in_progress", "in_progress", "in_progress"] });
    const error = await harness.handle.results(0.001).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTimeout);
    expect((error as WaitTimeout).jobId).toBe(harness.handle.id);
    expect((error as WaitTimeout).message).toContain("Nothing was cancelled");
    expect((error as WaitTimeout).message).toContain("client.batches.get(...)");
    expect(harness.cancels).toEqual([]);
    // The sleep is clamped to what is left of the budget, so a 1 ms wait does
    // not block for the full poll interval before reporting a 0.001 s timeout.
    expect(harness.sleeps).toEqual([0.001]);
  });

  it("paces and bounds itself by the batch's own completion_window", async () => {
    // `1h`: a 3600 s default timeout and a 60 s interval, so the window closes
    // on the 61st read. A handle that reached for a fixed default instead would
    // run past this script (24h) or stop short of it.
    const harness = handleHarness({
      completionWindow: "1h",
      statuses: Array<string>(61).fill("in_progress"),
    });
    const error = await harness.handle.results().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTimeout);
    expect((error as WaitTimeout).message).toContain("did not settle within 3600s");
    expect(harness.batchReads()).toBe(61);
    expect(harness.sleeps).toEqual(Array<number>(60).fill(60));
  });

  it("defaults to a 24h window when the batch row names none", async () => {
    const harness = handleHarness({
      completionWindow: null,
      statuses: Array<string>(1441).fill("in_progress"),
    });
    const error = await harness.handle.results().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTimeout);
    expect((error as WaitTimeout).message).toContain("did not settle within 86400s");
    expect(harness.batchReads()).toBe(1441);
  });

  it("takes its deadline from the monotonic clock, not the wall clock", async () => {
    // `monotonicNow` is `jobs.ts`'s, imported rather than copied, and it prefers
    // a monotonic source precisely so a deadline survives a wall-clock step. A
    // second copy that reached for `Date.now()` would time out a healthy batch
    // the moment NTP corrected the host — and nothing else in this suite would
    // notice, because every other test supplies its own clock.
    //
    // Calibrated rather than asserted bare: the same run with a clock seam
    // supplied is the control, so an ambient `performance.now()` from the
    // runtime cannot be mistaken for the handle reading it.
    const spy = vi.spyOn(performance, "now");
    const seamed = handleHarness({ statuses: ["completed"] });
    await seamed.handle.results(600);
    const ambient = spy.mock.calls.length;

    const bare = handleHarness({ statuses: ["completed"] });
    await new BatchHandle(bare.client, "batch_1").results(600);
    const observed = spy.mock.calls.length - ambient;
    spy.mockRestore();
    expect(observed).toBeGreaterThan(0);
  });

  it("carries the file ids and counts the batch row named", async () => {
    const harness = handleHarness({
      statuses: ["completed"],
      output: [okRow("0xa", "cid-a", "first")],
      errors: [errRow("0xc", "nope")],
    });
    expect(await harness.handle.status()).toBe("completed");
    expect(harness.handle.outputFileId).toBe(harness.outputFileId);
    expect(harness.handle.errorFileId).toBe(harness.errorFileId);
    expect(harness.handle.requestCounts).toEqual({ total: 2 });
  });
});

describe("BatchHandle.consume", () => {
  it("fires callbacks in file order", async () => {
    const harness = handleHarness({
      statuses: ["completed"],
      output: [okRow("0xa", "cid-a", "first")],
      errors: [errRow("0xc", "nope")],
    });
    const seen: string[] = [];
    await harness.handle.consume(
      (r) => seen.push(`ok:${(r as TextResult).text}`),
      (e) => seen.push(`err:${e.message}`),
      60,
    );
    expect(seen).toEqual(["ok:first", "err:nope"]);
  });

  it("awaits a promise-returning callback before it resolves", async () => {
    // Gated rather than merely `async`: an `async` callback that only awaits a
    // resolved promise finishes on the next microtask, which the reads between
    // two lines would flush anyway — so it would pass with `Promise.all(pending)`
    // deleted. Nothing flushes a gate the test itself holds.
    const harness = handleHarness({
      statuses: ["completed"],
      output: [okRow("0xa", "cid-a", "first")],
      errors: [errRow("0xc", "nope")],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let settled = false;
    const done = harness.handle
      .consume(
        async (r) => {
          await gate;
          seen.push(`ok:${(r as TextResult).text}`);
        },
        (e) => seen.push(`err:${e.message}`),
        60,
      )
      .then(() => {
        settled = true;
      });

    // Every queued microtask and timer the run could be waiting on, drained.
    await drain();
    expect(settled).toBe(false);
    // The plain callback ran to completion meanwhile: the promise-returning one
    // is dispatched concurrently, not awaited inline.
    expect(seen).toEqual(["err:nope"]);

    release();
    await done;
    expect(settled).toBe(true);
    expect(seen).toEqual(["err:nope", "ok:first"]);
  });

  it("surfaces a rejecting callback as its own error, never as an unhandled rejection", async () => {
    // A promise-returning callback is pushed onto `pending` and awaited only at
    // the end of the run. Between those two points stands the **second file's
    // read** — a macrotask — so a callback that rejects on the first row of the
    // first file rejects while nothing is listening. Node calls that an
    // unhandled rejection, and under its default `--unhandled-rejections=throw`
    // it terminates the process before `consume` can reject with the callback's
    // own error. The handler attached at the push is what closes that window.
    //
    // The listener here is the assertion *and* the safety net: with one
    // registered, Node reports rather than throws, so a regression fails this
    // expectation instead of killing the run — a killed run reads as tooling
    // trouble rather than as evidence.
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const harness = handleHarness({
        statuses: ["completed"],
        output: [okRow("0xa", "cid-a", "first"), okRow("0xb", "cid-b", "second")],
        errors: [errRow("0xc", "nope")],
      });
      const seen: string[] = [];
      const error = await harness.handle
        .consume(
          async (r) => {
            const { text } = r as TextResult;
            if (text === "first") throw new Error("the callback exploded");
            await Promise.resolve();
            seen.push(text);
          },
          (e) => seen.push(`err:${e.message}`),
          600,
        )
        .catch((e: unknown) => e);

      // The caller's own error, not a wrapper and not a timeout.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("the callback exploded");
      // The rest of the file was still read: one callback rejecting does not
      // stop the read, it stops the run at the end of it. The second row's
      // callback lands before the error row because the error file's own read is
      // what flushes it — concurrent dispatch, exactly as designed.
      expect(seen).toEqual(["second", "err:nope"]);
      expect(harness.contentReads).toEqual([harness.outputFileId, harness.errorFileId]);

      // Every remaining microtask and timer drained, so a report that was going
      // to arrive has arrived.
      await drain();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("routes an error row to onResult when no onError was given", async () => {
    // The fallthrough is only reachable here: `results()` supplies both
    // callbacks, so it collects a merged list without ever taking this branch.
    const harness = handleHarness({
      statuses: ["completed"],
      output: [okRow("0xa", "cid-a", "first")],
      errors: [errRow("0xc", "nope")],
    });
    const seen: unknown[] = [];
    await harness.handle.consume((r) => seen.push(r), undefined, 60);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(TextResult);
    expect(seen[1]).toBeInstanceOf(JobError);
  });
});

describe("BatchHandle.cancel", () => {
  it("refuses locally for a completed batch, before any POST", async () => {
    const harness = handleHarness({ statuses: ["completed"] });
    const error = await harness.handle.cancel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(
      "Cannot cancel a batch with status completed",
    );
    expect(harness.cancels).toEqual([]);
  });

  it("raises the same class whichever side notices, so one catch works", async () => {
    // The coordinator answers `batch_not_cancellable` with a 400 and
    // `errorFromWire` maps 400 to `ValidationError`. If the local refusal above
    // were a `StateConflictError`, a caller's `catch` would work only when the
    // client happened to notice first.
    const harness = handleHarness({ statuses: ["in_progress"], cancelStatus: 400 });
    const error = await harness.handle.cancel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(StateConflictError);
    expect((error as ValidationError).statusCode).toBe(400);
  });

  it("cancels an in-flight batch", async () => {
    const harness = handleHarness({ statuses: ["in_progress"] });
    await harness.handle.cancel();
    expect(harness.cancels).toEqual([harness.handle.id]);
    const posts = harness.calls.filter(
      (c) => c.method === "POST" && c.url.includes("/v1/batches"),
    );
    expect(posts.map((c) => c.url)).toEqual(["http://node/v1/batches/batch_1/cancel"]);
  });
});

describe("Batches.list", () => {
  it("pages by cursor, not by offset — /v1/batches has no truncation headers", async () => {
    const harness = listHarness({
      pages: [
        {
          data: [{ id: "batch_1" }, { id: "batch_2" }],
          first_id: "batch_1",
          last_id: "batch_2",
          has_more: true,
        },
        { data: [{ id: "batch_3" }], first_id: "batch_3", last_id: "batch_3", has_more: false },
      ],
    });
    const first = await harness.client.batches.list({ limit: 2 });
    expect(first.batches.map((b) => b.id)).toEqual(["batch_1", "batch_2"]);
    expect(first.hasMore).toBe(true);
    expect(first.firstId).toBe("batch_1");
    expect(first.lastId).toBe("batch_2");
    // One request per call: `list` hands back a page, it does not walk one.
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]).toContain("limit=2");
    expect(harness.queries[0]).not.toContain("after=");
    expect(harness.queries[0]).not.toContain("offset=");

    const second = await harness.client.batches.list({ limit: 2, after: first.lastId as string });
    expect(second.batches.map((b) => b.id)).toEqual(["batch_3"]);
    expect(second.hasMore).toBe(false);
    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[1]).toContain("after=batch_2");
  });

  it("reads has_more off the body rather than counting the page", async () => {
    // A full page with `has_more: false` is the last page. The offset pager's
    // `returned === limit` half would call this one short of the truth and page
    // again; the cursor contract says the body decides.
    const harness = listHarness({
      pages: [{ data: [{ id: "batch_1" }, { id: "batch_2" }], has_more: false }],
    });
    const page = await harness.client.batches.list({ limit: 2 });
    expect(page.hasMore).toBe(false);
    expect(page.firstId).toBeNull();
    expect(page.lastId).toBeNull();
    expect(harness.queries).toHaveLength(1);
  });

  it("sends no query at all when neither limit nor after was given", async () => {
    const harness = listHarness({ pages: [{ data: [], has_more: false }]});
    await harness.client.batches.list();
    expect(harness.queries[0]).toBe("http://node/v1/batches");
  });
});

describe("a stranger's batch", () => {
  it("is NotFoundError, never a permission error", async () => {
    // The coordinator answers 404 for a stranger's id deliberately: a 403 would
    // confirm the id is real. Nothing in the client's mapping improves on that.
    const harness = handleHarness({ statusCode: 404 });
    const error = await harness.handle.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).statusCode).toBe(404);
  });
});

describe("Batches.get", () => {
  it("re-attaches from a persisted id with no network call", () => {
    const harness = handleHarness({ statuses: ["completed"] });
    const before = harness.calls.length;
    const handle = harness.client.batches.get("batch_9");
    expect(handle).toBeInstanceOf(BatchHandle);
    expect(handle.id).toBe("batch_9");
    expect(harness.calls).toHaveLength(before);
  });
});
