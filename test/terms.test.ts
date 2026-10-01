import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import {
  CANCEL_TYPES,
  ChainContext,
  ORDER_TYPES,
  OrderTerms,
  RATE_SCALE,
  RECEIVE_AUTHORIZATION_TYPES,
  SESSION_DOMAIN,
  sessionDomain,
  SESSION_TYPES,
  capFor,
  orderDomain,
  parseRate,
  paymentDomain,
  registryDomain,
} from "../src/terms.js";

const WIRE = {
  chain_id: 84532,
  contracts: {
    job_registry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    provider_registry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    ask_registry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  decimals: 6,
  token_domain: { name: "USDC", version: "2" },
  fee_bps: 100,
  head_block: 12345,
  block_time_ms: 2000,
};

describe("ChainContext.fromWire", () => {
  it("reads the four contracts, the chain id and the token's own figures", () => {
    const ctx = ChainContext.fromWire(WIRE);
    expect(ctx.chainId).toBe(84532);
    expect(ctx.jobRegistry).toBe(WIRE.contracts.job_registry);
    expect(ctx.usdc).toBe(WIRE.contracts.usdc);
    expect(ctx.decimals).toBe(6);
    expect(ctx.tokenDomain).toEqual({ name: "USDC", version: "2" });
    expect(ctx.feeBps).toBe(100);
    expect(ctx.contracts).toEqual(WIRE.contracts);
  });

  it("refuses chain_id as a string: every integer travels as a JSON number", () => {
    expect(() => ChainContext.fromWire({ ...WIRE, chain_id: "84532" })).toThrowError(ValidationError);
  });

  it("rejects a body missing any one of the four", () => {
    for (const field of Object.keys(WIRE.contracts)) {
      const contracts = { ...WIRE.contracts } as Record<string, string>;
      delete contracts[field];
      expect(() => ChainContext.fromWire({ ...WIRE, contracts })).toThrowError(ValidationError);
      expect(() => ChainContext.fromWire({ ...WIRE, contracts })).toThrowError(field);
    }
  });

  it.each(["decimals", "token_domain", "fee_bps"])(
    "rejects a body that states no %s",
    (field) => {
      // None of the three has a defensible default: the token's name and version
      // are members of the domain every payment is signed under, and a fee this
      // client guessed at would under-fund every line of a batch.
      const body = { ...WIRE } as Record<string, unknown>;
      delete body[field];
      expect(() => ChainContext.fromWire(body)).toThrowError(ValidationError);
    },
  );

  it.each([
    ["not an object", "USDC"],
    ["missing name", { version: "2" }],
    ["an empty name", { name: "", version: "2" }],
    ["missing version", { name: "USDC" }],
    ["a non-string version", { name: "USDC", version: 2 }],
  ])("rejects a token_domain that is %s", (_label, token_domain) => {
    expect(() => ChainContext.fromWire({ ...WIRE, token_domain })).toThrowError(ValidationError);
  });

  it("rejects a body with no contracts block, and a non-object body", () => {
    expect(() => ChainContext.fromWire({ chain_id: 84532 })).toThrowError(ValidationError);
    expect(() => ChainContext.fromWire("nope")).toThrowError(ValidationError);
  });

  it("rejects an address that is not 20 bytes of hex", () => {
    for (const bad of ["0x1234", "not hex at all", 42, "0xzz46736679d2D9a65F0992F2272dE9f3c7fa6e0"]) {
      const contracts = { ...WIRE.contracts, usdc: bad };
      expect(() => ChainContext.fromWire({ ...WIRE, contracts })).toThrowError(ValidationError);
    }
  });

  it("is frozen — it is cached for the client's life and handed to every signature", () => {
    const ctx = ChainContext.fromWire(WIRE);
    expect(Object.isFrozen(ctx)).toBe(true);
    // The nested record too: a frozen context holding a mutable domain would let
    // one caller re-name the token every later payment is signed against.
    expect(Object.isFrozen(ctx.tokenDomain)).toBe(true);
  });
});

describe("the domains", () => {
  const ctx = ChainContext.fromWire(WIRE);

  it("binds the session domain to the given chain and gives it no verifyingContract", () => {
    expect(sessionDomain(ctx.chainId)).toEqual({ name: "VORQ Session", version: "1", chainId: ctx.chainId });
    expect(SESSION_DOMAIN).toEqual({ name: "VORQ Session", version: "1" });
    expect(sessionDomain(ctx.chainId)).not.toHaveProperty("verifyingContract");
    // Frozen for the same reason `ChainContext` is: this object is handed to
    // every signer and one caller mutating it in place would silently re-domain
    // every later login. `as const` is a compile-time promise only, and the two
    // places this reaches — a wallet's JSON payload and viem's local signer —
    // are both plain JavaScript. Asserted as a *write*, not as
    // `Object.isFrozen`: what matters is that the mutation fails.
    expect(() => {
      (SESSION_DOMAIN as unknown as { chainId: number }).chainId = 8453;
    }).toThrowError(TypeError);
    expect(() => {
      (SESSION_DOMAIN as unknown as { verifyingContract?: string }).verifyingContract = `0x${"11".repeat(20)}`;
    }).toThrowError(TypeError);
    expect(() => {
      (sessionDomain(ctx.chainId) as { chainId: number }).chainId = 8453;
    }).toThrowError(TypeError);
    expect(sessionDomain(ctx.chainId).chainId).toBe(ctx.chainId);
  });

  it("names the two registries differently and points each at its own contract", () => {
    expect(orderDomain(ctx)).toEqual({
      name: "VORQ Jobs",
      version: "2",
      chainId: 84532,
      verifyingContract: WIRE.contracts.job_registry,
    });
    expect(registryDomain(ctx)).toEqual({
      name: "VORQ Providers",
      version: "2",
      chainId: 84532,
      verifyingContract: WIRE.contracts.provider_registry,
    });
  });

  it("gives the payment domain the token's own name and version, never a literal", () => {
    // Name and version differ per network, so they are the node's rather than
    // this package's: a hard-coded pair would produce a separator the token
    // does not compute, and the authorization would then verify nowhere.
    expect(paymentDomain(ctx)).toEqual({
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: WIRE.contracts.usdc,
    });
    const renamed = ChainContext.fromWire({
      ...WIRE,
      token_domain: { name: "USD Coin", version: "1" },
    });
    expect(paymentDomain(renamed)).toMatchObject({ name: "USD Coin", version: "1" });
  });
});

/**
 * The signed types, against the master the contracts themselves generate.
 *
 * These four constants are the one thing in this module whose being wrong produces a
 * signature that verifies nowhere while looking perfectly well formed: a renamed member, a
 * widened type or a swapped pair changes the typehash and nothing on the wire can tell the
 * result from a forgery. Restating them here as literals would only assert that this file
 * and `src/terms.ts` were edited together, so the comparison is against
 * `signing-v3.json` — `generated_by: vorq-evm-contracts/test/Vectors.t.sol`, the contracts'
 * own output — which is the only copy in this repo that can contradict them.
 *
 * Member **order** is inside the typehash, so these are deep-equals on the arrays rather
 * than set comparisons: reordering two members has to fail here.
 */
interface VectorCase {
  name: string;
  typed_data: { types: Record<string, Array<{ name: string; type: string }>> };
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/signing-v3.json", import.meta.url)), "utf8"),
) as { cases: VectorCase[] };

/** The named case's struct types, less the `EIP712Domain` every case restates. */
function structsOf(name: string): Record<string, Array<{ name: string; type: string }>> {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`signing-v3.json carries no case named ${name}`);
  const { EIP712Domain: _domain, ...structs } = found.typed_data.types;
  return structs;
}

