/**
 * libsodium's sealed box and secret box, in pure JavaScript.
 *
 * `crypto_box_seal` is the only primitive here with no library equivalent, so it
 * is written out. Every step is fixed by libsodium and none of it is a choice:
 * get the blake2b digest length or the concatenation order wrong and you produce
 * boxes libsodium cannot open, with no local symptom — the JS side round-trips
 * with itself perfectly and the provider that has to open it does not exist yet.
 *
 * ```
 * ephemeral X25519 keypair (epk, esk)
 * nonce  = blake2b(epk ‖ recipientPk, digest = 24 bytes)
 * sealed = epk ‖ crypto_box(message, nonce, recipientPk, esk)
 * ```
 */

import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, fromHex } from "./bytes.js";
import { SEAL_NONCE_BYTES, SECRETBOX_NONCE_BYTES } from "./domains.js";

const CURVE_KEY_BYTES = 32;
const EPK_BYTES = 32;

/** Salsa20's `"expand 32-byte k"` constant. */
const SIGMA = new Uint8Array([
  101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107,
]);

/** A 32-bit word view over a byte array, for `hsalsa`'s word-level signature. */
function words(bytes: Uint8Array): Uint32Array {
  // A copy, not a view: a subarray's byteOffset need not be 4-aligned, and
  // Uint32Array refuses an unaligned offset. `new Uint8Array(bytes)` always
  // allocates a fresh buffer at offset 0 for any input — `slice` does not,
  // since on a Node `Buffer` it is an alias for `subarray` and keeps the offset.
  const aligned = new Uint8Array(bytes);
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
}

/**
 * `crypto_box_beforenm`: the shared symmetric key.
 *
 * `HSalsa20(x25519(sk, pk), 16 zero bytes)` — not the raw X25519 output. Using
 * the shared secret directly produces a cipher that is self-consistent and is
 * not `crypto_box`.
 */
function beforenm(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  const out = new Uint32Array(8);
  hsalsa(words(SIGMA), words(shared), new Uint32Array(4), out);
  return new Uint8Array(out.buffer.slice(0));
}

/** `blake2b(epk ‖ recipientPk, 24)` — the seal's deterministic nonce. */
function sealNonce(ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  return blake2b(concat(ephemeralPublicKey, recipientPublicKey), { dkLen: SEAL_NONCE_BYTES });
}

/**
 * A 32-byte Curve25519 key from either spelling the protocol serves.
 *
 * `GET /evm/providers/:id` serves it `0x`-prefixed — every `bytes` column on
 * that wire is — while `GET /key` builds the escrow key by hand and serves it
 * bare. This is the one door both pass through, and in Python getting it wrong
 * was not a soft failure: the prefixed spelling died before a byte was posted
 * and a designated order could not be submitted at all. Whitespace is not one of
 * the two spellings.
 *
 * **Always a copy, never the caller's array.** Python's `bytes` are immutable so
 * the question does not arise upstream; here a returned view stays live, and a
 * caller who zeroes a seed buffer after handing it over — the correct thing to do
 * with key material — would silently leave the cipher holding an all-zero scalar.
 * The string branch allocated already; this makes ownership symmetric across both.
 */
export function normalizeCurveKey(key: string | Uint8Array): Uint8Array {
  if (key instanceof Uint8Array) {
    if (key.length !== CURVE_KEY_BYTES) {
      throw new Error(`a Curve25519 key is ${CURVE_KEY_BYTES} bytes, got ${key.length}`);
    }
    return Uint8Array.from(key);
  }
  if (typeof key !== "string" || !/^(?:0[xX])?[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("a Curve25519 key must be 32 bytes as hex (0x optional)");
  }
  return fromHex(key);
}

/** This key's Curve25519 public key. */
export function curvePublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(normalizeCurveKey(privateKey));
}

/** A fresh Curve25519 keypair. */
export function generateCurveKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * Seal `data` to a recipient's Curve25519 public key — an **anonymous** sealed
 * box.
 *
 * Only the recipient's public key is needed to write one, and only its secret
 * key can open it. That is what lets a designated order name a provider and an
 * open order name the coordinator's escrow key through the identical code path
 * — and it is also why the wrap alone cannot be an authorization, since anyone
 * can write one to any key.
 */
export function seal(recipientPublicKey: string | Uint8Array, data: Uint8Array): Uint8Array {
  const recipient = normalizeCurveKey(recipientPublicKey);
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const nonce = sealNonce(ephemeralPublic, recipient);
  const box = xsalsa20poly1305(beforenm(ephemeralSecret, recipient), nonce).encrypt(data);
  return concat(ephemeralPublic, box);
}

/**
 * Open a sealed box addressed to `privateKey`.
 *
 * The nonce is recomputed from the box's own leading 32 bytes and the
 * recipient's own public key — it is not carried, which is why the width is
 * fixed and why a truncated box is a refusal rather than a shorter plaintext.
 */
export function sealOpen(privateKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  const secret = normalizeCurveKey(privateKey);
  if (sealed.length <= EPK_BYTES) {
    throw new Error(`a sealed box is longer than its ${EPK_BYTES}-byte ephemeral key`);
  }
  const ephemeralPublic = sealed.subarray(0, EPK_BYTES);
  const nonce = sealNonce(ephemeralPublic, x25519.getPublicKey(secret));
  // `.slice()`: noble hands back a subarray at a nonzero byteOffset into its own
  // working buffer, so a consumer reaching for `.buffer` would see the whole box
  // rather than the plaintext. The seed goes straight into a KDF — hand over bytes
  // whose buffer is exactly the plaintext.
  return xsalsa20poly1305(beforenm(secret, ephemeralPublic), nonce)
    .decrypt(sealed.subarray(EPK_BYTES))
    .slice();
}

function requireBoxKey(key: Uint8Array): Uint8Array {
  if (key.length !== CURVE_KEY_BYTES) {
    throw new Error(`a secret-box key is ${CURVE_KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * XSalsa20-Poly1305 with the nonce **prepended**, exactly as `SecretBox.encrypt`
 * frames it — so the ciphertext is self-describing and the container needs no
 * framing beyond its version byte.
 *
 * `nonce` is a parameter only so a test can pin one. Production callers omit it.
 */
export function secretBoxEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  nonce?: Uint8Array,
): Uint8Array {
  const box = nonce ?? crypto.getRandomValues(new Uint8Array(SECRETBOX_NONCE_BYTES));
  if (box.length !== SECRETBOX_NONCE_BYTES) {
    throw new Error(`a secret-box nonce is ${SECRETBOX_NONCE_BYTES} bytes, got ${box.length}`);
  }
  return concat(box, xsalsa20poly1305(requireBoxKey(key), box).encrypt(data));
}

/** Open a nonce-prefixed secret box. */
export function secretBoxOpen(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (data.length < SECRETBOX_NONCE_BYTES) {
    throw new Error(
      `a secret box is at least its ${SECRETBOX_NONCE_BYTES}-byte nonce, got ${data.length}`,
    );
  }
  // `.slice()` for the same reason as `sealOpen` — see there.
  return xsalsa20poly1305(requireBoxKey(key), data.subarray(0, SECRETBOX_NONCE_BYTES))
    .decrypt(data.subarray(SECRETBOX_NONCE_BYTES))
    .slice();
}
