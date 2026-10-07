/**
 * Submit a sealed batch against a live coordinator. Not part of `npm test`.
 *
 *   VORQ_BASE_URL=http://127.0.0.1:8412 \
 *   VORQ_WALLET_KEY=0x… VORQ_PIN_GATEWAY=… \
 *   npm run smoke:batch
 *
 * Two lines, and the last carries no `custom_id` — the optional case, which must
 * still correlate by `job_id`. `1h`, not `24h`: the window IS the per-line SLA,
 * so a `24h` batch gives providers a day to answer and the run never finishes.
 *
 * `VORQ_PIN_GATEWAY` is **required, not an optimisation**: the coordinator serves
 * no blob endpoint, so it is the only path from a `result_cid` to the bytes it
 * names, and the shipped default is a public gateway that has never heard of a
 * local stack's names.
 *
 *   VORQ_BATCH_LINES     line count (default 2)
 *   VORQ_BATCH_WINDOW    completion window (default `1h`)
 *   VORQ_BATCH_MODEL     model id (default: the first with an ask under `window`)
 *   VORQ_BATCH_PROVIDER  provider id (default: the ask's own)
 *   VORQ_BATCH_PROMPT    input template; `{i}` is the line index
 *   VORQ_BATCH_MAX_OUT   `max_output_tokens` per line (default 256, `0` omits it)
 *   VORQ_BATCH_TIMEOUT   seconds to wait for the batch to settle (default 600)
 *   VORQ_BATCH_JSON      write a machine-comparable dump here
 *   VORQ_BATCH_MODE      `results` (default) or `cancel`
 *   VORQ_BATCH_UNPRICED  `1`: lines name no rates; the coordinator plans them
 *   VORQ_BATCH_CANCEL_AFTER  cancel mode: seconds to wait for a line to be
 *                        claimed before cancelling anyway (default 45)
 *
 * The defaults deliberately mirror `e2e/client_e2e.py`'s `run_batch` line for
 * line — same prompt, same `max_output_tokens`, same `custom_id` scheme. The
 * cross-SDK comparison is on `units_in`, `units_out` and the authorized `amount`,
 * and all three are functions of the request body: two SDKs fed different bodies
 * would differ for a reason that says nothing about either.
 */
import { writeFileSync } from "node:fs";

import { Client } from "../dist/client.js";
import { PrivateKeySigner } from "../dist/signer/private-key.js";
import { deriveResultCipher } from "../dist/crypto/cipher.js";
import { formatUsd } from "../dist/money.js";
import { normalizeSla, slaSeconds } from "../dist/sla.js";
import { discoverAsk, listModels } from "./discover.mjs";

const baseUrl = process.env.VORQ_BASE_URL ?? "http://127.0.0.1:8402";
const lineCount = Number(process.env.VORQ_BATCH_LINES ?? 2);
const window = normalizeSla(process.env.VORQ_BATCH_WINDOW ?? "1h");
const mode = process.env.VORQ_BATCH_MODE ?? "results";
const timeout = Number(process.env.VORQ_BATCH_TIMEOUT ?? 600);
const maxOut = Number(process.env.VORQ_BATCH_MAX_OUT ?? 256);
const unpriced = process.env.VORQ_BATCH_UNPRICED === "1";
const promptTemplate =
  process.env.VORQ_BATCH_PROMPT ?? "Reply with exactly one word: word-{i}";

if (!process.env.VORQ_PIN_GATEWAY) {
  throw new Error(
    "VORQ_PIN_GATEWAY is unset. The coordinator serves no blob endpoint, so a " +
      "result_cid has nowhere to be read from.",
  );
}

const signer = new PrivateKeySigner();
// Python derives this from the wallet at construction; here it is one explicit
// line, and it must be the *same* derivation or the two SDKs could not open each
// other's results.
const cipher = await deriveResultCipher(signer);
const client = new Client({ baseUrl, signer, cipher });
await client.ensureSession();

console.log("wallet    :", signer.address);
console.log("result key:", cipher.publicKey);

const models = await listModels(client);
const ask = await discoverAsk(client, {
  windowSecs: slaSeconds(window),
  model: process.env.VORQ_BATCH_MODEL,
  models,
});
const provider = Number(process.env.VORQ_BATCH_PROVIDER ?? ask.providerId);
console.log("model     :", ask.model, `provider=${provider}`, `window=${window}`);
console.log("rates     :", `rate_in=${ask.rateIn}`, `rate_out=${ask.rateOut}`);

