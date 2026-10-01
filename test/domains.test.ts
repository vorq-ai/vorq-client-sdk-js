import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_VERSION,
  DEK_INFO_PREFIX,
  DEK_SALT,
  DERIVATION_MESSAGE,
  ENVELOPE_RESERVE_BYTES,
  ENVELOPE_VERSION,
  INLINE_MAX_BYTES,
  MAX_BODY_BYTES,
  MIN_CONTAINER_BYTES,
  SEALED_RESULT_VERSION,
  SEAL_NONCE_BYTES,
  SECRETBOX_NONCE_BYTES,
  SEED_LEN,
  SEED_WRAP_BYTES,
} from "../src/crypto/domains.js";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/container-v1.json", import.meta.url)), "utf8"),
) as { constants: Record<string, unknown>; kdf: { info_prefix: string; salt: string } };

describe("the container constants", () => {
  it("agrees with the vectors file rather than restating it", () => {
    expect(CONTAINER_VERSION).toBe(vectors.constants.version);
    expect(SEED_WRAP_BYTES).toBe(vectors.constants.wrap_bytes);
    expect(MIN_CONTAINER_BYTES).toBe(vectors.constants.min_container_bytes);
  });

  it("pins the widths the split depends on", () => {
    // Fixed width is what makes the split a split: there is deliberately no
    // length field in the bytes.
    expect(SEED_LEN).toBe(32);
    expect(SEED_WRAP_BYTES).toBe(32 + 16 + 32);
    expect(MIN_CONTAINER_BYTES).toBe(1 + SEED_WRAP_BYTES);
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024);
    expect(ENVELOPE_RESERVE_BYTES).toBe(64 * 1024);
    // Derived from the two above, and spelled out so that a change to the
    // derivation is a change to this line rather than a silent one.
    expect(INLINE_MAX_BYTES).toBe(15_679_488);
    // The property behind the derivation: a container at the threshold encodes
    // to exactly the room the reserve leaves it.
    expect(4 * Math.ceil(INLINE_MAX_BYTES / 3) + ENVELOPE_RESERVE_BYTES).toBe(MAX_BODY_BYTES);
    expect(SEAL_NONCE_BYTES).toBe(24);
    expect(SECRETBOX_NONCE_BYTES).toBe(24);
  });

  it("carries the KDF label as bytes, with an explicitly empty salt", () => {
    expect(new TextDecoder().decode(DEK_INFO_PREFIX)).toBe(vectors.kdf.info_prefix);
    expect(DEK_INFO_PREFIX).toBeInstanceOf(Uint8Array);
    // "0x" in the vectors: zero length, not 32 zero bytes.
    expect(vectors.kdf.salt).toBe("0x");
    expect(DEK_SALT.length).toBe(0);
  });

  it("carries the three version tags verbatim", () => {
    expect(DERIVATION_MESSAGE).toBe("VORQ-ENC-V1");
    expect(ENVELOPE_VERSION).toBe("vorq-env-v1");
    expect(SEALED_RESULT_VERSION).toBe("vorq-sealed-v1");
  });
});

describe("@noble/curves", () => {
  it("is a direct dependency on the 2.x line, not a hoisted transitive one", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@noble/curves"]).toMatch(/^\^?2\./);
  });

  it("exposes the v2 x25519 surface this port uses", async () => {
    const { x25519 } = await import("@noble/curves/ed25519.js");
    expect(typeof x25519.getPublicKey).toBe("function");
    expect(typeof x25519.getSharedSecret).toBe("function");
    // v1 spelled this `randomPrivateKey`; mixing the majors fails here.
    expect(typeof x25519.utils.randomSecretKey).toBe("function");
  });
});
