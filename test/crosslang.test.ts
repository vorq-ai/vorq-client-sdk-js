import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  commitment,
  commitmentOf,
  deriveDek,
  jobIdFor,
  openDek,
  splitContainer,
} from "../src/crypto/container.js";
import { sealOpen } from "../src/crypto/sealed-box.js";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/crosslang.json", import.meta.url)), "utf8"),
) as {
  recipient_secret_key: string;
  recipient_public_key: string;
  owner: string;
  seed: string;
  dek: string;
  plaintext: string;
  container: string;
  c: string;
  job_id: string;
};

/**
 * Open a container the Python SDK built.
 *
 * `test/vectors/container-v1.json` pins the wrap as an opaque blob and asserts
 * nothing about its plaintext, so it does not prove the seed rule and does not
 * prove this repo's sealed box is libsodium's rather than merely self-consistent.
 * This does both: the fixture carries the recipient's private key, so the box has
 * to actually open.
 *
 * **This file guards this repo's reader, and the Python repo's writer only as of
 * the last regeneration.** The reading path — `splitContainer`, `sealOpen`,
 * `deriveDek`, `openDek`, `commitment*` — runs here on every suite. The Python
 * side's *writer* — its sealed box, `seal_seed_to`, `encrypt_under_dek` — ran once,
 * when the fixture was generated, and does not run again. So if a future edit over
 * there made `seal_seed_to` seal the DEK instead of the seed, this file would keep
 * passing against the committed bytes indefinitely. **The writer this fixture
 * froze is Python's, so the standing guard against the seed trap on the writing
 * side is the Python repo's own seed-rule test —
 * `vorq-client-sdk-python/tests/test_container.py:416`,
 * `test_the_recipient_is_the_only_party_that_can_read_it` — and not this one.**
 * (This repo's `test/container.test.ts` guards *this* repo's writer, which is
 * what the mirror file over there leans on for the other direction.) The mirror
 * of this paragraph is in `vorq-client-sdk-python/tests/test_crosslang_js.py`.
 *
 * **Regenerating the fixture is not reviewable by diff.** The wrap's ephemeral key
 * and the bulk cipher's nonce are fresh per run, so `container`, `c`, `job_id` and
 * the wrap all change wholesale: "the seed rule broke over there" and "somebody
 * re-ran the script" produce visually identical diffs. Running this test against
 * the new bytes is the only review there is, so it is a required step and not a
 * courtesy:
 *
 *   cd ../vorq-client-sdk-python
 *   PYTHONPATH=. .venv/bin/python scripts/gen_crosslang_fixture.py \
 *       > ../vorq-client-sdk-js/test/fixtures/crosslang.json
 *   cd ../vorq-client-sdk-js && npx vitest run test/crosslang.test.ts
 *
 * The seed rule is checked in its own `it` below, as is every other property, so a
 * cross-language keccak disagreement cannot consume the run before the one
 * property with almost no structural backstop has been evaluated.
 */
describe("a container the Python SDK built", () => {
  const container = bytes(fixture.container);

  it("splits and reproduces the same commitment and job id", () => {
    expect(commitmentOf(container)).toBe(fixture.c.toLowerCase());
    expect(jobIdFor(fixture.owner, fixture.c as `0x${string}`)).toBe(fixture.job_id.toLowerCase());
  });

  it("unseals the wrap to the SEED — not to the DEK", () => {
    const { seedWrap } = splitContainer(container);
    expect(seedWrap).toHaveLength(80);
    const unsealed = sealOpen(bytes(fixture.recipient_secret_key), seedWrap);
    expect(hex(unsealed)).toBe(fixture.seed.toLowerCase());
    // The trap, stated as an assertion: a client that sealed the DEK produces a
    // byte-perfect container that no provider can open.
    expect(hex(unsealed)).not.toBe(fixture.dek.toLowerCase());
  });

  it("re-derives the same DEK and reads the payload", () => {
    const { seedWrap, ciphertext } = splitContainer(container);
    const seed = sealOpen(bytes(fixture.recipient_secret_key), seedWrap);
    const dek = deriveDek(seed, fixture.owner);
    expect(hex(dek)).toBe(fixture.dek.toLowerCase());
    expect(new TextDecoder().decode(openDek(ciphertext, dek))).toBe(fixture.plaintext);
  });

  it("enters the ciphertext through its digest and lands on the same c", () => {
    // The two-argument form — the one a caller holding a wrap and a digest and no
    // container uses, which is the coordinator's `/release`. It has to agree with
    // `commitmentOf` above on bytes this repo did not write.
    const { seedWrap, ciphertext } = splitContainer(container);
    expect(commitment(seedWrap, bytes(keccak256(ciphertext)))).toBe(fixture.c.toLowerCase());
  });
});
