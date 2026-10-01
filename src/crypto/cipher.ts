/**
 * The end-to-end cipher: a Curve25519 sealed-box keypair, and the wallet-derived
 * key results come back sealed to.
 */

import { hexToBytes, keccak256 } from "viem";
import { VorqError } from "../errors.js";
import { own } from "../own.js";
import type { Cipher, Signer } from "../signer/types.js";
import { toHex } from "./bytes.js";
import { DERIVATION_MESSAGE } from "./domains.js";
import {
  curvePublicKey,
  generateCurveKeyPair,
  normalizeCurveKey,
  seal,
  sealOpen,
} from "./sealed-box.js";

/**
 * A wallet derived a different key for an address it had already derived one for.
 *
 * Raised rather than swallowed: a silently re-issued key opens nothing that was
 * sealed to the first one, and the caller learns that only when a result they
 * have already paid for turns out to be unreadable.
 *
 * A `VorqError`, as every wire-or-protocol condition is (see `errors.ts`), so
 * the documented `catch (e) { if (e instanceof VorqError) ... }` catch-all sees
 * it. It would be a poor joke for the one error whose entire purpose is to be
 * noticed to be the one that slipped past the handler written to notice errors.
 */
export class DerivedKeyMismatch extends VorqError {
  constructor(message: string) {
    // `name` is not set here: `VorqError` derives it from `new.target`.
    super(message, { type: "derived_key_mismatch" });
  }
}

/**
 * A libsodium sealed-box cipher over a Curve25519 keypair.
 *
 * `encrypt` seals to `recipientPublicKey` (required to encrypt); `decrypt` opens
 * boxes addressed to this cipher's own key.
 */
export class SealedBoxCipher implements Cipher {
  /**
   * A real ECMAScript private field, not TypeScript's compile-time `private`.
   *
   * The difference is the whole point: a `private readonly` property is an
   * ordinary own key at runtime, so `Object.keys(cipher)` lists it,
   * `JSON.stringify(cipher)` serializes it, and a bare `console.log(cipher)` or
   * any structured logger holding an object that holds a cipher writes out the
   * scalar that opens every result ever sealed to this wallet. A `#` field is
   * not an own key and is not enumerable by any of them.
   *
   * `toJSON` and the inspect hook below close the two remaining doors, since a
   * class with no own keys still prints `{}` rather than something useful.
   */
  #privateKey: Uint8Array;
  private recipient: Uint8Array | null;

  constructor(
    privateKey: Uint8Array | string,
    options: { recipientPublicKey?: string | Uint8Array } = {},
  ) {
    this.#privateKey = normalizeCurveKey(privateKey);
    // **Own properties only on the options record** (`own.ts`), and `===
    // undefined` is not a substitute on its own: an inherited property is not
    // undefined. This value decides **who `encrypt` seals to**, which is the
    // first of the categories the package rule exists for. `SealedBoxCipher`
    // and `deriveResultCipher` are both on the barrel and `fromSeed` reaches
    // this constructor with `options` defaulting to `{}`, so read bare a
    // polluted `Object.prototype.recipientPublicKey` points **every derived
    // result cipher** at a key the caller never named — and a value
    // `normalizeCurveKey` refuses throws out of `deriveResultCipher` for every
    // wallet-backed client instead.
    const recipientPublicKey = own(options as Record<string, unknown>, "recipientPublicKey") as
      | string
      | Uint8Array
      | undefined;
    this.recipient =
      recipientPublicKey === undefined
        ? null
        : // The same normalization `seal` applies, and for the same reason: a
          // recipient key is a public value that reaches a caller in either
          // spelling, and the two doors that seal to one must not disagree.
          normalizeCurveKey(recipientPublicKey);
  }

  /** A cipher over a freshly generated keypair (tests, ephemeral use). */
  static generate(): SealedBoxCipher {
    return new SealedBoxCipher(generateCurveKeyPair().privateKey);
  }

  /**
   * Build a cipher from 32 bytes of secret seed material.
   *
   * The seed **is** the Curve25519 scalar, so the same seed always yields the
   * same keypair — that is what makes `deriveResultCipher` reproducible.
   */
  static fromSeed(seed: Uint8Array): SealedBoxCipher {
    return new SealedBoxCipher(seed.subarray(0, 32));
  }

