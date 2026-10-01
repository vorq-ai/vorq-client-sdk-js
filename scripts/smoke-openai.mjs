/**
 * The **stock `openai` package** against a live coordinator, over `sealingFetch`.
 * Not part of `npm test`: it needs a node listening.
 *
 *   VORQ_BASE_URL=http://127.0.0.1:8412 \
 *   VORQ_WALLET_KEY=0x… \
 *   npm run smoke:openai
 *
 * `scripts/smoke.mjs` drives the native surface; this one drives the same stack
 * through the package a caller already has installed, which is the only way to
 * see the compat transport meet a real coordinator. Nothing here calls the
 * `Client` to do the inference work — the client exists to be handed to
 * `sealingFetch` and to mint the session whose length is printed below.
 *
 * **Two different base URLs, on purpose.** `new OpenAI({baseURL})` carries the
 * `/v1` the package builds its paths from; `sealingFetch` takes the bare
 * coordinator origin, because the `Client` underneath talks to `/v1/jobs` and
 * friends directly.
 *
 * The order is a **background** one and it is polled through
 * `responses.retrieve`, because a synchronous create holds one HTTP call open
 * for the whole SLA window and the package's own timeout would end it first.
 * Everything the order needs is discovered from the node rather than written
 * down here — the model from `GET /v1/models`, and the provider and both rates
 * from the `GET /evm/asks` row published under the chosen window. A rate
 * transcribed into a script stops matching the book the first time the book
 * moves, and the order is then refused for a reason that has nothing to do with
 * the client.
 *
 * Overrides, all optional:
 *
 *   VORQ_SMOKE_MODEL     model id (default: the first the node lists that has
 *                        an ask under the chosen window)
 *   VORQ_SMOKE_PROVIDER  provider id (default: the ask's own)
 *   VORQ_SMOKE_PROMPT    the input string
 *   VORQ_SMOKE_SLA       tier or window (default `async`)
 *   VORQ_SMOKE_MAX_OUT   `max_output_tokens` (default 256, `0` omits it)
 *   VORQ_SMOKE_TIMEOUT   seconds to wait for a terminal state (default 300)
 *   VORQ_SMOKE_HTTP_TIMEOUT  seconds the openai package waits on one call
 *                        (default 120); a background create returns at once, so
 *                        this bounds the reads, not the job
 *   VORQ_SMOKE_POLL      seconds between status reads (default 2)
 *   VORQ_SMOKE_JSON      write a machine-comparable dump of the result here
 *   VORQ_SMOKE_SUBMIT=0  reads only
 */
import { writeFileSync } from "node:fs";

import OpenAI from "openai";

import { Client } from "../dist/client.js";
import { PrivateKeySigner } from "../dist/signer/private-key.js";
import { deriveResultCipher } from "../dist/crypto/cipher.js";
import { sealingFetch } from "../dist/openai-compat.js";
import { normalizeSla, slaSeconds } from "../dist/sla.js";
import { discoverAsk } from "./discover.mjs";

// Trailing slashes stripped, because this is the one smoke script that
// *concatenates* the base URL: `http://host//v1/responses` has an empty first
// segment, matches neither the intercepts nor the forward list, and every call
// would be refused as unsealed — a message that would not name the real cause.
const baseUrl = (process.env.VORQ_BASE_URL ?? "http://127.0.0.1:8402").replace(/\/+$/, "");
const signer = new PrivateKeySigner();
// The same derivation the native smoke run uses: the result key is what opens
// the sealed answer, and a different one here would open nothing.
const cipher = await deriveResultCipher(signer);
const client = new Client({ baseUrl, signer, cipher });

await client.ensureSession();
// The length, never the token: a smoke run's output is what gets pasted into an
// issue, and sixteen characters of a live session token is sixteen too many.
console.log("session   :", client.sessionToken ? `ok, ${client.sessionToken.length} chars` : "none");
console.log("wallet    :", signer.address);
console.log("result key:", cipher.publicKey);

const openai = new OpenAI({
  baseURL: `${baseUrl}/v1`,
  // The sealed surface authenticates with the wallet underneath; the package
  // insists on a key and never sends this one anywhere.
  apiKey: "unused",
  fetch: sealingFetch({ client }),
  // A sealed submission must never be replayed — a re-seal mints a fresh job id,
  // so a retry is a second order and not a duplicate anything can collapse. The
  // transport says so per response with `x-should-retry`; this is belt and
  // braces for the reads.
  maxRetries: 0,
  timeout: Number(process.env.VORQ_SMOKE_HTTP_TIMEOUT ?? 120) * 1000,
});

