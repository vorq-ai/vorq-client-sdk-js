/**
 * `BrowserWalletSigner` — a signer over an installed extension wallet.
 *
 * Raw EIP-1193 with EIP-6963 discovery, and no wallet-connection library. The
 * two entry points are published in this package's README, so they are a
 * contract rather than a convenience: `discover()` returns every announced
 * wallet, and `from(wallet)` prompts for accounts.
 */

import { getAddress, type Address, type Hex } from "viem";
import { toHex } from "../crypto/bytes.js";
import { VorqError } from "../errors.js";
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

/** No wallet is installed, or the wallet exposed no account. */
export class NoWalletError extends VorqError {
  constructor(message: string) {
    super(message, { type: "no_wallet" });
  }
}

/** The user declined the prompt — EIP-1193 error code 4001. */
export class WalletRejectedError extends VorqError {
  constructor(message: string) {
    super(message, { type: "wallet_rejected" });
  }
}

/** EIP-1193. The whole surface this SDK uses. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** EIP-6963's announcement payload. */
export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface DiscoveredWallet {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

export interface DiscoverOptions {
  /** Injected for tests; defaults to the real `window`. */
  window?: Window & { ethereum?: Eip1193Provider };
  /** How long to collect announcements. Wallets answer synchronously in practice. */
  timeoutMs?: number;
}

/** An EIP-712 `types` map as `terms.ts` spells it: `as const`, so deeply readonly. */
type TypedDataTypes = Record<string, readonly { readonly name: string; readonly type: string }[]>;

function rejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 4001;
}

/**
 * What a wallet handed back, if it is a signature at all.
 *
 * An unchecked cast is what makes a misbehaving wallet somebody else's bug: a
 * `null`, an object, or a string that is not whole bytes travels as a `Hex` and
 * fails much later — at the `keccak256` in the result cipher's derivation, or
 * inside a caller's own recovery — with a message about hex parsing and no
 * mention of the wallet that caused it. The wallet is named here, where it is
 * still known. No length is fixed: an ERC-1271 smart account answers with a
 * signature that is not 65 bytes.
 */
function asSignature(result: unknown, wallet: string, what: string): Hex {
  if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(result)) {
    // Not a `WalletRejectedError`: the user declined nothing. The wallet
    // answered, and what it answered is not a signature.
    throw new VorqError(
      `${wallet} answered the ${what} request with ` +
        `${typeof result === "string" ? JSON.stringify(result) : String(result)}, which is ` +
        "not a 0x-prefixed signature of whole bytes",
      { type: "invalid_wallet_response" },
    );
  }
  return result as Hex;
}

/** Re-raise a wallet's RPC object as one of this SDK's own errors. */
function wrap(error: unknown, what: string): never {
  if (rejected(error)) {
    throw new WalletRejectedError(`the wallet rejected ${what}`);
  }
  throw error;
}

/**
 * Flatten a typed-data payload for `eth_signTypedData_v4`, which takes a JSON
 * **string**: `bigint` has no JSON form and byte arrays must be hex.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    // `toHex` emits bare hex; the `0x` is written here, at the site that needs
    // it, which is the spelling contract `crypto/bytes.ts` documents.
    return `0x${toHex(value)}`;
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** UTF-8 bytes as `0x`-prefixed hex — what `personal_sign` wants on the wire. */
function utf8Hex(message: string): Hex {
  const bytes = new TextEncoder().encode(message);
  return `0x${toHex(bytes)}`;
}

/**
 * The `EIP712Domain` member list a wallet needs spelled out.
 *
 * viem derives it for a local account; `eth_signTypedData_v4` does not, and it
 * must list exactly the members the domain carries — the session's has no
 * `verifyingContract`.
 */
function domainType(domain: Record<string, unknown>): Array<{ name: string; type: string }> {
  const members: Array<{ name: string; type: string }> = [];
  if (domain.name !== undefined) members.push({ name: "name", type: "string" });
  if (domain.version !== undefined) members.push({ name: "version", type: "string" });
  if (domain.chainId !== undefined) members.push({ name: "chainId", type: "uint256" });
  if (domain.verifyingContract !== undefined) {
    members.push({ name: "verifyingContract", type: "address" });
  }
  return members;
}

export class BrowserWalletSigner implements Signer {
  readonly address: Address;
  readonly info: Eip6963ProviderInfo;
  private readonly provider: Eip1193Provider;

  private constructor(wallet: DiscoveredWallet, address: Address) {
    this.provider = wallet.provider;
    this.info = wallet.info;
    this.address = address;
  }

