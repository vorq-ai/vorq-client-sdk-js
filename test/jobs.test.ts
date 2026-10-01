import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import { JobHandle, type JobClient } from "../src/jobs.js";
import { JobFailed, ResultIntegrityError, ValidationError, WaitTimeout } from "../src/errors.js";
import { pollInterval } from "../src/sla.js";
import { TextResult } from "../src/results.js";
import type { RequestOptions } from "../src/transport.js";
import type { Signer } from "../src/signer/types.js";
import { CTX } from "./vectors-loader.js";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "job_1",
  object: "job",
  status: "queued",
  result_cid: null,
  vorq: { sla_secs: 3600, rate_in: "0", rate_out: "0", provider_id: 7, ended_because: 0, gas_fee: "0.03", fee: "0" },
  ...over,
});

const RESULT_BYTES = new TextEncoder().encode(
  JSON.stringify({
    output: [{ content: [{ type: "output_text", text: "hi" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
);

/**
 * A client that answers a scripted sequence of job rows.
 *
 * `GET` answers a row; anything else is the cancel and is recorded. `servedAt`,
 * when given, is the unix second the coordinator claims on each read's `Date`
 * header — the reference the cancel guard learns its skew from.
 */
function fakeClient(
  rows: Record<string, unknown>[],
  over: Partial<JobClient> = {},
  servedAt: number | null = null,
) {
  let i = 0;
  const posted: { path: string; body: unknown }[] = [];
  const client = {
    json: vi.fn(async () => rows[Math.min(i++, rows.length - 1)]),
    request: vi.fn(async (method: string, path: string, o: RequestOptions = {}) => {
      if (method === "GET") {
        const headers = new Headers({ "content-type": "application/json" });
        if (servedAt !== null) headers.set("date", new Date(servedAt * 1000).toUTCString());
        return new Response(JSON.stringify(rows[Math.min(i++, rows.length - 1)]), {
          status: 200,
          headers,
        });
      }
      posted.push({ path, body: o.json });
      return new Response("{}", { status: 200 });
    }),
    fetchBlob: vi.fn(async () => RESULT_BYTES),
    chainContext: vi.fn(async () => CTX),
    signer: { address: "0xabc", signCancel: vi.fn(async () => "0xsig") },
    cipher: null,
    resultCipher: vi.fn(async () => null),
    ...over,
  } as unknown as JobClient;
  return { client, posted, reads: () => i };
}

/**
 * A clock that never waits and never repeats. `now` is monotonic seconds, so a
 * default-timeout poll still has budget left after every read.
 */
const instant = {
  now: (() => {
    let t = 0;
    return () => (t += 1);
  })(),
  sleep: async () => {},
};

describe("JobHandle.result", () => {
  it("polls until terminal, then opens the named result", async () => {
    const { client, reads } = fakeClient([
      row(),
      row(),
      row({ status: "completed", result_cid: "bafyx" }),
    ]);
    const handle = new JobHandle(client, "job_1", instant);
    const result = await handle.result();
    expect(result).toBeInstanceOf(TextResult);
    expect((result as TextResult).text).toBe("hi");
    expect(reads()).toBe(3);
    expect(client.fetchBlob).toHaveBeenCalledWith("bafyx");
  });

  it("does not raise WaitTimeout on a job that settled inside its window", async () => {
    // The last sleep of the loop must not be allowed past the deadline: sleep
    // min(interval, remaining), and check the budget before sleeping. This job
    // settles on the very last read the window allows.
    const { client } = fakeClient([row(), row({ status: "completed", result_cid: "bafyx" })]);
    let clock = 0;
    const handle = new JobHandle(client, "job_1", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms / 1000;
      },
    });
    await expect(handle.result(60)).resolves.toBeInstanceOf(TextResult);
  });

  it("raises WaitTimeout carrying the job id once the window closes", async () => {
    const { client } = fakeClient([row()]);
    let clock = 0;
    const handle = new JobHandle(client, "job_1", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms / 1000;
      },
    });
    const err = await handle.result(10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeout);
    expect((err as WaitTimeout).jobId).toBe("job_1");
    // The clamp, pinned: the interval for a "1h" job is 60 s and the budget is
    // 10 s, so an unclamped sleep would block for a minute before reporting a
    // ten-second timeout. Nothing may elapse past the deadline being reported.
    expect(clock).toBeLessThanOrEqual(10);
  });

  it("paces from the job's own SLA, clamped to [2, 60]", () => {
    // The upper bound is what stops a "24h" job being read once every
    // twenty-four minutes, which put the last sleep past the deadline.
    expect(pollInterval("24h")).toBe(60);
    expect(pollInterval("1m")).toBe(2);
  });

  it("refuses a zero-length window rather than polling once and giving up", async () => {
    // slaSeconds("0h") is 0, which as the default timeout is an instantly
    // expired wait — a confusing way to say "this window is not a window".
    const { client } = fakeClient([row({ vorq: { sla_secs: 0, gas_fee: "0.03", fee: "0" } })]);
    await expect(new JobHandle(client, "job_1", instant).result()).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses a zero-length window named by the caller", async () => {
    const { client } = fakeClient([row()]);
    await expect(
      new JobHandle(client, "job_1", { ...instant, sla: "0h" }).result(),
    ).rejects.toThrow(ValidationError);
  });
});

describe("JobHandle.status", () => {
  it("reads the job once and hands back the wire status", async () => {
    const { client, reads } = fakeClient([row({ status: "in_progress" })]);
    expect(await new JobHandle(client, "job_1", instant).status()).toBe("in_progress");
    expect(reads()).toBe(1);
    expect(client.request).toHaveBeenCalledWith("GET", "/v1/jobs/job_1");
  });
});

describe("JobHandle failure reporting", () => {
  it.each([
    [3, "provider_fail"],
    [4, "reclaim"],
    [2, "cancelled"],
    [5, "expired"],
  ])("reports ended_because %i as %s", async (code, cause) => {
    // The job row carries no `error` object at all. A reader that looks for one
    // finds nothing and reports the status as the cause, which makes
    // provider_fail and reclaim — the two a caller is told it can branch on —
    // unreachable, with no error to say so.
    const status = code === 3 || code === 4 ? "failed" : "cancelled";
    const { client } = fakeClient([
      row({ status, vorq: { sla_secs: 3600, ended_because: code, gas_fee: "0.03", fee: "0" } }),
    ]);
    const err = await new JobHandle(client, "job_1", instant)
      .result()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailed);
    expect((err as JobFailed).errorType).toBe(cause);
    expect((err as JobFailed).jobId).toBe("job_1");
  });

  it("degrades an unknown ended_because to the status rather than guessing", async () => {
    const { client } = fakeClient([
      row({ status: "failed", vorq: { sla_secs: 3600, ended_because: 99, gas_fee: "0.03", fee: "0" } }),
    ]);
    const err = await new JobHandle(client, "job_1", instant)
      .result()
      .catch((e: unknown) => e);
    expect((err as JobFailed).errorType).toBe("failed");
  });

  it("refuses to open a completed job that names no result", async () => {
    // A broken settle: whatever `output` the coordinator put on the row is a
    // body it wrote itself, not the one the provider settled. There is no
    // inline fallback — returning somebody else's copy would be worse.
    const { client } = fakeClient([row({ status: "completed", result_cid: null })]);
    await expect(new JobHandle(client, "job_1", instant).result()).rejects.toThrow(
      ResultIntegrityError,
    );
    expect(client.fetchBlob).not.toHaveBeenCalled();
  });
});

describe("JobHandle.cancel", () => {
  it("says this client cannot cancel before it says this job cannot be cancelled", async () => {
    // Different answers. A client with no wallet cannot author the signature at
    // all, and nothing is sent.
    const { client, posted } = fakeClient([row()], { signer: null });
    await expect(new JobHandle(client, "job_1", instant).cancel()).rejects.toThrow(
      ValidationError,
    );
    expect(posted).toHaveLength(0);
  });

  it("signs Cancel and posts issued_at beside the signature", async () => {
    // The node relays the signature; JobRegistry.cancel never reads msg.sender
    // and there is no cancelFor, so this signature is the entire authority.
    const { client, posted } = fakeClient([row()]);
    // A pinned wall clock, so nothing in this file reads the real one.
    await new JobHandle(client, "job_1", { ...instant, issuedAtNow: () => 1_000_000 }).cancel();
    expect(posted[0]!.path).toBe("/v1/jobs/job_1/cancel");
    expect(posted[0]!.body).toMatchObject({ signature: "0xsig" });
    expect(typeof (posted[0]!.body as { issued_at: number }).issued_at).toBe("number");
  });

  it("refuses locally when a read's Date header shows the clock an hour out", async () => {
    // The chain refuses this as StaleOp before it spends an eth_call, and a
    // drifting local clock is the ordinary cause. The reference is learned, not
    // injected: the coordinator served this read an hour ahead of us, so the
    // stamp we would sign cannot land, and saying so here names the real problem
    // instead of relaying a signature that will be thrown away.
    const { client, posted } = fakeClient([row()], {}, 1_000_000 + 3600);
    const handle = new JobHandle(client, "job_1", {
      ...instant,
      issuedAtNow: () => 1_000_000,
    });
    await handle.status();
    await expect(handle.cancel()).rejects.toThrow(/600/);
    expect(posted).toHaveLength(0);
  });

  it("sends a cancel whose learned skew is inside the window", async () => {
    const { client, posted } = fakeClient([row()], {}, 1_000_000 + 599);
    const handle = new JobHandle(client, "job_1", {
      ...instant,
      issuedAtNow: () => 1_000_000,
    });
    await handle.status();
    await handle.cancel();
    expect(posted).toHaveLength(1);
  });

  it("sends a cancel unchecked when no read has offered a reference clock", async () => {
    // A cancel as the first call on a fresh handle has nothing to compare
    // against, and comparing this client's clock to itself would be a check that
    // cannot fail. No reference, no check — not a check that always passes.
    const { client, posted } = fakeClient([row()], {}, null);
    const handle = new JobHandle(client, "job_1", {
      ...instant,
      issuedAtNow: () => 1_000_000,
    });
    await handle.cancel();
    expect(posted).toHaveLength(1);
    expect((posted[0]!.body as { issued_at: number }).issued_at).toBe(1_000_000);
  });

  it("lets a caller pin the reference clock outright", async () => {
    // The `chainNow` seam, for a caller that knows better than the header.
    const { client, posted } = fakeClient([row()]);
    const handle = new JobHandle(client, "job_1", {
      ...instant,
      issuedAtNow: () => 1_000_000,
      chainNow: () => 1_000_000 + 3600,
    });
    await expect(handle.cancel()).rejects.toThrow(/600/);
    expect(posted).toHaveLength(0);
  });

  it("stamps issued_at after the context read, not before", async () => {
    // A slow chain-context read must not push the stamp out of the window
    // between signing and landing.
    let wall = 1_000_000;
    const signCancel = vi.fn(async () => "0xsig" as Hex);
    const { client, posted } = fakeClient([row()], {
      signer: { address: "0xabc", signCancel } as unknown as Signer,
      chainContext: vi.fn(async () => {
        wall += 30;
        return CTX;
      }),
    });
    const handle = new JobHandle(client, "job_1", {
      ...instant,
      issuedAtNow: () => wall,
      chainNow: () => wall,
    });
    await handle.cancel();
    expect((posted[0]!.body as { issued_at: number }).issued_at).toBe(1_000_030);
    expect(signCancel).toHaveBeenCalledWith("job_1", 1_000_030n, CTX);
  });
});
