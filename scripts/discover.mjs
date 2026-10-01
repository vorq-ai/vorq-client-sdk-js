/**
 * Live-stack discovery, shared by the smoke scripts.
 *
 * Everything an order needs is read from the node rather than written down: the
 * model from `GET /v1/models`, and the provider and both rates from the
 * `GET /evm/asks` row published under the chosen SLA window. A rate transcribed
 * into a script is a rate that stops matching the book the first time the book
 * moves, and the order is then refused for a reason that has nothing to do with
 * the client.
 *
 * Extracted rather than copied for the reason `src/units.ts` was: two copies of
 * one rule drift, and the second copy is the one nobody updates.
 */

/**
 * Every model the node lists.
 *
 * `Models.list` is cached on the client, so a caller that needs the catalog for
 * its own printing can ask again for free.
 */
export const listModels = (client) => client.models.list();

/**
 * The ask this run should bid at: a provider id, both rates (USD per 1M units,
 * decimal strings), and the model id string the order signs.
 *
 * `windowSecs` is the SLA in seconds (`slaSeconds(normalizeSla(sla))`), which is
 * what the book is keyed by. `model` narrows to one catalog id; leaving it unset
 * takes the first row that resolves to a listed model.
 *
 * A two-sided ask is preferred: a `rate_out` of zero is an input-metered model,
 * and the text path wants both legs priced. That preference is a tiebreak only —
 * an explicitly named model is honoured whatever its rates.
 */
export async function discoverAsk(client, { windowSecs, model = undefined, models = null }) {
  const catalog = models ?? (await listModels(client));
  /** The model id a row's numeric `model_id` belongs to. */
  const nameOf = (modelId) =>
    catalog.find((m) => Number(m.vorq?.model_id) === Number(modelId))?.id ?? null;

  const book = await client.asks({ limit: 200 });
  const candidates = book.asks
    .filter((a) => a.sla === windowSecs)
    .map((a) => ({ ...a, model: nameOf(a.modelId) }))
    .filter((a) => a.model !== null && (model === undefined || a.model === model));

  if (candidates.length === 0) {
    throw new Error(
      `no ask under a ${windowSecs}s window${model ? ` for ${model}` : ""}: the book holds ` +
        JSON.stringify(book.asks.map((a) => ({ model: a.modelId, sla: a.sla }))),
    );
  }
  const ask = candidates.find((a) => a.rateOut !== "0") ?? candidates[0];
  return {
    model: ask.model,
    providerId: Number(ask.providerId),
    rateIn: ask.rateIn,
    rateOut: ask.rateOut,
    asOfBlock: book.asOfBlock,
  };
}
