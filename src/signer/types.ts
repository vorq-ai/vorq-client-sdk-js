/**
 * The signer and cipher interfaces.
 *
 * **`Signer` is asynchronous, and that is the port's decisive divergence.**
 * Python's protocol is synchronous because it holds the key in-process; here a
 * wallet prompt is a promise, and every call site is shaped by it.
 *
 * `Cipher` stays synchronous: sealing needs no wallet.
 */

import type { Address, Hex } from "viem";
import type { ChainContext, OrderTerms } from "../terms.js";

/**
 * Holds the wallet key; signs orders and session nonces.
 *
 * Every chain-bound method takes the `ChainContext` explicitly. There is no
 * default deployment and no ambient one: the two VORQ domains differ only in
 * `verifyingContract`, so a signer that guessed would produce a signature that
 * recovers to a stranger and is refused by nothing until the chain refuses it.
 */
export interface Signer {
  readonly address: Address;

  signOrderV2(terms: OrderTerms, ctx: ChainContext): Promise<Hex>;

  signCancel(jobId: Hex, issuedAt: bigint, ctx: ChainContext): Promise<Hex>;

  /** The escrow payment. Every member but `amount` is derived from the order and the context. */
  signPaymentAuthorization(args: {
    amount: bigint;
    jobId: Hex;
    expiresAt: bigint;
    ctx: ChainContext;
  }): Promise<Hex>;

  /** Sign a session-handshake nonce under the off-chain domain of `chainId` — the deployment's, from `GET /auth/nonce`. */
  signNonce(nonce: string, chainId: number): Promise<Hex>;

  /**
   * EIP-191 `personal_sign`.
   *
   * Python has no equivalent on its protocol — `derive_result_cipher` reaches
   * into the account's private key directly, and a wallet has no exposed key.
   * `deriveResultCipher` (spec `04`) is this method's only caller, and the two
   * implementations must produce identical bytes for the same input or the
   * derived result key differs by runtime.
   */
  signMessage(message: string): Promise<Hex>;
}

/**
 * Seals and opens end-to-end payloads. Implemented by spec `04`'s
 * `SealedBoxCipher`.
 */
export interface Cipher {
  /**
   * This cipher's Curve25519 public key as 64 lowercase hex characters,
   * **bare** — no `0x`. That is the spelling `GET /key` serves and the spelling
   * Python's `SealedBoxCipher.public_key` returns.
   */
  readonly publicKey: string;

  /**
   * Seal to a recipient **this interface cannot set**.
   *
   * That is not an oversight and it is not fixed by widening the interface:
   * Python's `Cipher` protocol (`vorq/_crypto.py:270-278`) has exactly these
   * three members and no `set_recipient` either, and its `SealedBoxCipher`
   * raises the same refusal on a null recipient. A recipient is set on the
   * concrete class — `new SealedBoxCipher(key, { recipientPublicKey })` or
   * `setRecipient()` — so a value typed only as `Cipher`, `Client.cipher`
   * included, has an `encrypt` that throws until somebody who holds the
   * concrete instance points it somewhere.
   *
   * **Nothing in this SDK calls it.** Sealing a seed to a provider or to the
   * coordinator's escrow is `sealSeedTo(recipientPublicKey, seed)`, which takes
   * its recipient as an argument and never touches a `Cipher`; the protocol is
   * reached only through `decrypt`, to open a result sealed to the caller's own
   * key. `encrypt` is here so the protocol is symmetric and so a caller with a
   * concrete cipher can seal with it.
   */
  encrypt(data: Uint8Array): Uint8Array;

  /** Open a box addressed to this cipher's own key. The member the SDK uses. */
  decrypt(data: Uint8Array): Uint8Array;
}