describe("the signed types, against the contract-generated vectors", () => {
  it("Order is the nine members the contract hashes — no taskCid, no job id, no result key", () => {
    expect(ORDER_TYPES.Order).toEqual(structsOf("order-designated").Order);
    expect(ORDER_TYPES.Order).toHaveLength(9);
  });

  it("Cancel is jobId then issuedAt", () => {
    expect(CANCEL_TYPES.Cancel).toEqual(structsOf("cancel").Cancel);
  });

  it("ReceiveWithAuthorization is the token's own six members, in its order", () => {
    // Whole-map, not per-struct: a second struct, or a missing one, has to fail too.
    expect(RECEIVE_AUTHORIZATION_TYPES).toEqual(structsOf("payment-authorization"));
  });

  it("VorqSession is the address and the coordinator's nonce", () => {
    expect(SESSION_TYPES.VorqSession).toEqual(structsOf("session").VorqSession);
  });
});

const C = `0x${"11".repeat(32)}` as const;

const terms = (over: Partial<ConstructorParameters<typeof OrderTerms>[0]> = {}) =>
  new OrderTerms({
    c: C, modelId: 7, slaSecs: 3600, rateIn: 50n, rateOut: 150n,
    unitsIn: 100, unitsOut: 4096, designated: 0, expiresAt: 1_800_000_000n,
    ...over,
  });

