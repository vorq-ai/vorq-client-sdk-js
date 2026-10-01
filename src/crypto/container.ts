/**
 * Container v1 — the one byte layout a job's payload has on the wire.
 *
 * ```
 * container = version ‖ seed_wrap ‖ ciphertext   version   = 0x01, 1 byte
 *                                                seed_wrap = seal(recipient, SEED), 80 bytes
 * c         = keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))
 * job_id    = keccak256(owner ‖ c)
 * ```
 *
 * One payload, two recipients. The bulk is always encrypted under a 32-byte DEK;
 * a 32-byte secret is always sealed to somebody. Who that somebody is — the
 * provider named on a designated order, or the coordinator's escrow key on an
 * open one — is the only difference between the two order paths, and it is
 * invisible from outside the wrap.
 *
 * **The sealed 32 bytes are a SEED, and the DEK is derived from it.**
 *
 * ```
 * dek = HKDF-SHA256(ikm = seed, salt = "", info = "vorq-dek" ‖ owner20, L = 32)
 * ```
 *
 * The wrap is public — a container is fetched by CID by anyone who knows the
 * name — so an attacker can lift a victim's wrap verbatim, mint a fresh
 * commitment around it, post a dust order of their own and ask the escrow to
 * open it. Every field of that request is honest, so no check over public data
 * can refuse it. What refuses it is the derivation: whoever unseals a wrap
 * derives with **the job's owner as the chain reports it**, so the attacker's key
 * is derived under the attacker's address and does not open the victim's
 * ciphertext.
 *
 * **A client that seals the DEK directly still produces byte-perfect containers
 * and jobs no provider can decrypt** — nothing structural catches it, which is
 * why the test pins the KDF's inputs as arithmetic rather than as a round trip
 * through this module.
 *
 * Two properties are worth naming because they are what the layout buys. The
 * **ciphertext enters through its digest**, never directly, so the commitment
 * preimage is always exactly `1 + 80 + 32 = 113` bytes. And the **wrap is inside
 * the commitment**: a wrap lifted from another order over identical ciphertext
 * produces a different `c` and therefore a different job id.
 *
 * This module reads no configuration and opens no socket.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak256 } from "viem";
import { VorqError } from "../errors.js";
import { concat, fromHex, toHex } from "./bytes.js";
import {
  CONTAINER_VERSION,
  DEK_INFO_PREFIX,
  DEK_SALT,
  MIN_CONTAINER_BYTES,
  SEED_LEN,
  SEED_WRAP_BYTES,
} from "./domains.js";
import { seal, secretBoxEncrypt, secretBoxOpen } from "./sealed-box.js";

/**
 * Why a buffer is not a container — the node's own three-word vocabulary, so a
 * locally-caught refusal and a `400` naming `container` read the same.
 *
 * **`too_short` is the widest of the three and does not always mean short.** The
 * node answers it only for a genuinely undersized buffer; this module also uses
 * it for a `seed_wrap` of the wrong width, which may be too *long*. That is
 * deliberate rather than sloppy: the wrap is the offset every reader splits at,
 * so any wrap that is not exactly `SEED_WRAP_BYTES` yields a container that
 * means something else, and there is no fourth string on this wire to say so.
 * Python resolves it identically (`_container.py:139, 168, 338`). Minting a
 * `bad_width` here would put a code on a local refusal that no node and no other
 * SDK has ever answered with.
 */
export type ContainerFault = "too_short" | "bad_version" | "commitment_mismatch";

/**
 * A refusal to read or write container bytes.
 *
 * Descends from `VorqError`, as every wire-or-protocol condition does (see
 * `errors.ts` for where that line is drawn), so the documented catch-all —
 * `catch (e) { if (e instanceof VorqError) … }` — sees a `commitment_mismatch`
 * on the submit path rather than letting it escape as something unrecognized.
 * The base supplies `name` and `type`; only `fault` is this class's own.
 */
export class ContainerError extends VorqError {
  readonly fault: ContainerFault;
  constructor(fault: ContainerFault, message: string) {
    super(message, { type: "invalid_request_error" });
    this.fault = fault;
  }
}

