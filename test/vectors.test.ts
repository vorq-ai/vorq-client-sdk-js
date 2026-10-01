import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../src/signer/private-key.js";
import {
  CANCEL_TYPES,
  ChainContext,
  ORDER_TYPES,
  OrderTerms,
  RECEIVE_AUTHORIZATION_TYPES,
  SESSION_TYPES,
  orderDomain,
  paymentDomain,
} from "../src/terms.js";
import { ADDRESSES, CASES, CTX, VECTORS, localTypes, message } from "./vectors-loader.js";

/**
 * A local wallet, because the file publishes no private key — the **vectors'
 * own client key**, anvil index 4.
 *
 * Which key it is is free for the orders and the cancel, where recovery only
 * has to return *this* address. It is not free for `payment-authorization`:
 * `from` is a signed member, so only the wallet the vector names as `from`
 * reaches the vector's digest at all.
 */
const LOCAL_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const LOCAL = privateKeyToAccount(LOCAL_KEY);

/** `terms.ts` spells its tables `as const`, so they are deeply readonly. */
type TypeTable = Record<string, readonly { readonly name: string; readonly type: string }[]>;

/**
 * The vectors are copies. A copy that is stale, truncated, or regenerated locally by a
 * different serializer passes every other test in this repo right up until two live
 * processes built from different generations try to verify each other — and then a
 * wrong digest recovers a valid-looking stranger, with nothing reporting why.
 *
 * Byte-identity against the other repos is asserted from outside, and no longer needs
 * saying here: this repo is listed in the umbrella's `Makefile` (`COPIES` and
 * `CONTAINER_COPIES`, so `make eip712-check` and `make container-check` diff these two
 * files in the git that owns them) and in the copy sets of `e2e/test_vectors.py` and
 * `e2e/test_probe.py`, which hash every repo's copy against the master on `make probe`.
 *
 * What those cannot see is the half below: that the local file parses at all, and is the
 * artefact it claims to be rather than something hand-edited into the right shape. Both
 * halves are needed — identical-but-wrong and correct-but-diverged are different faults.
 */
