/**
 * The chain context, the EIP-712 domains, and the shape of an order's terms.
 *
 * `ChainContext` is the deployment a signature belongs to. It is read once from
 * `GET /evm/chain` and cached for the client's life, and it carries **all four**
 * contract addresses the node serves. Three are addresses this SDK itself uses;
 * `providerRegistry` is not, and it is carried anyway, because the two VORQ
 * domains differ in exactly one member — `verifyingContract` — so a context that
 * dropped it would leave a consumer guessing between two separators that share a
 * name and a version. A wrong `verifyingContract` does not raise: it produces a
 * signature that recovers to a stranger, which nothing on the wire can tell from
 * a forgery.
 *
 * This module opens no socket and reads no configuration.
 */

import type { Address, Hex, TypedDataDomain } from "viem";
import { ValidationError } from "./errors.js";
import { formatUsd, parseUsd } from "./money.js";
import { own } from "./own.js";

/** The registries' domain. Name and version are shared; the address is the difference. */
export const ORDER_DOMAIN_NAME = "VORQ Jobs";
export const REGISTRY_DOMAIN_NAME = "VORQ Providers";
export const ORDER_DOMAIN_VERSION = "2";

/** The four addresses `GET /evm/chain` serves. All four are required. */
export const CONTRACT_FIELDS = [
  "job_registry",
  "provider_registry",
  "ask_registry",
  "usdc",
] as const;

export const UINT64_MAX = 2n ** 64n - 1n;

function address(value: unknown, field: string): Address {
  if (typeof value !== "string") {
    throw new ValidationError(`GET /evm/chain: contracts.${field} is not a string`, {
      type: "invalid_request_error",
    });
  }
  const raw = value.slice(0, 2).toLowerCase() === "0x" ? value.slice(2) : value;
  if (raw.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ValidationError(
      `GET /evm/chain: contracts.${field} is not a 20-byte hex address`,
      { type: "invalid_request_error" },
    );
  }
  // Casing is preserved, not checksummed: an EVM address is a case-insensitive
  // identifier and the node's own spelling is the one to echo back.
  return `0x${raw}` as Address;
}

/**
 * A bounded unsigned integer from a JSON integer.
 *
 * Every integer on this wire is a JSON number no larger than
 * `Number.MAX_SAFE_INTEGER`; a string, a float or a boolean is refused.
 */
function uint(value: unknown, field: string, ceiling: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new ValidationError(
      `${field} must be a JSON integer in [0, ${ceiling}], got ${JSON.stringify(value)}`,
      { type: "invalid_request_error" },
    );
  }
  return value;
}

/**
 * The deployment every signature in this SDK belongs to.
 *
 * Frozen on purpose: it is cached for the client's lifetime and handed to every
 * signing call, so a mutable copy would let one caller's edit re-target another
 * caller's signature at a contract it never meant to authorize.
 */
export class ChainContext {
  readonly chainId: number;
  readonly jobRegistry: Address;
  readonly providerRegistry: Address;
  readonly askRegistry: Address;
  readonly usdc: Address;
  /** The payment token's own decimals: the shift between a USD string and atomic units. */
  readonly decimals: number;
  /** The payment token's EIP-712 name and version. Both differ per network. */
  readonly tokenDomain: Readonly<{ name: string; version: string }>;
  /** Protocol fee in basis points, charged on top of a settled charge. Display only. */
  readonly feeBps: number;

  constructor(fields: {
    chainId: number;
    jobRegistry: Address;
    providerRegistry: Address;
    askRegistry: Address;
    usdc: Address;
    decimals: number;
    tokenDomain: { name: string; version: string };
    feeBps: number;
  }) {
    this.chainId = fields.chainId;
    this.jobRegistry = fields.jobRegistry;
    this.providerRegistry = fields.providerRegistry;
    this.askRegistry = fields.askRegistry;
    this.usdc = fields.usdc;
    this.decimals = fields.decimals;
    // Frozen separately: a frozen context holding a mutable record would let one
    // caller re-name the token every later payment is signed under.
    this.tokenDomain = Object.freeze({ ...fields.tokenDomain });
    this.feeBps = fields.feeBps;
    Object.freeze(this);
  }

