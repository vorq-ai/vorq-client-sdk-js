/** The `models` namespace. */

import { PAGE_DEFAULT_LIMIT, pageRows, walkListing } from "./paging.js";
import type { Transport } from "./transport.js";
import { own } from "./own.js";

const CACHE_TTL_MS = 300_000;

export interface ModelRecord {
  id: string;
  object: string;
  owned_by?: string;
  vorq?: { model_id?: string | number; enabled?: boolean; params_schema?: unknown; family?: string };
  [key: string]: unknown;
}

export class Models {
  private cache: ModelRecord[] | null = null;
  private cachedAt = 0;

  constructor(private readonly transport: Transport) {}

  /**
   * `GET /v1/models` — OpenAI-shaped entries plus a `vorq` capability block.
   * **The whole catalog**, walked to exhaustion rather than read one page deep.
   *
   * **This route is paged, and the bound that bites is a row cap rather than
   * the byte budget.** A request naming no `limit` is answered `LIMIT 100`, so
   * a single read of a 101-model catalog is simply missing model 101 — today,
   * at ordinary catalog sizes, with no huge response needed to trigger it. That
   * matters here more than on the other listings because this one is not just a
   * read: `Client.modelIdFor` resolves names against it, so a catalog cut at
   * page one makes the SDK **refuse a model that exists**, with an error naming
   * the wrong cause ("the catalog carries no numeric model_id"). The listing
   * would look complete and the refusal would look like the caller's mistake.
   *
   * The `limit` is **sent** rather than assumed, so the `returned === limit`
   * half of the stop condition compares against a number this client chose. A
   * walk that inferred the coordinator's default instead would end early the
   * day that default moved — see `PAGE_DEFAULT_LIMIT`.
   *
   * **The cache is written only once the walk completes.** It is a
   * *full-catalog* cache — `paramsSchema` and `modelIdFor` answer out of it
   * without re-reading, and `paramsSchema` treats a present-but-partial cache
   * as authoritative — so populating it from a partial read would poison every
   * later lookup for the cache's whole TTL, turning one short read into five
   * minutes of models that exist and cannot be resolved. A throw part-way
   * through leaves the previous catalog in place, which is the honest outcome:
   * an incomplete walk is not a catalog.
   *
   * The array is a **copy** of the cache, not the cache. Sorting or splicing a
   * returned list is the ordinary thing to do with it, and handing back the
   * cache itself would let that rewrite the catalog every later `paramsSchema`
   * lookup reads — a mutation with no visible cause, since the caller never
   * knew it held shared state. The records inside are shared; only the list is
   * the caller's.
   */
  async list(): Promise<ModelRecord[]> {
    const catalog = await walkListing<ModelRecord>(async (offset) => {
      const response = await this.transport.request("GET", "/v1/models", {
        // `offset` is omitted on the first page so the ordinary single-page
        // read stays the request it has always been but for the explicit limit.
        params: { limit: PAGE_DEFAULT_LIMIT, offset: offset === 0 ? undefined : offset },
      });
      const body = (await response.json()) as Record<string, unknown>;
      return { response, rows: pageRows(body, "data", "GET /v1/models") as ModelRecord[] };
    }, PAGE_DEFAULT_LIMIT);
    // Assigned after the walk, never during it.
    this.cache = catalog;
    this.cachedAt = Date.now();
    return [...this.cache];
  }

  /**
   * One model by name.
   *
   * The route is a **wildcard** because a model name is org-qualified —
   * `org/model:fp8` — so the value spans path segments. Each segment is escaped
   * but the slashes stay literal, so the wildcard spans them; the node decodes
   * the remainder, normalising either spelling onto the one stored name.
   */
  async retrieve(model: string): Promise<ModelRecord> {
    const path = model.split("/").map(encodeURIComponent).join("/");
    return this.transport.json<ModelRecord>("GET", `/v1/models/${path}`);
  }

  /**
   * The model's published input schema (`vorq.params_schema`), cached.
   *
   * **Nothing serves this field today, and the `null` is the design.**
   * `GET /v1/models` is the coordinator's projection of the chain's model table,
   * and the capability record a schema would live in is off-chain curation work
   * that is not built. So this returns `null` for every model and a submission
   * goes out unchecked — which is the direction the degrade has to run: a stale
   * or invented schema would refuse a param the serving provider supports and
   * the caller could not fix that from their side, while an unvalidated param is
   * stripped by the provider's own allowlist. **No schema means no validation,
   * never wrong validation.**
   */
  async paramsSchema(model: string): Promise<unknown | null> {
    if (this.cache === null || Date.now() - this.cachedAt > CACHE_TTL_MS) await this.list();
    for (const record of this.cache ?? []) {
      // Own properties only on a catalog row and its `vorq` block (`own.ts`).
      // `params_schema` is handed to `checkInput`, which **throws** on a `false`
      // subschema — so a schema supplied by a polluted prototype refuses every
      // submission for every caller, over a schema the coordinator never
      // published. That is the shipped defect this rule was written for, one
      // layer up from where it was fixed.
      const rec = record as unknown as Record<string, unknown>;
      const vorqMember = own(rec, "vorq");
      const vorq = (
        typeof vorqMember === "object" && vorqMember !== null ? vorqMember : {}
      ) as Record<string, unknown>;
      if (own(rec, "id") === model || own(vorq, "family") === model) {
        return own(vorq, "params_schema") ?? null;
      }
    }
    return null;
  }
}