const lines = Array.from({ length: lineCount }, (_, i) => ({
  // The last line carries no `custom_id` — the optional case, which must still
  // correlate by `job_id` through `handle.jobIds`.
  ...(lineCount > 1 && i === lineCount - 1 ? {} : { custom_id: `req-${i}` }),
  method: "POST",
  url: "/v1/responses",
  body: {
    model: ask.model,
    input: promptTemplate.replaceAll("{i}", String(i)),
    ...(maxOut > 0 ? { max_output_tokens: maxOut } : {}),
    ...(unpriced ? {} : { max_rate_in: ask.rateIn, max_rate_out: ask.rateOut }),
  },
}));

// The JSONL rows the SDK actually uploads. `payLine` is where a line stops being
// a sealed order and becomes a paid one, so wrapping it is the only place the
// signed terms, the container and the authorized amount are all in hand at once
// — and this is a *tap*, not a reimplementation: the row recorded is the row sent.
const sentRows = [];
const payLine = client.payLine.bind(client);
client.payLine = async (line, gasFee, ctx, feeBps) => {
  const row = await payLine(line, gasFee, ctx, feeBps);
  sentRows.push({ row, gasFee: formatUsd(gasFee, ctx.decimals) });
  return row;
};

const t0 = Date.now();
const handle = await client.batches.submit(lines, window, { providers: unpriced ? [] : [provider] });
console.log("batch     :", handle.id, `${handle.jobIds.length} lines`);
console.log("job ids   :", handle.jobIds.join(", "));
for (const { row } of sentRows) {
  console.log("line      :", `designated=${row.designated}`, `rate_in=${row.rate_in}`, `rate_out=${row.rate_out}`);
}

/** What each uploaded row committed, in the shape the Python dump is read into. */
const sealedDump = sentRows.map(({ row, gasFee }, i) => ({
  index: i,
  url: row.url,
  // A row is **flat** — the signed order's own fields, the container beside
  // them, and the payment. There is no `vorq` envelope and no `payment` block.
  c: row.c,
  owner: row.owner,
  job_id: row.job_id,
  model_id: String(row.model_id),
  sla_secs: Number(row.sla_secs),
  rate_in: row.rate_in,
  rate_out: row.rate_out,
  units_in: Number(row.units_in),
  units_out: Number(row.units_out),
  designated: row.designated,
  expires_at: Number(row.expires_at),
  order_sig: row.signature,
  container_b64_len: row.container.length,
  auth_sig: row.auth_sig,
  amount: row.amount,
  gas_fee: gasFee,
}));