  /**
   * Parse `GET /evm/chain`. Every one of the four must be present.
   *
   * `head_block` and `block_time_ms` are on that body and are
   * deliberately not read.
   */
  static fromWire(payload: unknown): ChainContext {
    if (typeof payload !== "object" || payload === null) {
      throw new ValidationError("GET /evm/chain did not answer an object", {
        type: "invalid_request_error",
      });
    }
    // **Own properties only on this body and its `contracts` block** — the
    // package rule (`own.ts`), and it guards a *signing domain*. Every one of
    // the four addresses below is signed against: `usdc` is the
    // `verifyingContract` of the payment authorization this client puts its
    // signature on. Read bare, a `/evm/chain` answer that omits `usdc` is
    // answered by a polluted `Object.prototype.usdc` — and the presence
    // check on the line below is answered by the same prototype, so it does not
    // fire. Same shape as the `box_key` read in `client.ts`: a presence guard
    // and a value read that both walk the chain.
    const body = payload as Record<string, unknown>;
    const contracts = own(body, "contracts");
    if (typeof contracts !== "object" || contracts === null) {
      throw new ValidationError("GET /evm/chain answered no contracts block", {
        type: "invalid_request_error",
      });
    }
    const block = contracts as Record<string, unknown>;
    const stated = (field: string): unknown => own(block, field);
    const missing = CONTRACT_FIELDS.filter((f) => stated(f) === undefined || stated(f) === null);
    if (missing.length > 0) {
      throw new ValidationError(
        `GET /evm/chain is missing contract ${missing.join(", ")}: this client needs all four`,
        { type: "invalid_request_error" },
      );
    }
    const chainId = uint(own(body, "chain_id"), "chain_id", Number.MAX_SAFE_INTEGER);
    const decimals = uint(own(body, "decimals"), "decimals", 36);
    const tokenDomainMember = own(body, "token_domain");
    if (typeof tokenDomainMember !== "object" || tokenDomainMember === null) {
      throw new ValidationError("GET /evm/chain answered no token_domain", {
        type: "invalid_request_error",
      });
    }
    const domainText = (key: "name" | "version"): string => {
      const value = own(tokenDomainMember as Record<string, unknown>, key);
      if (typeof value !== "string" || value === "") {
        throw new ValidationError(`GET /evm/chain: token_domain.${key} must be a non-empty string`, {
          type: "invalid_request_error",
        });
      }
      return value;
    };
    return new ChainContext({
      chainId,
      feeBps: uint(own(body, "fee_bps"), "fee_bps", 1000),
      jobRegistry: address(stated("job_registry"), "job_registry"),
      providerRegistry: address(stated("provider_registry"), "provider_registry"),
      askRegistry: address(stated("ask_registry"), "ask_registry"),
      usdc: address(stated("usdc"), "usdc"),
      decimals,
      tokenDomain: { name: domainText("name"), version: domainText("version") },
    });
  }

  /** The four addresses, keyed as the node keys them. */
  get contracts(): Readonly<Record<(typeof CONTRACT_FIELDS)[number], Address>> {
    return {
      job_registry: this.jobRegistry,
      provider_registry: this.providerRegistry,
      ask_registry: this.askRegistry,
      usdc: this.usdc,
    };
  }
}

/**
 * The off-chain session domain, bound to the deployment's chain.
 *
 * A session is never submitted anywhere; the coordinator verifies it against a
 * nonce minted in its own database, which is what prevents replay. Version `1`
 * against the on-chain artifacts' `2`, with no `verifyingContract` at all, keeps
 * a login in a namespace the chain will never accept.
 *
 * `chainId` is the deployment's, announced by `GET /auth/nonce` as `chain_id`.
 * It used to be pinned at 1, and a browser wallet refuses to sign a typed-data
 * domain whose chain is not the one it is on — MetaMask: "Provided chainId 1
 * must match the active chainId 84532" (measured 2026-09-24) — so the pin locked
 * every real wallet out of the console.
 */
export const SESSION_DOMAIN = Object.freeze({
  name: "VORQ Session",
  version: "1",
} as const);

export function sessionDomain(chainId: number): TypedDataDomain {
  return Object.freeze({ ...SESSION_DOMAIN, chainId });
}

/** The JobRegistry's domain — `Order` and `Cancel` both live here. */
export function orderDomain(ctx: ChainContext): TypedDataDomain {
  return {
    name: ORDER_DOMAIN_NAME,
    version: ORDER_DOMAIN_VERSION,
    chainId: ctx.chainId,
    verifyingContract: ctx.jobRegistry,
  };
}

/**
 * The ProviderRegistry's domain. Nothing in this SDK signs a registry op — that
 * is the provider daemon's half — but the address is on the context, so the
 * difference between the two domains is a fact this package can state and test
 * rather than a comment.
 */
