/**
 * One field of an **untrusted** record — a record that arrived from
 * `JSON.parse` or from a caller — read own-properties only. A bare `key in
 * record` or `record[key]` walks the prototype chain and so answers for keys
 * nobody sent; an inherited property must not be able to satisfy a check.
 *
 * Returns `undefined` for an inherited or absent key alike, which is what
 * every caller here treats as "the record does not state this". A record this
 * package built itself is not untrusted and is not in scope. The two attack
 * shapes, and a test per site, are in `test/prototype-reads.test.ts`.
 */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