const DEK_BYTES = 32;

/** A 32-byte word from raw bytes or `0x`-prefixed hex. */
function word32(value: Uint8Array | string): Uint8Array {
  const raw = typeof value === "string" ? fromHex(value) : value;
  if (raw.length !== 32) throw new Error(`expected a 32-byte word, got ${raw.length} bytes`);
  return raw;
}

/**
 * The owner as 20 **raw** bytes, never as a hex string.
 *
 * Checksum casing is display-only, so a derivation over the string form would
 * produce two different keys for one address depending on how a caller spelled
 * it — and the two sides of this protocol spell it differently: the client holds
 * a checksummed address, the coordinator reads a lowercase one off the chain.
 */
function ownerBytes(owner: Uint8Array | string): Uint8Array {
  const raw = typeof owner === "string" ? fromHex(owner) : owner;
  if (raw.length !== 20) {
    throw new Error(`owner must be a 20-byte address, got ${raw.length} bytes`);
  }
  return raw;
}

// -- layout ---------------------------------------------------------------------

/**
 * `version ‖ seed_wrap ‖ ciphertext`.
 *
 * The wrap width is asserted rather than trusted: it is the offset every reader
 * splits at, so a wrap of the wrong length does not produce a bad container, it
 * produces a container that means something else.
 */
export function buildContainer(seedWrap: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (seedWrap.length !== SEED_WRAP_BYTES) {
    throw new ContainerError(
      "too_short",
      `seed_wrap must be exactly ${SEED_WRAP_BYTES} bytes, got ${seedWrap.length}`,
    );
  }
  return concat(new Uint8Array([CONTAINER_VERSION]), seedWrap, ciphertext);
}

/**
 * Split at the offsets byte 0 names, or refuse.
 *
 * Length and version are checked **before** the split. `subarray` clamps out of
 * range instead of throwing, so without them an 80-byte buffer would sail
 * through and yield a plausible-looking commitment over a slice of garbage.
 */
export function splitContainer(container: Uint8Array): {
  seedWrap: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (container.length < MIN_CONTAINER_BYTES) {
    throw new ContainerError(
      "too_short",
      `a container is at least ${MIN_CONTAINER_BYTES} bytes — a version byte and an ` +
        `${SEED_WRAP_BYTES}-byte seed_wrap — and this one is ${container.length}`,
    );
  }
  if (container[0] !== CONTAINER_VERSION) {
    throw new ContainerError(
      "bad_version",
      `container byte 0 is 0x${container[0]!.toString(16).padStart(2, "0")}; this build reads ` +
        `0x${CONTAINER_VERSION.toString(16).padStart(2, "0")}`,
    );
  }
  return {
    seedWrap: container.subarray(1, 1 + SEED_WRAP_BYTES),
    ciphertext: container.subarray(1 + SEED_WRAP_BYTES),
  };
}

/**
 * `keccak256(version ‖ seed_wrap ‖ ct_hash)` — 32 bytes.
 *
 * Takes the ciphertext's *digest*, never the ciphertext: the preimage is 113
 * bytes for a one-byte payload and for a four-megabyte one alike. The version is
 * this build's own and is not a parameter — a caller holding a wrap and a digest
 * has exactly one layout those two pieces could belong to.
 */
export function commitment(seedWrap: Uint8Array, ctHash: Uint8Array): `0x${string}` {
  if (seedWrap.length !== SEED_WRAP_BYTES) {
    throw new ContainerError(
      "too_short",
      `a seed_wrap is exactly ${SEED_WRAP_BYTES} bytes, got ${seedWrap.length}`,
    );
  }
  if (ctHash.length !== 32) {
    throw new Error(`ct_hash must be a 32-byte keccak digest, got ${ctHash.length}`);
  }
  return keccak256(concat(new Uint8Array([CONTAINER_VERSION]), seedWrap, ctHash));
}

/** The commitment these container bytes reproduce (split, hash, commit). */
export function commitmentOf(container: Uint8Array): `0x${string}` {
  const { seedWrap, ciphertext } = splitContainer(container);
  return commitment(seedWrap, fromHex(keccak256(ciphertext)));
}