export function registryDomain(ctx: ChainContext): TypedDataDomain {
  return {
    name: REGISTRY_DOMAIN_NAME,
    version: ORDER_DOMAIN_VERSION,
    chainId: ctx.chainId,
    verifyingContract: ctx.providerRegistry,
  };
}

/** The payment token's own EIP-712 domain. Name and version differ per network, so they are the node's. */
export function paymentDomain(ctx: ChainContext): TypedDataDomain {
  return {
    name: ctx.tokenDomain.name,
    version: ctx.tokenDomain.version,
    chainId: ctx.chainId,
    verifyingContract: ctx.usdc,
  };
}

// -- the signed types -----------------------------------------------------------
//
// Single source of truth for what a contract verifies. Changing any name or type
// here changes the signatures on the wire, and `test/vectors/signing-v3.json` —
// generated by the contracts themselves — is what says so out loud.

export const SESSION_TYPES = {
  VorqSession: [
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * `Order` — the contract's own type, member for member, at the contract's own
 * widths.
 *
 * **There is no `taskCid` member.** The contract stores one on the row and does
 * not hash it, because the coordinator mints the name when it pins and the
 * client cannot know it at signing time. There is no job id either — the chain
 * derives that from the recovered signer and `c` — and no result key, which
 * travels sealed inside the payload. `signing-v3.json`'s `order-designated` case
 * carries a `task_cid` beside the message for exactly this reason: an
 * implementation that folds it in fails there and nowhere else.
 */
export const ORDER_TYPES = {
  Order: [
    { name: "c", type: "bytes32" },
    { name: "modelId", type: "uint32" },
    { name: "slaSecs", type: "uint32" },
    { name: "rateIn", type: "uint128" },
    { name: "rateOut", type: "uint128" },
    { name: "unitsIn", type: "uint32" },
    { name: "unitsOut", type: "uint32" },
    { name: "designated", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** `Cancel(bytes32 jobId,uint64 issuedAt)` — the owner's withdrawal. */
export const CANCEL_TYPES = {
  Cancel: [
    { name: "jobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/**
 * The escrow payment: EIP-3009 `ReceiveWithAuthorization`. Only the payee — the JobRegistry — can
 * execute it, `nonce` is the job id, and it is valid through the order's `expiresAt`.
 */
export const RECEIVE_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const UINT32_MAX = 0xff_ff_ff_ff;
export const UINT128_MAX = 2n ** 128n - 1n;

/**
 * `JobRegistry.RATE_SCALE`. Rates are atomic token units per this many units
 * of work, so a cap is a ceiling division by it and never a float.
 */
export const RATE_SCALE = 1_000_000n;

/**
 * A bounded unsigned integer from a `number` or a `bigint`.
 *
 * The non-integer check runs **before** the value is coerced, not after: a
 * `Math.trunc` ahead of the check would silently swallow a fractional
 * `number` into a whole `bigint`, and the caller would never see the mistake.
 */
function checkUint(value: number | bigint, field: string, ceiling: bigint): void {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number, got ${value}`, {
      type: "invalid_request_error",
    });
  }
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > ceiling) {
    throw new ValidationError(`${field} must be in [0, ${ceiling}], got ${parsed}`, {
      type: "invalid_request_error",
    });
  }
}

/**
 * A rate — USD per 1M units of work, as a decimal string — in atomic token units
 * per `RATE_SCALE` units, defaulting to zero.
 *
 * `RATE_SCALE` is 10^6 units, so the conversion is the plain USD one:
 * `"0.05"` at 6 decimals signs `50000`. A number or a bigint is refused rather
 * than guessed at: it could be dollars or atomic units, and the two differ by
 * `10^decimals`. A fraction finer than the token carries is refused, never
 * rounded.
 */
export function parseRate(value: unknown, field: string, decimals: number): bigint {
  if (value === null || value === undefined) return 0n;
  const refuse = (detail: string): never => {
    throw new ValidationError(
      `${field}=${typeof value === "bigint" ? `${value}n` : JSON.stringify(value)} is not a rate: ` +
        `a rate is USD per 1M units as a decimal string, e.g. "0.05"${detail}`,
      { type: "invalid_request_error" },
    );
  };
  if (typeof value !== "string") return refuse("");
  let atomic: bigint;
  try {
    atomic = parseUsd(value, decimals);
  } catch (error) {
    return refuse(` (${(error as Error).message})`);
  }
  if (atomic > UINT128_MAX) return refuse(" (past the chain's uint128)");
  return atomic;
}

export interface OrderTermsFields {
  c: `0x${string}`;
  modelId: number;
  slaSecs: number;
  rateIn: bigint;
  rateOut: bigint;
  unitsIn: number;
  unitsOut: number;
  designated: number;
  expiresAt: bigint;
}

/**
 * The nine signed members of an order, at the chain's own widths.
 *
 * **There is no CID member, of any spelling**, and no job id: the chain derives
 * the id from the recovered signer and `c`, and the coordinator mints the task
 * name when it pins, after this is signed.
 *
 * `designated` is `0` for an open order and never null — zero is the contract's
 * sentinel for "any provider".
 */
export class OrderTerms {
  readonly c: `0x${string}`;
  readonly modelId: number;
  readonly slaSecs: number;
  readonly rateIn: bigint;
  readonly rateOut: bigint;
  readonly unitsIn: number;
  readonly unitsOut: number;
  readonly designated: number;
  readonly expiresAt: bigint;

  constructor(fields: OrderTermsFields) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fields.c)) {
      throw new ValidationError(
        `the container commitment is 32 bytes of hex, got ${fields.c}`,
        { type: "invalid_request_error" },
      );
    }
    checkUint(fields.modelId, "vorq.modelId", BigInt(UINT32_MAX));
    checkUint(fields.slaSecs, "vorq.slaSecs", BigInt(UINT32_MAX));
    checkUint(fields.rateIn, "vorq.rateIn", UINT128_MAX);
    checkUint(fields.rateOut, "vorq.rateOut", UINT128_MAX);
    checkUint(fields.unitsIn, "vorq.unitsIn", BigInt(UINT32_MAX));
    checkUint(fields.unitsOut, "vorq.unitsOut", BigInt(UINT32_MAX));
    checkUint(fields.designated, "vorq.designated", BigInt(UINT32_MAX));
    checkUint(fields.expiresAt, "vorq.expiresAt", UINT64_MAX);
    this.c = fields.c.toLowerCase() as `0x${string}`;
    this.modelId = fields.modelId;
    this.slaSecs = fields.slaSecs;
    this.rateIn = fields.rateIn;
    this.rateOut = fields.rateOut;
    this.unitsIn = fields.unitsIn;
    this.unitsOut = fields.unitsOut;
    this.designated = fields.designated;
    this.expiresAt = fields.expiresAt;
  }

  /**
   * The typed-data message, keyed by the contract's own member names.
   *
   * Typed as `OrderTermsFields` rather than a loose record on purpose: the
   * signed members and the constructor's are the same nine by definition, and
   * the precise type is what lets viem check this object against `ORDER_TYPES`
   * at compile time. A `Record<string, unknown>` satisfies that check
   * vacuously, which is exactly the check worth having here.
   */
  message(): OrderTermsFields {
    return {
      c: this.c,
      modelId: this.modelId,
      slaSecs: this.slaSecs,
      rateIn: this.rateIn,
      rateOut: this.rateOut,
      unitsIn: this.unitsIn,
      unitsOut: this.unitsOut,
      designated: this.designated,
      expiresAt: this.expiresAt,
    };
  }

  /**
   * The `vorq` block of `POST /v1/jobs`.
   *
   * `owner` and `job_id` ride alongside the signed members rather than inside
   * them: the contract derives both, so signing either would sign a value the
   * chain recomputes anyway. Sending them is what lets the node disagree at the
   * door instead of silently on chain.
   *
   * The rates are signed atomic and sent as USD strings at the token's
   * `decimals`; the node parses them back to the same integers.
   */
  toWire(args: {
    owner: Address;
    jobId: Hex;
    signature: Hex;
    decimals: number;
  }): Record<string, unknown> {
    return {
      c: this.c,
      owner: args.owner,
      job_id: args.jobId,
      model_id: this.modelId,
      sla_secs: this.slaSecs,
      rate_in: formatUsd(this.rateIn, args.decimals),
      rate_out: formatUsd(this.rateOut, args.decimals),
      units_in: this.unitsIn,
      units_out: this.unitsOut,
      designated: this.designated,
      expires_at: Number(this.expiresAt),
      signature: args.signature,
    };
  }
}

/**
 * The escrow this order commits, exactly as `JobRegistry._atomicCharge`
 * computes it: `max(1, ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE))`.
 *
 * Integer arithmetic end to end. The floor of 1 is the contract's own — an
 * order that priced to zero would commit nothing and could be claimed free.
 */
export function capFor(terms: OrderTerms): bigint {
  const scaled = terms.rateIn * BigInt(terms.unitsIn) + terms.rateOut * BigInt(terms.unitsOut);
  const cap = (scaled + RATE_SCALE - 1n) / RATE_SCALE;
  return cap === 0n ? 1n : cap;
}
