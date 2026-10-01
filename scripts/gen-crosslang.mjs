/**
 * The mirror of `vorq-client-sdk-python/scripts/gen_crosslang_fixture.py`: a
 * container this repo built, for the Python suite to open.
 *
 * `test/vectors/container-v1.json` pins the wrap as an opaque blob and asserts
 * nothing about its plaintext, so it cannot prove the seed rule and cannot prove
 * this repo's sealed box is libsodium's rather than merely self-consistent. This
 * fixture can: it carries the recipient's **private** key, so the other side has
 * to actually open the box.
 *
 * The inputs are fixed so that a failure names a byte rather than a run. The
 * output is not reproducible and is not meant to be — a sealed box mints a fresh
 * ephemeral key and the bulk cipher a fresh nonce — so the emitted file is the
 * authority. It is not a vector file and nothing outside it pins these bytes.
 *
 *   npm run build
 *   node scripts/gen-crosslang.mjs > ../vorq-client-sdk-python/tests/fixtures/crosslang-js.json
 */
import {
  buildContainer,
  commitmentOf,
  deriveDek,
  encryptUnderDek,
  jobIdFor,
  sealSeedTo,
} from "../dist/crypto/container.js";
import { curvePublicKey } from "../dist/crypto/sealed-box.js";

const hex = (b) => Buffer.from(b).toString("hex");

const recipientSecret = new Uint8Array(32).fill(0x22);
const recipientPublic = curvePublicKey(recipientSecret);
const seed = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const plaintext = new TextEncoder().encode('{"v":"vorq-env-v1","input":"js to python"}');

const dek = deriveDek(seed, owner);
const ciphertext = encryptUnderDek(plaintext, dek);
const container = buildContainer(sealSeedTo(recipientPublic, seed), ciphertext);
const c = commitmentOf(container);

console.log(
  JSON.stringify(
    {
      generated_by: "vorq-client-sdk-js/scripts/gen-crosslang.mjs",
      why: "the vectors pin the wrap as an opaque blob; this fixture carries the recipient's private key, so opening it proves the sealed box is libsodium's and that the sealed 32 bytes are the seed",
      recipient_secret_key: hex(recipientSecret),
      recipient_public_key: hex(recipientPublic),
      owner,
      seed: hex(seed),
      dek: hex(dek),
      plaintext: new TextDecoder().decode(plaintext),
      container: `0x${hex(container)}`,
      c,
      job_id: jobIdFor(owner, c),
    },
    null,
    2,
  ),
);
