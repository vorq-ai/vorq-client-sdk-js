import { inspect } from "node:util";
import { x25519 } from "@noble/curves/ed25519.js";
import { keccak256, type Hex } from "viem";
import { describe, expect, it, beforeEach } from "vitest";
import {
  DerivedKeyMismatch,
  SealedBoxCipher,
  deriveResultCipher,
  resetDerivedKeyCache,
} from "../src/crypto/cipher.js";
import { toHex } from "../src/crypto/bytes.js";
import { DERIVATION_MESSAGE } from "../src/crypto/domains.js";
import { VorqError } from "../src/errors.js";
import type { Signer } from "../src/signer/types.js";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/** The pinned wallet: anvil index 4, the key the signing vectors use. */
const ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const PERSONAL_SIGN =
  "0xd531fb2c3b6a5e0f98f93fe4c498132ac942d848f2c2a24bbac7c3ca4bf3f29b" +
  "1ce89aa974e949d7750c890e85d2f9b43f31658cb4d1d0ca88dccb460c0b79f31b";
/** keccak256 of that signature — the X25519 scalar. */
const SCALAR = "0x4f80152f6d33d933378e4824e1a8b541356d8380b157abdfcba95bb544229191";
/** What PyNaCl's `PrivateKey(scalar).public_key` reports for it. */
const DERIVED_PUBLIC = "38cda5030eae34366bb2204034975c1192a4e23c427be6922cc362fecf14491b";

// Only the two members `deriveResultCipher` reads — so this typechecks whether
// `Signer` is spec 03's full interface or the fallback subset.
function fakeSigner(signature: string, address = ADDRESS): Pick<Signer, "address" | "signMessage"> {
  return {
    address: address as `0x${string}`,
    signMessage: async (message: string) => {
      expect(message).toBe(DERIVATION_MESSAGE);
      return signature as Hex;
    },
  };
}

beforeEach(() => {
  resetDerivedKeyCache();
});