describe("OrderTerms", () => {
  it("keeps the nine signed members and nothing else", () => {
    // The contract's Order has no taskCid and no job id. A tenth member here
    // would be signed into a digest the chain does not compute.
    expect(Object.keys(terms().message())).toEqual([
      "c", "modelId", "slaSecs", "rateIn", "rateOut",
      "unitsIn", "unitsOut", "designated", "expiresAt",
    ]);
  });

  it("refuses a commitment that is not 32 bytes", () => {
    expect(() => terms({ c: "0x1234" as `0x${string}` })).toThrow(ValidationError);
  });

  it.each([
    ["modelId", { modelId: 2 ** 32 }],
    ["slaSecs", { slaSecs: -1 }],
    ["unitsIn", { unitsIn: 2 ** 32 }],
    ["designated", { designated: -1 }],
    ["expiresAt", { expiresAt: 2n ** 64n }],
    ["rateIn", { rateIn: 2n ** 128n }],
  ])("refuses %s outside its chain width", (_name, over) => {
    expect(() => terms(over as never)).toThrow(ValidationError);
  });

  it("sends rates as USD strings, and owner and job id beside the signed members", () => {
    // Signed atomic, sent as USD at the token's decimals: 50000 at 6 is "0.05".
    const wire = terms({ rateIn: 50_000n, rateOut: 2_500_000n }).toWire({
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      jobId: `0x${"ab".repeat(32)}`,
      signature: "0xdead",
      decimals: 6,
    });
    expect(wire.rate_in).toBe("0.05");
    expect(wire.rate_out).toBe("2.5");
    expect(wire.owner).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(wire.job_id).toBe(`0x${"ab".repeat(32)}`);
    expect(wire.c).toBe(C);
  });

  it("computes the cap exactly as the contract does", () => {
    // max(1, ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE))
    expect(capFor(terms({ rateIn: 50n, unitsIn: 100, rateOut: 150n, unitsOut: 4096 })))
      .toBe(1n); // (5000 + 614400)/1e6 -> ceil 1
    expect(capFor(terms({ rateIn: 1_000_000n, unitsIn: 3, rateOut: 0n, unitsOut: 0 })))
      .toBe(3n);
    // The contract's floor: a zero-priced order still escrows one atomic unit.
    expect(capFor(terms({ rateIn: 0n, unitsIn: 0, rateOut: 0n, unitsOut: 0 }))).toBe(1n);
  });

  it("parses a USD rate to atomic units, refusing what it cannot take exactly", () => {
    // USD per 1M units; RATE_SCALE is 1M units, so the shift is the token's decimals.
    expect(parseRate("0.05", "rate_in", 6)).toBe(50_000n);
    expect(parseRate("0.000001", "rate_in", 6)).toBe(1n);
    expect(parseRate("12", "rate_in", 6)).toBe(12_000_000n);
    expect(parseRate(null, "rate_in", 6)).toBe(0n);
    // Finer than the token carries is refused, never rounded to zero — an order
    // no provider will ever claim, learned from the expiry.
    expect(() => parseRate("0.0000001", "rate_in", 6)).toThrow(ValidationError);
    // A number or bigint could be dollars or atomic units; neither is guessed.
    expect(() => parseRate(50, "rate_in", 6)).toThrow(/USD per 1M units as a decimal string, e\.g\. "0\.05"/);
    expect(() => parseRate(50n, "rate_in", 6)).toThrow(ValidationError);
    expect(() => parseRate(true, "rate_in", 6)).toThrow(ValidationError);
    expect(() => parseRate("1e3", "rate_in", 6)).toThrow(ValidationError);
    expect(() => parseRate("-1", "rate_in", 6)).toThrow(ValidationError);
    // Past uint128 once shifted.
    expect(() => parseRate((2n ** 128n).toString(), "rate_in", 0)).toThrow(ValidationError);
  });
});