// -- the forwarded read ---------------------------------------------------------

// `GET /v1/models` is on the forward list: it carries nothing of the caller's,
// so it goes to the coordinator unsealed, and this is the package reading it.
const catalog = await openai.models.list();
const models = catalog.data ?? [];
console.log("models    :", models.length, models.slice(0, 3).map((m) => m.id));

if (process.env.VORQ_SMOKE_SUBMIT === "0") {
  console.log("OK (reads only)");
  process.exit(0);
}

// -- the order ------------------------------------------------------------------

const sla = process.env.VORQ_SMOKE_SLA ?? "async";
const window = normalizeSla(sla);
const windowSecs = slaSeconds(window);
const prompt =
  process.env.VORQ_SMOKE_PROMPT ??
  "Reply with exactly one short sentence: what is the capital of France?";
const maxOut = Number(process.env.VORQ_SMOKE_MAX_OUT ?? 256);

// Discovered, never transcribed. `scripts/discover.mjs` holds the rule; every
// smoke script asks it the same question so none can drift from the book.
const ask = await discoverAsk(client, { windowSecs, model: process.env.VORQ_SMOKE_MODEL });
const provider = Number(process.env.VORQ_SMOKE_PROVIDER ?? ask.providerId);

console.log("");
console.log("submit    :", ask.model, `provider=${provider}`, `sla=${sla} (${window})`);
console.log("rates     :", `rate_in=${ask.rateIn}`, `rate_out=${ask.rateOut}`);
console.log("prompt    :", JSON.stringify(prompt));

const t0 = Date.now();
const created = await openai.responses.create({
  model: ask.model,
  input: prompt,
  background: true,
  ...(maxOut > 0 ? { max_output_tokens: maxOut } : {}),
  // Everything an order needs that OpenAI's body has no field for. In Python
  // this rides `extra_body`; in JS the block is just another body field. The
  // rates are USD per 1M units, as decimal strings.
  vorq: {
    provider,
    sla: window,
    rate_in: ask.rateIn,
    rate_out: ask.rateOut,
  },
});
console.log("job id    :", created.id);
console.log("status    :", created.status);

// The status sequence, read through the package's own `responses.retrieve`. The
// loop's pacing is this script's; every read in it is the package's.
const timeout = Number(process.env.VORQ_SMOKE_TIMEOUT ?? 300);
const poll = Number(process.env.VORQ_SMOKE_POLL ?? 2);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const deadline = Date.now() + timeout * 1000;
const seen = [created.status];
let response = created;
while (!TERMINAL.has(response.status)) {
  if (Date.now() >= deadline) {
    throw new Error(
      `response ${created.id} was still ${response.status} after ${timeout}s (seen: ${seen})`,
    );
  }
  await new Promise((r) => setTimeout(r, poll * 1000));
  const next = await openai.responses.retrieve(created.id);
  if (next.status !== response.status) {
    seen.push(next.status);
    console.log("status    :", next.status, `(+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  response = next;
}
if (response.status !== "completed") {
  throw new Error(
    `response ${created.id} ended ${response.status}: ${JSON.stringify(response.error ?? null)}`,
  );
}

// The retrieve that settles is the one that opened the sealed result: the
// transport fetched the named blob and unsealed it with this wallet's derived
// key before the package ever saw a body. Nothing here decrypts anything.
console.log("");
console.log("settled   :", `${((Date.now() - t0) / 1000).toFixed(1)}s`, `states=${seen.join(" -> ")}`);
console.log("text      :", JSON.stringify(response.output_text ?? null));
console.log("output    :", JSON.stringify(response.output));
console.log("vorq      :", JSON.stringify(response.vorq ?? null));
console.log("usage     :", JSON.stringify(response.usage ?? null));

if (process.env.VORQ_SMOKE_JSON) {
  const dump = {
    sdk: "js",
    surface: "openai-package",
    id: response.id,
    model: response.model,
    states: seen,
    text: response.output_text ?? null,
    output: response.output,
    vorq: response.vorq ?? null,
    usage: response.usage ?? null,
  };
  writeFileSync(process.env.VORQ_SMOKE_JSON, JSON.stringify(dump, null, 2) + "\n");
  console.log("wrote     :", process.env.VORQ_SMOKE_JSON);
}
console.log("OK");