describe("SealedBoxCipher", () => {
  it("reports its public key as 64 lowercase hex, bare", () => {
    const cipher = SealedBoxCipher.fromSeed(bytes(SCALAR));
    expect(cipher.publicKey).toBe(DERIVED_PUBLIC);
    expect(cipher.publicKey).not.toMatch(/^0x/);
    expect(cipher.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats the seed as the scalar directly, so one seed is one keypair", () => {
    // Against x25519 arithmetic, not against a second call to `fromSeed`: any
    // pure function of the seed agrees with itself, so a `fromSeed` that hashed
    // or stretched the seed first — `new SealedBoxCipher(sha256(seed))` — would
    // satisfy a self-comparison and produce a key no other SDK derives.
    const seed = bytes(SCALAR);
    expect(SealedBoxCipher.fromSeed(seed).publicKey).toBe(toHex(x25519.getPublicKey(seed)));
    expect(SealedBoxCipher.fromSeed(seed).publicKey).toBe(
      SealedBoxCipher.fromSeed(seed).publicKey,
    );
  });

  it("copies the caller's key material rather than holding a view into it", () => {
    // Zeroing a seed buffer after handing it over is the correct thing to do
    // with key material. A `normalizeCurveKey` that returned the caller's array
    // by reference would leave the cipher holding an all-zero scalar, and every
    // result sealed to the reported public key would be unopenable.
    const seed = bytes(SCALAR);
    const cipher = new SealedBoxCipher(seed);
    const before = cipher.publicKey;
    seed.fill(0);
    expect(cipher.publicKey).toBe(before);
    expect(cipher.publicKey).toBe(toHex(x25519.getPublicKey(bytes(SCALAR))));
  });

  it("keeps the private scalar off every serialization of itself", () => {
    // TypeScript `private` is compile-time only: as a plain own property the
    // scalar is listed by `Object.keys`, written by `JSON.stringify`, and
    // printed by any structured logger that ever holds a cipher.
    //
    // Searching a serialization for the scalar's *hex* does not catch that — a
    // `Uint8Array` never serializes as hex. Nor does pinning `JSON.stringify`'s
    // output: `toJSON` masks every own property, whatever it is named. Each of
    // the three doors below therefore needs its own assertion, and only the
    // first speaks to what the object actually holds.
    const scalar = SCALAR.replace(/^0x/, "");
    const cipher = new SealedBoxCipher(bytes(SCALAR));
    expect(cipher.privateKeyHex).toBe(scalar); // the deliberate, documented door

    // 1. What the object holds, past both hooks. Every own data property —
    //    enumerable or not, string- or symbol-keyed — with every `Uint8Array`
    //    anywhere inside it rewritten to hex, so the scalar is findable whether
    //    it is stored as bytes, as hex, renamed, or nested. (Accessors are
    //    excluded: `privateKeyHex` is a deliberate prototype getter, and an own
    //    getter is invisible to all three doors anyway.)
    const ownData = Reflect.ownKeys(cipher).map(
      (k) => Object.getOwnPropertyDescriptor(cipher, k)?.value,
    );
    const surface = JSON.stringify(ownData, (_k, v: unknown) =>
      v instanceof Uint8Array ? toHex(v) : v,
    );
    expect(surface).not.toContain(scalar);

    // 2. `toJSON` is what keeps it out of a log line. Pinned exactly, so any
    //    field it grows fails here.
    expect(JSON.stringify(cipher)).toBe(JSON.stringify({ publicKey: cipher.publicKey }));
    expect(JSON.stringify({ cipher })).toBe(
      JSON.stringify({ cipher: { publicKey: cipher.publicKey } }),
    );

    // 3. `util.inspect` takes neither route, so it needs its own hook — and a
    //    substring search cannot police it, since `inspect` pads and wraps a
    //    32-byte array across lines. Pin the whole rendering instead.
    expect(inspect(cipher, { depth: 5 })).toBe(
      `SealedBoxCipher { publicKey: '${cipher.publicKey}' }`,
    );

    // And what is left still says which key this is.
    expect(JSON.parse(JSON.stringify(cipher))).toEqual({ publicKey: cipher.publicKey });
    expect(inspect(cipher)).toContain(cipher.publicKey);
  });

  it("opens boxes addressed to its own key", () => {
    const mine = SealedBoxCipher.generate();
    const sender = new SealedBoxCipher(SealedBoxCipher.generate().privateKeyHex, {
      recipientPublicKey: mine.publicKey,
    });
    const payload = new TextEncoder().encode("a result");
    expect(new TextDecoder().decode(mine.decrypt(sender.encrypt(payload)))).toBe("a result");
  });

  it("accepts a recipient key in either spelling", () => {
    const mine = SealedBoxCipher.generate();
    const payload = new TextEncoder().encode("x");
    for (const spelling of [mine.publicKey, `0x${mine.publicKey}`]) {
      const sender = SealedBoxCipher.generate();
      sender.setRecipient(spelling);
      expect(new TextDecoder().decode(mine.decrypt(sender.encrypt(payload)))).toBe("x");
    }
  });

  it("refuses to encrypt with no recipient set — there is nothing to seal to", () => {
    expect(() => SealedBoxCipher.generate().encrypt(new Uint8Array(1))).toThrowError(/recipient/);
  });
});

describe("deriveResultCipher", () => {
  it("derives the key the Python SDK derives for the same wallet", async () => {
    const cipher = await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    // Cross-checked against vorq-client-sdk-python's derive_result_cipher.
    expect(cipher.publicKey).toBe(DERIVED_PUBLIC);
  });

  it("is stable across calls for one wallet", async () => {
    const signer = fakeSigner(PERSONAL_SIGN);
    const first = await deriveResultCipher(signer);
    const second = await deriveResultCipher(signer);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("fails loudly when a wallet derives a different key for the same address", async () => {
    // The RFC 6979 dependency made visible. A wallet that randomised its ECDSA
    // nonce would make previously sealed results permanently unreadable, and the
    // failure would otherwise be a silently useless key.
    await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    const drifted = `0x${"ab".repeat(65)}`;
    const rejection = () => deriveResultCipher(fakeSigner(drifted));
    await expect(rejection()).rejects.toBeInstanceOf(DerivedKeyMismatch);
    // The message *is* the remedy, so it is pinned like the throw itself: it
    // names the RFC 6979 root cause, the way out, and the key previously issued
    // — the one every already-sealed result is addressed to. A guard that threw
    // blank would tell the caller only that something, somewhere, was wrong.
    await expect(rejection()).rejects.toThrow(/RFC 6979[\s\S]*explicit cipher/);
    await expect(rejection()).rejects.toThrow(DERIVED_PUBLIC);
  });

  it("raises a mismatch the documented `instanceof VorqError` catch-all sees", async () => {
    // A wire or protocol condition descends from VorqError (errors.ts). It would
    // be a poor joke for the one error whose entire purpose is to be noticed to
    // be the one that slips past the handler written to notice errors.
    await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    const error = await deriveResultCipher(fakeSigner(`0x${"ab".repeat(65)}`)).then(
      () => null,
      (raised: unknown) => raised,
    );
    expect(error).toBeInstanceOf(DerivedKeyMismatch);
    expect(error).toBeInstanceOf(VorqError);
    expect((error as DerivedKeyMismatch).type).toBe("derived_key_mismatch");
    expect((error as DerivedKeyMismatch).name).toBe("DerivedKeyMismatch");
  });

  it("keys the guard on the address, so two wallets do not collide", async () => {
    await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const drifted = `0x${"ab".repeat(65)}` as Hex;
    const cipher = await deriveResultCipher(fakeSigner(drifted, other));
    // Not merely "something came back": the second wallet must get *its own*
    // key. A cache that answered from the first address's entry, or one that
    // handed back the first cipher, would still resolve to a truthy value.
    expect(cipher.publicKey).toBe(toHex(x25519.getPublicKey(bytes(keccak256(drifted)))));
    expect(cipher.publicKey).not.toBe(DERIVED_PUBLIC);
    // And the second address is now pinned to its own key, not to the first's.
    await expect(
      deriveResultCipher(fakeSigner(PERSONAL_SIGN, other)),
    ).rejects.toBeInstanceOf(DerivedKeyMismatch);
  });

  it("compares addresses case-insensitively — checksum casing is display-only", async () => {
    await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    await expect(
      deriveResultCipher(fakeSigner(`0x${"ab".repeat(65)}`, ADDRESS.toLowerCase())),
    ).rejects.toBeInstanceOf(DerivedKeyMismatch);
  });

  it("round-trips a result sealed to the derived key", async () => {
    const cipher = await deriveResultCipher(fakeSigner(PERSONAL_SIGN));
    const sender = SealedBoxCipher.generate();
    sender.setRecipient(cipher.publicKey);
    const sealed = sender.encrypt(new TextEncoder().encode('{"output":"hi"}'));
    expect(new TextDecoder().decode(cipher.decrypt(sealed))).toBe('{"output":"hi"}');
  });
});
