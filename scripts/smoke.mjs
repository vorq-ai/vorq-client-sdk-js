/**
 * Handshake, read, and submit against a live coordinator. Not part of `npm
 * test`: it needs a node listening.
 *
 *   VORQ_BASE_URL=http://127.0.0.1:8412 \
 *   VORQ_WALLET_KEY=0x… \
 *   npm run smoke
 *
 * The reads run unconditionally. The submission runs unless `VORQ_SMOKE_SUBMIT`
 * is `0`, and it is a **designated** order: this client refuses an open one
 * (R5), so the smoke run has to name a provider the way any caller would.
 *
 * Everything the order needs is discovered from the node rather than written
 * down here — the model from `GET /v1/models`, and the provider and both rates
 * from the `GET /evm/asks` row published under the chosen SLA window. A rate
 * transcribed into a script is a rate that stops matching the book the first
 * time the book moves, and the order would be refused for a reason that has
 * nothing to do with the client.
 *
 * Overrides, all optional:
 *
 *   VORQ_SMOKE_MODEL     model id (default: the first the node lists that has
 *                        an ask under the chosen window)
 *   VORQ_SMOKE_PROVIDER  provider id (default: the ask's own)
 *   VORQ_SMOKE_PROMPT    the input string
 *   VORQ_SMOKE_SLA       tier or window (default `async`)
 *   VORQ_SMOKE_CUSTOM_ID caller's tag, sealed into the envelope
 *   VORQ_SMOKE_TIMEOUT   seconds to wait for a terminal state (default 300)
 *   VORQ_SMOKE_POLL      seconds between status reads (default 2)
 *   VORQ_SMOKE_JSON      write a machine-comparable dump of the result here
 *   VORQ_SMOKE_SUBMIT=0  reads only
 */
import { writeFileSync } from "node:fs";

import { Client } from "../dist/client.js";
import { PrivateKeySigner } from "../dist/signer/private-key.js";
import { deriveResultCipher } from "../dist/crypto/cipher.js";
import { slaSeconds, normalizeSla } from "../dist/sla.js";
import { discoverAsk } from "./discover.mjs";

const baseUrl = process.env.VORQ_BASE_URL ?? "http://127.0.0.1:8402";
const signer = new PrivateKeySigner();
// Python derives this from the wallet at construction; here it is one explicit
// line, and it must be the *same* derivation or the two SDKs would not be able
// to open each other's results — which is precisely what this run is checking.
const cipher = await deriveResultCipher(signer);
const client = new Client({ baseUrl, signer, cipher });

await client.ensureSession();
// The length, never the token: a smoke run's output is what gets pasted into an
// issue, and sixteen characters of a live session token is sixteen too many.
console.log("session   :", client.sessionToken ? `ok, ${client.sessionToken.length} chars` : "none");
console.log("wallet    :", signer.address);
console.log("result key:", cipher.publicKey);

const ctx = await client.chainContext();
console.log("chain     :", ctx.chainId, ctx.contracts);

const models = await client.models.list();
console.log("models    :", models.length, models.slice(0, 3).map((m) => m.id));

const asks = await client.asks(
  models[0]?.vorq?.model_id ? { model: Number(models[0].vorq.model_id) } : {},
);
console.log("asks      :", asks.asks.length, "as_of_block", asks.asOfBlock);

const jobs = await client.jobs({ state: "Open", limit: 5 });
console.log("open jobs :", jobs.jobs.length);

if (jobs.jobs.length > 0) {
  const id = String(jobs.jobs[0].job_id);
  // `status()` answers the wire string itself, not a row to read `.status` off.
  console.log("job       :", id, await client.job(id).status());
}

if (process.env.VORQ_SMOKE_SUBMIT === "0") {
  console.log("OK (reads only)");
  process.exit(0);
}

// -- the order -----------------------------------------------------------------

const sla = process.env.VORQ_SMOKE_SLA ?? "async";
const window = normalizeSla(sla);
const windowSecs = slaSeconds(window);
const prompt =
  process.env.VORQ_SMOKE_PROMPT ??
  "Reply with exactly one short sentence: what is the capital of France?";