const read = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./vectors/${name}`, import.meta.url)), "utf8"),
  );

describe("signing-v3.json", () => {
  it("parses and is the generated master, not a hand edit", () => {
    const doc = read("signing-v3.json");
    expect(doc.format).toBe("vorq-signing-v3");
    expect(doc.generated_by).toBe("vorq-evm-contracts/test/Vectors.t.sol");
    expect(Array.isArray(doc.cases)).toBe(true);
    expect(doc.cases.length).toBeGreaterThan(0);
    for (const c of doc.cases) {
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("typed_data");
      expect(c).toHaveProperty("digest");
      expect(c).toHaveProperty("signature");
    }
  });
});

describe("container-v1.json", () => {
  it("parses and is the generated master, not a hand edit", () => {
    const doc = read("container-v1.json");
    expect(doc.format).toBe("vorq-container-v1");
    expect(doc.generated_by).toBe("vorq-coordinator-node/src/container.ts");
    expect(doc.constants.version).toBe(1);
    expect(doc.constants.version_byte).toBe("0x01");
    expect(doc.constants.wrap_bytes).toBe(80);
    expect(Array.isArray(doc.cases)).toBe(true);
    expect(doc.cases.length).toBeGreaterThan(0);
    expect(Array.isArray(doc.refusals)).toBe(true);
    expect(doc.refusals.length).toBeGreaterThan(0);
  });
});

/**
 * The other half: the SDK's own tables and digests, against the same file.
 *
 * `signing-v3.json` carries no private key — `signer` is only an address — so
 * nothing below re-signs a case and compares against its published
 * `signature`. Two checks replace that:
 *
 *   1. **Type-table equality** — the case's `types` minus `EIP712Domain`,
 *      compared member for member against this SDK's own table.
 *   2. **Digest agreement** — sign the case's own message with a *local* key
 *      through our signer, then recover using the **vector's** `typed_data`.
 *      Recovery over a different digest yields a different address, so equality
 *      proves our digest is the file's digest.
 */
describe("signing-v3 tables and digests", () => {
  /**
   * Recover the signer of `signature` using the **vector's own** typed data. If
   * our signer built a different digest — a renamed member, a reordered table, a
   * `version` dropped from the token's domain — recovery yields a different
   * address rather than an error, which is the whole failure mode these vectors
   * exist to catch. Rebuilding the payload from `src/` here instead would prove
   * only that this file and that one agree.
   */
  async function recoverAgainstVector(name: string, signature: `0x${string}`): Promise<Address> {
    const { types, primaryType, domain } = CASES[name]!.typed_data;
    const { EIP712Domain: _drop, ...local } = types;
    // Cast whole rather than member by member: the file's payload is typed
    // only as JSON, and viem's per-member generics cannot infer a table it has
    // never seen. The values are the vector's own either way.
    return recoverTypedDataAddress({
      domain,
      types: local,
      primaryType,
      message: message(name),
      signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
  }

  /** A case's `Order` members as `OrderTerms` takes them. */
  function orderTerms(name: string): OrderTerms {
    const m = message(name);
    return new OrderTerms({
      c: m.c as `0x${string}`,
      modelId: Number(m.modelId),
      slaSecs: Number(m.slaSecs),
      rateIn: m.rateIn as bigint,
      rateOut: m.rateOut as bigint,
      unitsIn: Number(m.unitsIn),
      unitsOut: Number(m.unitsOut),
      designated: Number(m.designated),
      expiresAt: m.expiresAt as bigint,
    });
  }

  describe("the type tables", () => {
    // A member renamed, retyped or reordered does not error — it produces a
    // different typehash, and `ecrecover` then returns a valid-looking stranger.
    const TABLES: Array<[string, TypeTable]> = [
      ["order-designated", ORDER_TYPES],
      ["cancel", CANCEL_TYPES],
      ["payment-authorization", RECEIVE_AUTHORIZATION_TYPES],
      ["session", SESSION_TYPES],
    ];

    it.each(TABLES)("%s matches this SDK's table member for member", (name, table) => {
      expect(table).toEqual(localTypes(name));
    });

    it("Order has nine members and no CID of any spelling", () => {
      // The single most tempting wrong move in this spec. The contract stores a
      // taskCid on the row and does not hash it; the case carries it in `extra`.
      const members = localTypes("order-designated").Order!.map((m) => m.name);
      expect(members).toHaveLength(9);
      expect(members).not.toContain("taskCid");
      expect(CASES["order-designated"]!.extra?.task_cid).toBeTruthy();
    });

    it("the payment domain is the token's own, four members", () => {
      expect(paymentDomain(CTX)).toEqual(CASES["payment-authorization"]!.typed_data.domain);
    });
  });

  describe("the digests", () => {
    it.each(["order-designated", "order-open"])(
      "signOrderV2 lands on %s's digest",
      async (name) => {
        const signature = await new PrivateKeySigner(LOCAL_KEY).signOrderV2(orderTerms(name), CTX);
        expect(await recoverAgainstVector(name, signature)).toBe(LOCAL.address);
        // And the domain we build is the one the file publishes.
        expect(orderDomain(CTX)).toEqual(CASES[name]!.typed_data.domain);
      },
    );

    it("signCancel lands on the cancel digest", async () => {
      const m = message("cancel");
      const signature = await new PrivateKeySigner(LOCAL_KEY).signCancel(
        m.jobId as `0x${string}`,
        m.issuedAt as bigint,
        CTX,
      );
      expect(await recoverAgainstVector("cancel", signature)).toBe(LOCAL.address);
    });

    it("signPaymentAuthorization lands on the payment-authorization digest", async () => {
      const m = message("payment-authorization");
      const signature = await new PrivateKeySigner(LOCAL_KEY).signPaymentAuthorization({
        amount: m.value as bigint,
        jobId: m.nonce as `0x${string}`,
        expiresAt: (m.validBefore as bigint) - 1n,
        ctx: CTX,
      });
      expect(await recoverAgainstVector("payment-authorization", signature)).toBe(LOCAL.address);
      // `from` is signed, so the digest is reachable by exactly one wallet —
      // which is what the assertion above is worth only if this holds.
      expect(m.from).toBe(LOCAL.address);
    });

    it("nonce is the job id, and the payee is the JobRegistry", () => {
      // One authorization per job: the token's own nonce table then makes it
      // single-use, and only the payee can execute it, so an authorization
      // quoted for another job or another payee funds nothing here.
      const m = message("payment-authorization");
      expect(m.nonce).toBe(CASES["payment-authorization"]!.extra?.job_id);
      expect(m.to).toBe(CTX.jobRegistry);
      expect(m.validAfter).toBe(0n);
    });

    it("the file's own payloads hash to the digests it publishes", () => {
      // The file's internal consistency — if this fails the copy is corrupt,
      // and no amount of local correctness will help.
      for (const name of ["order-designated", "order-open", "cancel", "payment-authorization"]) {
        expect(
          hashTypedData({
            domain: CASES[name]!.typed_data.domain,
            types: localTypes(name),
            primaryType: CASES[name]!.typed_data.primaryType,
            message: message(name),
          } as Parameters<typeof hashTypedData>[0]),
        ).toBe(CASES[name]!.digest);
      }
    });
  });

  describe("domain separation", () => {
    it("a wrong verifyingContract recovers to a stranger rather than erroring", async () => {
      // The one thing the file cannot check on its own: which deployment a
      // signer thinks it is signing for. The two VORQ domains differ in exactly
      // this member.
      const wrong = new ChainContext({
        chainId: VECTORS.chain_id,
        jobRegistry: ADDRESSES.provider_registry as Address, // the mix-up under test
        providerRegistry: ADDRESSES.provider_registry as Address,
        askRegistry: ADDRESSES.ask_registry as Address,
        usdc: ADDRESSES.payment_token as Address,
        decimals: 6,
        tokenDomain: { name: "USDC", version: "2" },
        feeBps: 100,
      });
      const signature = await new PrivateKeySigner(LOCAL_KEY).signOrderV2(
        orderTerms("order-designated"),
        wrong,
      );
      expect(await recoverAgainstVector("order-designated", signature)).not.toBe(LOCAL.address);
    });
  });
});