/**
 * Raise unless `container` is the payload `c` commits to.
 *
 * The mirror of the node's `assertCommitment`. The client builds containers
 * rather than receiving them, so this is a self-check on the way out — but it is
 * the same function the node runs on the way in, which is what makes the refusal
 * vectors assertable from this side.
 */
export function assertCommitment(container: Uint8Array, c: `0x${string}` | Uint8Array): void {
  const computed = commitmentOf(container);
  // `0x` written out here: `toHex` emits the bare spelling, and this comparison
  // is against `commitmentOf`'s prefixed one.
  const expected = `0x${toHex(word32(c))}`;
  if (computed !== expected) {
    throw new ContainerError(
      "commitment_mismatch",
      "the container does not reproduce c: " +
        `keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext)) is ${computed}. A job posted ` +
        "over bytes that miss their commitment is a job every provider refuses to claim, with " +
        "the escrow already committed",
    );
  }
}

/**
 * Client-owned job id: `keccak256(owner20 ‖ c32)`.
 *
 * **There is no inner hash here.** The digest of the payload already lives inside
 * `c`; taking another one would produce an id no other party computes.
 *
 * That this is client-computable is load-bearing rather than incidental: it is
 * what lets a client whose connection dropped mid-submission ask
 * `GET /v1/jobs/{id}` whether its job landed, instead of re-uploading the
 * container to find out.
 */
export function jobIdFor(owner: Uint8Array | string, c: `0x${string}` | Uint8Array): `0x${string}` {
  return keccak256(concat(ownerBytes(owner), word32(c)));
}

// -- the seed, the derivation, and the bulk cipher --------------------------------

/** A fresh 32-byte seed — the plaintext of the wrap, and not a key itself. */
export function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_LEN));
}

/**
 * `HKDF-SHA256(ikm=seed, salt="", info="vorq-dek" ‖ owner20, L=32)`.
 *
 * The one function in this SDK whose output nothing local can check. Both sides
 * of a job run it — this client to encrypt, and either the coordinator (open
 * path, deriving under the owner it reads from chain) or the provider
 * (designated path) to decrypt — and they never exchange the result. So the
 * inputs are the contract, and the test pins them arithmetically rather than by
 * calling this function twice.
 */
export function deriveDek(seed: Uint8Array, owner: Uint8Array | string): Uint8Array {
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes, got ${seed.length}`);
  }
  return hkdf(sha256, seed, DEK_SALT, concat(DEK_INFO_PREFIX, ownerBytes(owner)), DEK_BYTES);
}

/**
 * Seal the 32-byte **seed** to a Curve25519 public key — exactly
 * `SEED_WRAP_BYTES` bytes.
 *
 * The seed, not the DEK. Sealing the DEK produces byte-perfect containers and
 * jobs no provider can open, and nothing structural catches it.
 */
export function sealSeedTo(recipientPublicKey: string | Uint8Array, seed: Uint8Array): Uint8Array {
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes, got ${seed.length}`);
  }
  const wrap = seal(recipientPublicKey, seed);
  if (wrap.length !== SEED_WRAP_BYTES) {
    throw new ContainerError(
      "too_short",
      `sealed seed is ${wrap.length} bytes, expected ${SEED_WRAP_BYTES}`,
    );
  }
  return wrap;
}

/**
 * Encrypt `data` under a **given** DEK. Returns the ciphertext.
 *
 * The DEK is an argument rather than something minted here: it is derived from
 * the seed and the owner, so a function that generated its own would be a
 * function that could not produce a decryptable job. The nonce is prepended, so
 * the ciphertext is self-describing and the container needs no framing beyond
 * its version byte.
 */
export function encryptUnderDek(data: Uint8Array, dek: Uint8Array): Uint8Array {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  return secretBoxEncrypt(data, dek);
}

/** Open a DEK-encrypted payload. */
export function openDek(data: Uint8Array, dek: Uint8Array): Uint8Array {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  return secretBoxOpen(data, dek);
}