const customId = process.env.VORQ_SMOKE_CUSTOM_ID ?? null;

// Discovered, never transcribed. `scripts/discover.mjs` holds the rule; both
// smoke scripts ask it the same question so neither can drift from the book.
const ask = await discoverAsk(client, {
  windowSecs,
  model: process.env.VORQ_SMOKE_MODEL,
  models,
});
const provider = Number(process.env.VORQ_SMOKE_PROVIDER ?? ask.providerId);

console.log("");
console.log("submit    :", ask.model, `provider=${provider}`, `sla=${sla} (${window})`);
console.log("rates     :", `rate_in=${ask.rateIn}`, `rate_out=${ask.rateOut}`);
console.log("prompt    :", JSON.stringify(prompt));

const t0 = Date.now();
const handle = await client.submit({
  model: ask.model,
  input: prompt,
  sla,
  rateIn: ask.rateIn,
  rateOut: ask.rateOut,
  provider,
  ...(customId === null ? {} : { customId }),
});
console.log("job id    :", handle.id);
console.log("task cid  :", handle.taskCid);

// The status sequence, read through the SDK's own `GET /v1/jobs/{id}`. The
// loop's pacing is this script's, because `result()` paces a 1 h window at one
// read a minute and a smoke run should not sit through that; every *read* in it
// is still the SDK's.
const timeout = Number(process.env.VORQ_SMOKE_TIMEOUT ?? 300);
const poll = Number(process.env.VORQ_SMOKE_POLL ?? 2);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const deadline = Date.now() + timeout * 1000;
const seen = [];
let status = await handle.status();
seen.push(status);
console.log("status    :", status);
while (!TERMINAL.has(status)) {
  if (Date.now() >= deadline) {
    throw new Error(`job ${handle.id} was still ${status} after ${timeout}s (seen: ${seen})`);
  }
  await new Promise((r) => setTimeout(r, poll * 1000));
  const next = await handle.status();
  if (next !== status) {
    status = next;
    seen.push(status);
    console.log("status    :", status, `(+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}
if (status !== "completed") throw new Error(`job ${handle.id} ended ${status}, not completed`);

// The SDK's own settled-result path: it re-reads the row, fetches `result_cid`
// off the gateway, and opens the box with this wallet's derived key. Nothing
// here decrypts anything on the script's behalf.
const tSettled = Date.now();
const result = await handle.result();
const tOpened = Date.now();
const row = await (await client.request("GET", `/v1/jobs/${handle.id}`)).json();

console.log("");
console.log("settled   :", `${((tSettled - t0) / 1000).toFixed(1)}s`, `states=${seen.join(" -> ")}`);
// Split out on purpose: everything after `completed` is the gateway, and a
// freshly pinned name is not instantly resolvable on a public read gateway. A
// slow line here is propagation, not the client.
console.log("opened in :", `${((tOpened - tSettled) / 1000).toFixed(1)}s`, "(row read + gateway fetch + unseal)");
console.log("result cid:", row.result_cid);
console.log("kind      :", result.constructor.name);
console.log("text      :", JSON.stringify(result.text ?? null));
console.log("usage     :", JSON.stringify(result.usage ?? null));
console.log("rates     :", JSON.stringify(result.rates));
console.log("cost      :", result.cost);
console.log("provider  :", result.provider);
console.log("custom id :", result.customId);
console.log("payload   :", JSON.stringify(result.raw));

if (process.env.VORQ_SMOKE_JSON) {
  const dump = {
    sdk: "js",
    job_id: handle.id,
    task_cid: handle.taskCid,
    result_cid: row.result_cid ?? null,
    states: seen,
    kind: result.constructor.name,
    text: result.text ?? null,
    usage: result.usage ?? null,
    rates: { rate_in: result.rates.rateIn, rate_out: result.rates.rateOut },
    cost: result.cost,
    provider: result.provider,
    custom_id: result.customId,
    payload: result.raw,
  };
  writeFileSync(process.env.VORQ_SMOKE_JSON, JSON.stringify(dump, null, 2) + "\n");
  console.log("wrote     :", process.env.VORQ_SMOKE_JSON);
}
console.log("OK");