if (mode === "cancel") {
  // Spec 06's last bullet: cancel mid-flight, and watch the coordinator walk
  // `cancelling` -> `cancelled`. The read loop is this script's pacing; every
  // read in it is the SDK's `GET /v1/batches/{id}`.
  const seen = [];
  const note = (s) => {
    if (seen[seen.length - 1] !== s) {
      seen.push(s);
      console.log("status    :", s, `(+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  };
  note(await handle.status());
  /**
   * One line's own job status.
   *
   * A line has no job row until the batch worker has posted it, so a `404` here
   * is "not posted yet" and not a failure — the batch is still `validating`.
   */
  const jobStatus = async (jobId) => {
    try {
      return String((await (await client.request("GET", `/v1/jobs/${jobId}`)).json()).status ?? "");
    } catch {
      return "unposted";
    }
  };
  // Mid-flight means **after a provider has taken a line**, not merely after the
  // POST returned: cancelling a batch nobody has claimed proves only that open
  // lines can be withdrawn, and the interesting half of the promise is what
  // happens to a line already in a provider's hands. Wait for one, then cancel.
  // The deadline is a bound, not a guarantee — if nothing is claimed in time the
  // cancel still goes out and `claimed_before_cancel` records that it did not.
  const claimWait = Number(process.env.VORQ_BATCH_CANCEL_AFTER ?? 45);
  const claimBy = Date.now() + claimWait * 1000;
  let claimedFirst = false;
  while (Date.now() < claimBy) {
    const states = await Promise.all(handle.jobIds.map(jobStatus));
    console.log("lines     :", states.join(", "));
    // `queued` is state 0 — posted and **open**, nobody on the hook yet
    // (`routes/jobs.ts:clientStatus`). Only `in_progress` means a provider has
    // taken the line, and `completed` means one already finished it; treating
    // `queued` as claimed would make this wait mean nothing.
    if (states.some((s) => s === "in_progress" || s === "completed")) {
      claimedFirst = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("claimed   :", claimedFirst ? "yes, cancelling now" : "none seen; cancelling anyway");
  await handle.cancel();
  console.log("cancel    : accepted");
  const deadline = Date.now() + timeout * 1000;
  let status = await handle.status();
  note(status);
  const DONE = new Set(["cancelled", "completed", "failed", "expired"]);
  while (!DONE.has(status)) {
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
    status = await handle.status();
    note(status);
  }
  // A line a provider already claimed runs to its own end, so each line's own
  // job row is read directly rather than inferred from the batch's status.
  const jobs = [];
  for (const jobId of handle.jobIds) {
    let row = {};
    try {
      row = await (await client.request("GET", `/v1/jobs/${jobId}`)).json();
    } catch {
      row = { status: "unposted" };
    }
    jobs.push({
      job_id: jobId,
      status: row.status ?? null,
      cause: row.ended_because ?? row.cause ?? null,
      result_cid: row.result_cid ?? null,
    });
    console.log(
      "line      :",
      jobId,
      row.status,
      row.ended_because ?? "",
      row.result_cid ? "(has result)" : "",
    );
  }
  const batch = await client.json("GET", `/v1/batches/${handle.id}`);
  const dump = {
    sdk: "js",
    mode: "cancel",
    batch_id: handle.id,
    job_ids: handle.jobIds,
    statuses: seen,
    final_status: status,
    claimed_before_cancel: claimedFirst,
    request_counts: batch.request_counts ?? null,
    jobs,
    sealed: sealedDump,
  };
  console.log(JSON.stringify(dump, null, 2));
  if (process.env.VORQ_BATCH_JSON) {
    writeFileSync(process.env.VORQ_BATCH_JSON, `${JSON.stringify(dump, null, 2)}\n`);
    console.log("wrote     :", process.env.VORQ_BATCH_JSON);
  }
  if (!seen.includes("cancelling")) {
    console.log("NOTE      : `cancelling` was never observed — the poll may have missed it");
  }
  console.log(status === "cancelled" ? "OK" : `ENDED ${status}`);
  process.exit(0);
}

// `results()` is the SDK's own settled path: it polls to a terminal state, reads
// the frozen output file, fetches each row's `result_cid` off the gateway and
// opens the box with this wallet's derived key. Nothing here decrypts anything
// on the script's behalf.
const results = await handle.results(timeout);
const settled = Date.now();
console.log("settled   :", `${((settled - t0) / 1000).toFixed(1)}s`);
console.log("counts    :", JSON.stringify(handle.requestCounts));
console.log("files     :", handle.outputFileId, handle.errorFileId);

const dump = results.map((r, i) => ({
  index: i,
  job_id: r.jobId ?? null,
  custom_id: r.customId ?? null,
  class: r.constructor.name,
  text: r.text ?? null,
  usage: r.usage ?? null,
  cost: r.cost ?? null,
  rate_in: r.rates?.rateIn ?? null,
  rate_out: r.rates?.rateOut ?? null,
  provider: r.provider ?? null,
  error: r.message ?? null,
}));
for (const row of dump) {
  console.log(
    `line      : custom_id=${row.custom_id} job=${row.job_id}: ${JSON.stringify(row.text)} ` +
      `cost=${row.cost} provider=${row.provider}`,
  );
}

const out = {
  sdk: "js",
  mode: "results",
  batch_id: handle.id,
  job_ids: handle.jobIds,
  request_counts: handle.requestCounts,
  output_file_id: handle.outputFileId,
  error_file_id: handle.errorFileId,
  sealed: sealedDump,
  lines: dump,
};
console.log(JSON.stringify(out, null, 2));
if (process.env.VORQ_BATCH_JSON) {
  writeFileSync(process.env.VORQ_BATCH_JSON, `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrote     :", process.env.VORQ_BATCH_JSON);
}

// The run only means something if every line came back **opened**: a settled
// batch whose bodies were never unsealed proves the coordinator's bookkeeping
// and nothing about this client.
const opened = dump.filter((r) => r.text !== null && r.text.trim() !== "").length;
const correlated = dump.every((r) => handle.jobIds.includes(r.job_id));
console.log("opened    :", `${opened}/${lineCount}`, "correlated:", correlated);
console.log(opened === lineCount && correlated ? "OK" : "FAIL");
process.exit(opened === lineCount && correlated ? 0 : 1);