  /**
   * Every wallet the page can see.
   *
   * The listener attaches before the request event, because a wallet that
   * announced on load would otherwise be missed. `window.ethereum` is the
   * fallback for a wallet too old to announce; it is reported with an `unknown`
   * rdns rather than a guessed one.
   */
  static async discover(options: DiscoverOptions = {}): Promise<DiscoveredWallet[]> {
    // Own properties only on the caller's options record (`own.ts`). `window`
    // is the object the EIP-6963 discovery dispatch goes to and whose
    // `announceProvider` events are believed, so a prototype-supplied one
    // decides **which wallet ends up signing**; `timeoutMs` decides how long
    // honest wallets have to answer.
    const stated = <K extends keyof DiscoverOptions>(key: K): DiscoverOptions[K] =>
      own(options as Record<string, unknown>, key) as DiscoverOptions[K];
    // **The `globalThis` fallback is own-guarded too**, not just the option.
    // A previous round left this bare and justified it as "a realm with no
    // `window` has no wallet to steal". That is false: pollution does not
    // steal a wallet, it **manufactures** one — in Node, with
    // `Object.prototype.window` set, this returned a single `DiscoveredWallet`
    // whose `provider` was the attacker's object, and `BrowserWalletSigner.from`
    // would bind a signer to it and route every `eth_signTypedData_v4` through
    // it. A browser has an own `window` and is unaffected either way; guarded,
    // a realm without one answers `undefined` and `discover` returns `[]`,
    // which is the honest answer.
    const globalWindow = Object.hasOwn(globalThis, "window")
      ? (globalThis as { window?: DiscoverOptions["window"] }).window
      : undefined;
    const win = stated("window") ?? globalWindow;
    if (win === undefined) return [];

    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (event: Event): void => {
      const detail = (event as CustomEvent<DiscoveredWallet>).detail;
      if (detail?.info?.uuid && !found.has(detail.info.uuid)) found.set(detail.info.uuid, detail);
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    const timeoutMs = stated("timeoutMs") ?? 100;
    if (timeoutMs > 0) await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    win.removeEventListener("eip6963:announceProvider", onAnnounce);

    if (found.size === 0 && win.ethereum !== undefined) {
      return [
        {
          info: { uuid: "injected", name: "Injected Wallet", icon: "", rdns: "unknown" },
          provider: win.ethereum,
        },
      ];
    }
    return [...found.values()];
  }

  /** Prompt for accounts and bind the signer to the first one. */
  static async from(wallet: DiscoveredWallet): Promise<BrowserWalletSigner> {
    let accounts: unknown;
    try {
      accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
    } catch (error) {
      wrap(error, "the connection request");
    }
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof first !== "string") {
      throw new NoWalletError("the wallet exposed no account");
    }
    return new BrowserWalletSigner(wallet, getAddress(first));
  }

  private async signTyped(
    domain: Record<string, unknown>,
    types: TypedDataTypes,
    primaryType: string,
    message: Record<string, unknown>,
  ): Promise<Hex> {
    const payload = JSON.stringify(
      jsonSafe({
        domain,
        types: { EIP712Domain: domainType(domain), ...types },
        primaryType,
        message,
      }),
    );
    let result: unknown;
    try {
      result = await this.provider.request({
        method: "eth_signTypedData_v4",
        params: [this.address, payload],
      });
    } catch (error) {
      wrap(error, `the ${primaryType} signature`);
    }
    return asSignature(result, this.info.name, primaryType);
  }

  async signNonce(nonce: string, chainId: number): Promise<Hex> {
    return this.signTyped({ ...sessionDomain(chainId) }, SESSION_TYPES, "VorqSession", {
      address: this.address,
      nonce,
    });
  }

  async signMessage(message: string): Promise<Hex> {
    // `personal_sign` takes the message as hex; passing UTF-8 makes some wallets
    // hash the wrong bytes, and the derived result key then differs by wallet.
    let result: unknown;
    try {
      result = await this.provider.request({
        method: "personal_sign",
        params: [utf8Hex(message), this.address],
      });
    } catch (error) {
      wrap(error, "the key-derivation signature");
    }
    return asSignature(result, this.info.name, "personal_sign");
  }

  // The three chain-bound methods. The same typed data `PrivateKeySigner`
  // builds, routed through `signTyped` so the 4001 mapping and the
  // signature-shape guard apply to these prompts too. Each takes its
  // `ChainContext` explicitly: the two VORQ domains differ in exactly one
  // member — `verifyingContract` — so a signer that guessed would produce a
  // signature that recovers to a stranger.

  async signOrderV2(terms: OrderTerms, ctx: ChainContext): Promise<Hex> {
    return this.signTyped({ ...orderDomain(ctx) }, ORDER_TYPES, "Order", { ...terms.message() });
  }

  async signCancel(jobId: Hex, issuedAt: bigint, ctx: ChainContext): Promise<Hex> {
    return this.signTyped({ ...orderDomain(ctx) }, CANCEL_TYPES, "Cancel", { jobId, issuedAt });
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
    return this.signTyped(
      { ...paymentDomain(args.ctx) },
      RECEIVE_AUTHORIZATION_TYPES,
      "ReceiveWithAuthorization",
      {
        from: this.address,
        to: args.ctx.jobRegistry,
        value: args.amount,
        validAfter: 0n,
        // the token requires now < validBefore, and a claim may land exactly on expiresAt
        validBefore: args.expiresAt + 1n,
        nonce: args.jobId,
      },
    );
  }
}