  /**
   * This cipher's Curve25519 public key — 64 lowercase hex, **bare**. Share it
   * to receive. That is the spelling `GET /key` serves and the spelling the
   * Python SDK returns.
   */
  get publicKey(): string {
    return toHex(curvePublicKey(this.#privateKey));
  }

  /** The private scalar as hex, for handing to a second cipher instance. */
  get privateKeyHex(): string {
    return toHex(this.#privateKey);
  }

  /** Point this cipher at a recipient. Accepts either key spelling. */
  setRecipient(recipientPublicKey: string | Uint8Array): void {
    this.recipient = normalizeCurveKey(recipientPublicKey);
  }

  /**
   * Seal to the recipient set on this instance.
   *
   * Reachable only on a concrete `SealedBoxCipher`: the `Cipher` interface
   * carries no way to set a recipient, so a value typed as `Cipher` — including
   * `Client.cipher` — has an `encrypt` that throws. **The SDK's own sealing path
   * does not go through here**; sealing a seed to a provider or to the escrow is
   * `sealSeedTo(recipientPublicKey, seed)` in `crypto/container.ts`, which takes
   * its recipient as an argument. See the note on `Cipher.encrypt`.
   */
  encrypt(data: Uint8Array): Uint8Array {
    if (this.recipient === null) {
      throw new Error("no recipientPublicKey set: nothing to seal to");
    }
    return seal(this.recipient, data);
  }

  decrypt(data: Uint8Array): Uint8Array {
    return sealOpen(this.#privateKey, data);
  }

  /**
   * What `JSON.stringify` sees: the public half and nothing else.
   *
   * Without this a cipher inside any serialized object is `{}` — harmless — but
   * the field it hides is the one that must never be written anywhere, so the
   * safe answer is stated rather than left to the absence of own keys.
   */
  toJSON(): { publicKey: string } {
    return { publicKey: this.publicKey };
  }

  /** What `console.log` and `util.inspect` see, for the same reason. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SealedBoxCipher { publicKey: '${this.publicKey}' }`;
  }
}

/**
 * The derived public key already issued per address.
 *
 * Module-level and process-lived. Its whole job is to notice a wallet that
 * derives twice and disagrees.
 */
const derivedKeys = new Map<string, string>();

/** Tests only. */
export function resetDerivedKeyCache(): void {
  derivedKeys.clear();
}

/**
 * The wallet-derived result cipher (spec D11): X25519 from `keccak256` of a
 * deterministic signature over `DERIVATION_MESSAGE`.
 *
 * **Reproducibility rests entirely on RFC 6979 deterministic ECDSA.** That is
 * true of every wallet in practice and is guaranteed by no specification: a
 * wallet that randomised its nonce would make previously sealed results
 * permanently unreadable. Hence the guard below, and hence the caller-supplied
 * `cipher` override — a convenience in the Python SDK, load-bearing here.
 *
 * `signMessage` is EIP-191 `personal_sign`. The wallet path calls that RPC
 * method and the local path calls viem's `signMessage`; the two must produce
 * identical bytes for the same input, or the derived key differs by runtime and
 * a browser cannot open a result a Node client sealed.
 */
export async function deriveResultCipher(
  signer: Pick<Signer, "address" | "signMessage">,
): Promise<SealedBoxCipher> {
  const signature = await signer.signMessage(DERIVATION_MESSAGE);
  const scalar = keccak256(signature);
  const cipher = SealedBoxCipher.fromSeed(hexToBytes(scalar));

  // Checksum casing is display-only, so the cache is keyed on the bytes' one
  // spelling.
  const key = signer.address.toLowerCase();
  const seen = derivedKeys.get(key);
  if (seen !== undefined && seen !== cipher.publicKey) {
    throw new DerivedKeyMismatch(
      `the wallet ${signer.address} derived result key ${cipher.publicKey}, having previously ` +
        `derived ${seen}. The derivation depends on deterministic ECDSA nonces (RFC 6979); a ` +
        "wallet that does not honour them cannot hold a stable result key, and results already " +
        "sealed to the first key would be unreadable. Pass an explicit cipher instead.",
    );
  }
  derivedKeys.set(key, cipher.publicKey);
  return cipher;
}
