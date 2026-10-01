/**
 * `PrivateKeySigner` — the Node and standalone path, and the one the vector
 * tests run against.
 *
 * Use a dedicated wallet funded with your inference budget, never a main
 * wallet's key.
 */

import type { Address, Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  CANCEL_TYPES,
  ORDER_TYPES,
  RECEIVE_AUTHORIZATION_TYPES,
  sessionDomain,
  SESSION_TYPES,
  orderDomain,
  paymentDomain,
  type ChainContext,
  type OrderTerms,
} from "../terms.js";
import { own } from "../own.js";
import type { Signer } from "./types.js";

/**
 * The environment, if there is one.
 *
 * Reached through `globalThis` rather than as a bare environment reference:
 * this module is part of a browser bundle, and a bare reference is what makes a
 * bundler inject a `process` shim and smuggle a server-side lookup into a page.
 * In a browser this is simply `undefined` and the caller must pass a key.
 * (The guard test scans this file for the bare spelling, so this comment must
 * not write it either.)
 */
function envKey(name: string): string | undefined {
  // **An environment is a record, and every hop to it is read own-properties
  // only** (`own.ts`). This was missed by a sweep that drew its scope at
  // records off `JSON.parse` and never asked whether an environment is one: an
  // **unset** variable is answered by `Object.prototype`, so with the variable
  // unset — the ordinary case — a polluted prototype supplies the value this
  // function returns, on the default construction path, with no other
  // precondition.
  //
  // The `globalThis` hop is guarded for the same reason one layer up: a browser
  // realm has no own `process`, so a bare read there would let a polluted
  // prototype **manufacture an environment** where the paragraph above promises
  // there is none. Guarded, the browser answer is `undefined`, which is exactly
  // what that paragraph says it should be.
  const proc = Object.hasOwn(globalThis, "process")
    ? (globalThis as { process?: unknown }).process
    : undefined;
  if (typeof proc !== "object" || proc === null) return undefined;
  const env = own(proc as Record<string, unknown>, "env");
  if (typeof env !== "object" || env === null) return undefined;
  const value = own(env as Record<string, unknown>, name);
  return typeof value === "string" ? value : undefined;
}

export interface PrivateKeySignerOptions {
  /** The env var consulted when no key is passed. Node only. */
  keyEnv?: string;
}

/** A signer over `$VORQ_WALLET_KEY`, or `null` where it is unset (and in a browser). */
export function envWalletSigner(): PrivateKeySigner | null {
  return envKey("VORQ_WALLET_KEY") ? new PrivateKeySigner() : null;
}

export class PrivateKeySigner implements Signer {
  readonly address: Address;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey?: string, options: PrivateKeySignerOptions = {}) {
    // Own properties only on the caller's options record (`own.ts`): a
    // polluted `Object.prototype.keyEnv` sends this constructor looking for the
    // wallet key in an environment variable the caller never named.
    const keyEnv =
      (own(options as Record<string, unknown>, "keyEnv") as string | undefined) ??
      "VORQ_WALLET_KEY";
    const key = privateKey ?? envKey(keyEnv);
    if (!key) {
      throw new Error(`no wallet key: pass privateKey or set $${keyEnv}`);
    }
    this.account = privateKeyToAccount(
      (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    );
    this.address = this.account.address;
  }

  /** A signer over a freshly generated wallet (tests, ephemeral use). */
  static generate(): PrivateKeySigner {
    return new PrivateKeySigner(generatePrivateKey());
  }

  async signNonce(nonce: string, chainId: number): Promise<Hex> {
    return this.account.signTypedData({
      domain: sessionDomain(chainId),
      types: SESSION_TYPES,
      primaryType: "VorqSession",
      message: { address: this.address, nonce },
    });
  }

  async signMessage(message: string): Promise<Hex> {
    return this.account.signMessage({ message });
  }

  // The three chain-bound methods. Each takes its `ChainContext` explicitly:
  // the two VORQ domains differ in exactly one member — `verifyingContract` —
  // so a signer that guessed would produce a signature that recovers to a
  // stranger and is refused by nothing until the chain refuses it.

  async signOrderV2(terms: OrderTerms, ctx: ChainContext): Promise<Hex> {
    return this.account.signTypedData({
      domain: orderDomain(ctx),
      types: ORDER_TYPES,
      primaryType: "Order",
      message: terms.message(),
    });
  }

  async signCancel(jobId: Hex, issuedAt: bigint, ctx: ChainContext): Promise<Hex> {
    return this.account.signTypedData({
      domain: orderDomain(ctx),
      types: CANCEL_TYPES,
      primaryType: "Cancel",
      message: { jobId, issuedAt },
    });
  }

  /**
   * The escrow payment: EIP-3009 `ReceiveWithAuthorization`.
   *
   * Only the payee — the JobRegistry — can execute it, so a signature that
   * leaked authorizes nobody else; `nonce` is the job id, so the token's own
   * nonce table makes it single-use.
   */
  async signPaymentAuthorization(args: {
    amount: bigint;
    jobId: Hex;
    expiresAt: bigint;
    ctx: ChainContext;
  }): Promise<Hex> {
    return this.account.signTypedData({
      domain: paymentDomain(args.ctx),
      types: RECEIVE_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: this.address,
        to: args.ctx.jobRegistry,
        value: args.amount,
        validAfter: 0n,
        // the token requires now < validBefore, and a claim may land exactly on expiresAt
        validBefore: args.expiresAt + 1n,
        nonce: args.jobId,
      },
    });
  }
}
