import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { SEED_WRAP_BYTES } from "../src/crypto/domains.js";
import {
  curvePublicKey,
  generateCurveKeyPair,
  normalizeCurveKey,
  seal,
  sealOpen,
  secretBoxEncrypt,
  secretBoxOpen,
} from "../src/crypto/sealed-box.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/** The fixed test key the cross-language check in this file was pinned against. */
const SK = new Uint8Array(32).fill(7);
const EPK_BYTES = 32;
const PK_HEX = "13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d";
const MSG = new Uint8Array(32).fill(0x5a);

describe("normalizeCurveKey", () => {
  it("accepts both spellings the protocol serves, and nothing else", () => {
    // /evm/providers/:id serves 0x-prefixed; /key serves it bare. One door.
    expect(hex(normalizeCurveKey(PK_HEX))).toBe(PK_HEX);
    expect(hex(normalizeCurveKey(`0x${PK_HEX}`))).toBe(PK_HEX);
    expect(hex(normalizeCurveKey(PK_HEX.toUpperCase()))).toBe(PK_HEX);
    expect(hex(normalizeCurveKey(bytes(PK_HEX)))).toBe(PK_HEX);

    for (const bad of ["", "0x", PK_HEX.slice(0, 62), `${PK_HEX}ff`, ` ${PK_HEX} `, "zz".repeat(32)]) {
      expect(() => normalizeCurveKey(bad)).toThrowError();
    }
  });
});

describe("seal", () => {
  it("is exactly the wrap width, whatever spelling the key arrived in", () => {
    expect(seal(PK_HEX, MSG)).toHaveLength(SEED_WRAP_BYTES);
    expect(seal(`0x${PK_HEX}`, MSG)).toHaveLength(SEED_WRAP_BYTES);
  });

  it("produces the same box from both spellings — the same recipient, the same open", () => {
    // The boxes differ (a fresh ephemeral key each time); what must agree is
    // that both open to the same plaintext under the same secret key.
    expect(hex(sealOpen(SK, seal(PK_HEX, MSG)))).toBe(hex(MSG));
    expect(hex(sealOpen(SK, seal(`0x${PK_HEX}`, MSG)))).toBe(hex(MSG));
  });

  it("is anonymous — a fresh ephemeral key every time", () => {
    expect(hex(seal(PK_HEX, MSG))).not.toBe(hex(seal(PK_HEX, MSG)));
  });

  it("round-trips through a generated keypair", () => {
    const { privateKey, publicKey } = generateCurveKeyPair();
    expect(hex(curvePublicKey(privateKey))).toBe(hex(publicKey));
    expect(hex(sealOpen(privateKey, seal(publicKey, MSG)))).toBe(hex(MSG));
  });

  it("refuses a box the recipient cannot authenticate", () => {
    const wrong = new Uint8Array(32).fill(8);
    expect(() => sealOpen(wrong, seal(PK_HEX, MSG))).toThrowError();
    const tampered = seal(PK_HEX, MSG);
    tampered[70]! ^= 0x01;
    expect(() => sealOpen(SK, tampered)).toThrowError();
  });

  it("refuses a box too short to carry a box at all", () => {
    // The nonce is recomputed rather than carried, so a truncated box must be a
    // refusal, not a shorter plaintext. 32 is the exact edge: an ephemeral key
    // and nothing after it. Both hit this module's own guard by name.
    expect(() => sealOpen(SK, new Uint8Array(0))).toThrowError(/32-byte ephemeral key/);
    expect(() => sealOpen(SK, new Uint8Array(EPK_BYTES))).toThrowError(/32-byte ephemeral key/);
    // One byte past the edge is noble's refusal rather than ours; that it is a
    // refusal at all is the point.
    expect(() => sealOpen(SK, new Uint8Array(EPK_BYTES + 1))).toThrowError();
  });

  it("returns a plaintext whose buffer is exactly the plaintext", () => {
    // noble hands back a subarray into its own working buffer. A consumer that
    // reaches for `.buffer` — the next task feeds this seed straight into a KDF —
    // must not see the whole box.
    const opened = sealOpen(SK, seal(PK_HEX, MSG));
    expect(opened.byteOffset).toBe(0);
    expect(opened.buffer.byteLength).toBe(MSG.length);

    const key = new Uint8Array(32).fill(0x11);
    const plain = secretBoxOpen(secretBoxEncrypt(MSG, key), key);
    expect(plain.byteOffset).toBe(0);
    expect(plain.buffer.byteLength).toBe(MSG.length);
  });

  it("opens a box libsodium wrote — the check no self-round-trip can make", () => {
    // Produced by PyNaCl 1.6.2: SealedBox(PrivateKey(bytes([7]*32)).public_key)
    //   .encrypt(bytes([0x5a]*32)). A self-consistent implementation that is not
    // libsodium passes every other test in this file and fails here.
    const fromLibsodium = bytes(
      "5105d94ad30222780a3fc564a980e90c3eb8ae6a88d9b9290248e3463afe112a" +
        "d560aa8401d8bd6829c4073b7fbef1da46f26971a7c6556a5e4425d706f7d3c0" +
        "06ef513b4ef652ed6edadd100f0854ee",
    );
    expect(fromLibsodium).toHaveLength(SEED_WRAP_BYTES);
    expect(hex(sealOpen(SK, fromLibsodium))).toBe(hex(MSG));
  });

  it("derives the recipient's public key the way libsodium does", () => {
    expect(hex(x25519.getPublicKey(SK))).toBe(PK_HEX);
  });
});

describe("secretBox", () => {
  it("prepends the nonce, so the ciphertext is self-describing", () => {
    const key = new Uint8Array(32).fill(0x11);
    const framed = secretBoxEncrypt(new TextEncoder().encode("hello vorq"), key);
    expect(framed).toHaveLength(24 + 10 + 16);
    expect(new TextDecoder().decode(secretBoxOpen(framed, key))).toBe("hello vorq");
  });

  it("matches libsodium byte for byte for a pinned nonce and key", () => {
    // PyNaCl: SecretBox(bytes([0x11]*32)).encrypt(b"hello vorq", bytes([0x22]*24))
    const key = new Uint8Array(32).fill(0x11);
    const framed = bytes(
      "222222222222222222222222222222222222222222222222" +
        "ad5d87a83fa5338157f4d4297e2f1911dd7bdb4896e55bcca4aa",
    );
    expect(new TextDecoder().decode(secretBoxOpen(framed, key))).toBe("hello vorq");
    expect(hex(secretBoxEncrypt(new TextEncoder().encode("hello vorq"), key, new Uint8Array(24).fill(0x22)))).toBe(
      hex(framed),
    );
  });

  it("round-trips an empty payload", () => {
    const key = new Uint8Array(32).fill(0x33);
    expect(secretBoxOpen(secretBoxEncrypt(new Uint8Array(0), key), key)).toHaveLength(0);
  });

  it("refuses a wrong key and a tampered ciphertext", () => {
    const key = new Uint8Array(32).fill(0x11);
    const framed = secretBoxEncrypt(new TextEncoder().encode("hello"), key);
    expect(() => secretBoxOpen(framed, new Uint8Array(32).fill(0x12))).toThrowError();
    framed[30]! ^= 0x01;
    expect(() => secretBoxOpen(framed, key)).toThrowError();
  });

  it("refuses a key that is not 32 bytes and a buffer too short to carry a nonce", () => {
    expect(() => secretBoxEncrypt(new Uint8Array(1), new Uint8Array(16))).toThrowError();
    expect(() => secretBoxOpen(new Uint8Array(10), new Uint8Array(32))).toThrowError();
  });
});
