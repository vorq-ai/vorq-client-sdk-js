import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ORDER_TYPES, orderDomain } from "../src/terms.js";
// Reuse the harness the submit suite already has — do not build a second one.
import { toBase64 } from "../src/crypto/bytes.js";
import { parseUsd } from "../src/money.js";
import { baseRoutes, client } from "./helpers/submit-harness.js";

/**
 * The twelve members `toWire` emits, typed so the assertions below read the
 * wire and nothing else.
 *
 * **Every expectation in this file is derived from this block, never from the
 * `OrderTerms` object that produced it.** A signature is only evidence if it is
 * checked against what actually went out: an order signed over `expiresAt + 1`
 * while the block carries the original is a perfectly well formed signature
 * that recovers to a stranger, and nothing that compares the terms to
 * themselves can see it.
 */
type Wire = {
  c: Hex;
  owner: Address;
  job_id: Hex;
  model_id: number;
  sla_secs: number;
  rate_in: string;
  rate_out: string;
  units_in: number;
  units_out: number;
  designated: number;
  expires_at: number;
  signature: Hex;
};

/** One sealed line against the scripted node, at the USD rates a test names. */
async function sealed(rateIn: string, rateOut: string) {
  const { client: c } = client(baseRoutes());
  const ctx = await c.chainContext();
  const line = await c.sealLine({
    model: "m",
    payloadInput: { input: "hello" },
    window: "1h",
    url: "/v1/responses",
    rateIn,
    rateOut,
    provider: 1,
    ctx,
  });
  return { c, ctx, line, wire: line.order as Wire };
}

/** Who signed the order, recovered from the wire block's own members. */
const orderSigner = (wire: Wire, domain: ReturnType<typeof orderDomain>) =>
  recoverTypedDataAddress({
    domain,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      c: wire.c,
      modelId: wire.model_id,
      slaSecs: wire.sla_secs,
      rateIn: parseUsd(wire.rate_in, 6),
      rateOut: parseUsd(wire.rate_out, 6),
      unitsIn: wire.units_in,
      unitsOut: wire.units_out,
      designated: wire.designated,
      expiresAt: BigInt(wire.expires_at),
    },
    signature: wire.signature,
  });

describe("sealLine / payLine", () => {
  it("seals a line whose order is the body POST /v1/jobs would carry", async () => {
    const { ctx, line, wire } = await sealed("0.000002", "0.000003");
    expect(line.url).toBe("/v1/responses");
    expect(line.jobId).toMatch(/^0x[0-9a-f]{64}$/);
    // The wire order is flat: the signed members, its owner, its id and its
    // signature — exactly what `submit`'s phase-1 challenge sends.
    expect(Object.keys(line.order).sort()).toEqual(
      ["c", "designated", "expires_at", "job_id", "model_id", "owner",
       "rate_in", "rate_out", "signature", "sla_secs", "units_in", "units_out"].sort(),
    );
    expect(line.container.length).toBeGreaterThan(0);

    // The scalars by value, so a swapped pair is caught as itself and not only
    // as a digest that stopped matching. `rate_in` and `rate_out` are the pair
    // worth naming: they are adjacent, same-typed and both go out as USD
    // strings, so nothing else here would tell 2/3 from 3/2. The signature
    // below recovers only over their atomic values, 2 and 3.
    //
    // `units_in` is the canonical payload's ceiling: `{"input":"hello"}` is 17
    // bytes. `units_out` is the
    // 4096 default — nothing in this input names a size. `1h` is 3600 seconds,
    // and the catalog publishes `model_id: 7` for "m".
    expect(wire.rate_in).toBe("0.000002");
    expect(wire.rate_out).toBe("0.000003");
    expect(wire.sla_secs).toBe(3600);
    expect(wire.units_in).toBe(17);
    expect(wire.units_out).toBe(4096);
    expect(wire.model_id).toBe(7);
    expect(wire.designated).toBe(1); // the named provider, not the open sentinel

    // **The signature is over the block that ships, and over this deployment.**
    // Recovering it from the wire's own members is the only assertion here that
    // an order signed over anything else cannot pass: `ecrecover` never fails,
    // it returns a different address, so a client signing terms it did not send
    // produces a valid signature by a stranger nobody funded.
    expect((await orderSigner(wire, orderDomain(ctx))).toLowerCase()).toBe(
      wire.owner.toLowerCase(),
    );
    // And it is bound to this chain and this JobRegistry: the same signature
    // recovers to someone else under any other domain.
    expect(
      (await orderSigner(wire, { ...orderDomain(ctx), chainId: ctx.chainId + 1 })).toLowerCase(),
    ).not.toBe(wire.owner.toLowerCase());
  });

  it("prices a line from its terms and the gas fee, signing nothing", async () => {
    // Rates chosen so the cap is real arithmetic rather than the contract's
    // floor of 1: at 2/3 atomic this payload prices below a single atomic unit and
    // every amount — right, swapped or zero — collapses to the same 1.
    const { c, ctx, line } = await sealed("1", "2");
    const row = c.payLine(line, 7n, ctx, 0n);

    expect(row.url).toBe("/v1/responses");
    // Flat, and the container base64 inside the JSON: a line is one submission.
    expect(row).toMatchObject(line.order);
    expect(row.container).toBe(toBase64(line.container));
    expect(row).not.toHaveProperty("auth_sig");

    // The amount is local arithmetic, and this is the arithmetic written out
    // rather than `capFor` called a second time — a test that recomputes the
    // thing it is checking agrees with any answer the code gives.
    //
    //   rates "1" / "2" USD are 1_000_000 / 2_000_000 atomic at 6 decimals
    //   cap = max(1, ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE))
    //       = ceilDiv(1_000_000*17 + 2_000_000*4096, 1_000_000)
    //       = ceilDiv(8_209_000_000, 1_000_000) = 8209
    //   amount = cap + gasFee = 8209 + 7 atomic = "0.008216" USD
    //
    // Swapping the two rates gives 4130, so this pins their roles as well as
    // the sum.
    expect(row.amount).toBe("0.008216");
  });
});
