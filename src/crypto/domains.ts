/**
 * The constants three other implementations agree with byte for byte.
 *
 * Nothing here is a preference. Every value is either inside a hash the
 * coordinator, the provider daemon and the Python SDK each recompute, or it is
 * an offset one of them splits at. Changing one is changing the protocol.
 */

/**
 * Container v1. Byte 0 of every container and the first byte of `c`'s preimage,
 * so flipping it changes the commitment, changes the job id, and is caught
 * before a claim is spent.
 *
 * There is deliberately **no length field** in the bytes: the version implies the
 * wrap's kind and its width together. A length in the container is
 * attacker-supplied data needing validation on every parse; a width in the code
 * is a constant with nothing to lie about.
 */
export const CONTAINER_VERSION = 1;

/** The sealed plaintext's width. A **seed**, not a key — see `container.ts`. */
export const SEED_LEN = 32;

/**
 * The wrap's width: 32 bytes of ephemeral public key + 16 bytes of MAC + 32
 * bytes of plaintext. **Fixed width is what makes the split a split.**
 */
export const SEED_WRAP_BYTES = 80;

/**
 * The shortest thing that could be a container at all — the version byte and the
 * wrap. An empty ciphertext is well formed: `keccak256("")` is a real hash and
 * the vectors pin that case.
 */
export const MIN_CONTAINER_BYTES = 1 + SEED_WRAP_BYTES;

/**
 * The largest body the node's two byte-carrying doors read, in bytes.
 *
 * The node's `MAX_BODY_BYTES`. One ceiling for both doors, and the only number
 * here with a choice behind it — {@link INLINE_MAX_BYTES} is derived from it.
 */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * What the inline threshold leaves free for everything that is not content.
 *
 * The order, the payment and a 65-byte signature come to well under a KiB. The
 * reserve is far larger than that on purpose: reserving too much costs a
 * slightly lower threshold, while reserving too little means the client inlines
 * a payload the door then refuses with a `413`.
 */
export const ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * At or under this many sealed bytes, a container goes inline as base64; over
 * it, the client uploads first and posts `container_cid`.
 *
 * **Derived, not chosen.** This used to be a second constant, hand-written as
 * 7 MiB here, in the Python SDK, in the daemon and in the spec, with nothing
 * holding the four copies together — editing one of them left every suite
 * green while the parties silently disagreed about where the line was. It was
 * never a second decision: base64 costs a third again, which is the whole
 * reason a client cannot inline a body's worth of bytes into a body. So every
 * party computes it the same way from the same ceiling, and
 * `test/crosslang.test.ts` is what holds them to it.
 *
 * A container at this threshold encodes to exactly the room the reserve leaves
 * it: `4 · ceil(n/3) + ENVELOPE_RESERVE_BYTES === MAX_BODY_BYTES`.
 */
export const INLINE_MAX_BYTES = Math.floor((MAX_BODY_BYTES - ENVELOPE_RESERVE_BYTES) / 4) * 3;

/**
 * The HKDF `info` prefix, as **bytes**.
 *
 * A cross-language contract: the coordinator writes it
 * `Buffer.from("vorq-dek", "utf8")`, and a side that re-encoded or padded it
 * would derive a different key and fail only at runtime, in a provider, on a job
 * that is already paid for. It carries **no version** deliberately — the
 * container's version byte is the one version namespace, and seeds are freshly
 * random per job, so cross-version key confusion is impossible by construction.
 */
export const DEK_INFO_PREFIX: Uint8Array = new TextEncoder().encode("vorq-dek");

/**
 * RFC 5869's `salt` for this derivation: **zero length, explicitly**. §2.2 then
 * substitutes HashLen zero bytes, which is not the same thing as passing 32 zero
 * bytes as `ikm` and is not the same thing as omitting the argument in a library
 * whose default is something else.
 */
export const DEK_SALT: Uint8Array = new Uint8Array(0);

/** The fixed message a wallet signs to derive its result cipher (spec D11). */
export const DERIVATION_MESSAGE = "VORQ-ENC-V1";

/** Version tag of the sealed plaintext envelope `{v, owner, result_key, input}`. */
export const ENVELOPE_VERSION = "vorq-env-v1";

/** The tag a provider seals a result back under. */
export const SEALED_RESULT_VERSION = "vorq-sealed-v1";

/** `crypto_box_seal`'s blake2b nonce width. */
export const SEAL_NONCE_BYTES = 24;

/** XSalsa20-Poly1305's nonce width, prepended to every secret-box ciphertext. */
export const SECRETBOX_NONCE_BYTES = 24;
