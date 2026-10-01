/**
 * The package's byte primitives: concatenation, hex, base64. No caller needs
 * all three, and this comment enumerates no consumers — such a list goes stale
 * the next time one is added.
 *
 * **`toHex` below is the package's only hex encoder over a byte array.** That
 * is a checkable claim, not a wish: `src/signer/browser-wallet.ts` open-coded a
 * second one twice and now calls this. The single remaining `toString(16)` in
 * `src/` is `crypto/container.ts`, which formats one scalar version byte into
 * an error message — not an encoder over a buffer, and nothing hashes it.
 *
 * They live here rather than beside their callers because each of them had
 * grown a second copy, and a byte primitive with two copies is a byte primitive
 * with two chances to disagree: a `concat` that reordered its parts, or a hex
 * encoder that dropped a leading zero, changes bytes that go on the wire and
 * are hashed into a commitment. What this module offers is a definition every
 * caller can share — reach for it rather than open-coding the loop again.
 *
 * **Spelling is the caller's, not this module's.** `toHex` emits **bare**
 * lowercase hex with no `0x`, because that is the spelling `GET /key` serves and
 * the spelling `SealedBoxCipher.publicKey` returns; a caller that needs the
 * prefixed form writes the two characters itself, so the prefix is visible at
 * the site that requires it. `fromHex` accepts either.
 *
 * This module reads no configuration, holds no state and opens no socket.
 */

/** `parts` laid end to end, in the order given. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Bare lowercase hex — no `0x`, and every byte two characters wide.
 *
 * No `Buffer`: this module ships to browsers, where it does not exist.
 */
export function toHex(raw: Uint8Array): string {
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bytes from hex in either spelling. Refuses anything that is not hex. */
export function fromHex(value: string): Uint8Array {
  const raw = value.slice(0, 2).toLowerCase() === "0x" ? value.slice(2) : value;
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error("expected hex");
  }
  return raw.length === 0
    ? new Uint8Array(0)
    : Uint8Array.from(raw.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode base64 **strictly**: any character outside the alphabet, whitespace
 * included, and any length that is not a multiple of four, is refused with
 * `null` for the caller to shape into its own error.
 *
 * `atob` is lenient about padding, so the regex and the length check do the
 * refusing. A standard encoder never emits whitespace, so a value carrying a
 * newline did not come from one, and guessing which non-alphabet characters
 * were meant to be ignored is exactly the guess that produces empty bytes.
 */
export function fromBase64Strict(encoded: string): Uint8Array | null {
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return null;
  const binary = atob(encoded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/**
 * Bytes as base64, without `Buffer` — this package ships to browsers.
 *
 * Chunked: `String.fromCharCode(...raw)` on a 256 KiB container spreads a
 * quarter of a million arguments onto the call stack and throws.
 */
export function toBase64(raw: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < raw.length; offset += CHUNK) {
    binary += String.fromCharCode(...raw.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
