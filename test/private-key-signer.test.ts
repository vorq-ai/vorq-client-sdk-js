import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../src/signer/private-key.js";
import {
  ChainContext,
  OrderTerms,
  RECEIVE_AUTHORIZATION_TYPES,
  sessionDomain,
  SESSION_TYPES,
  paymentDomain,
} from "../src/terms.js";

/**
 * Anvil account index 4 — the wallet `signing-v3.json`'s `session` case was
 * signed with. The vectors are the contract; this key is how this repo reaches
 * the same bytes as the contracts that generated them.
 */
const KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/signing-v3.json", import.meta.url)), "utf8"),
) as {
  chain_id: number;
  cases: Array<{
    name: string;
    typed_data: { types: Record<string, unknown>; primaryType: string; domain: unknown; message: unknown };
    digest: string;
    signer: string;
    signature: string;
  }>;
};

const sessionCase = vectors.cases.find((c) => c.name === "session")!;

const CTX = ChainContext.fromWire({
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
});

describe("PrivateKeySigner", () => {
  it("derives the wallet's address", () => {
    expect(new PrivateKeySigner(KEY).address).toBe(ADDRESS);
  });

  it("refuses to be built with no key at all", () => {
    expect(() => new PrivateKeySigner()).toThrowError(/VORQ_WALLET_KEY/);
  });

  it("picks the key up from the environment when none is passed", () => {
    // The absent-key test above passes vacuously — it is green whether the
    // lookup works or always returns undefined — and every other test in this
    // suite hands a key over explicitly. So a broken `envKey` (a typo in the
    // optional-chain, the wrong variable name, a lookup that reads the key but
    // discards it) would take the whole suite green with it. This is the only
    // assertion that the environment path actually reaches the wallet.
    const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process
      .env;
    const before = env.VORQ_WALLET_KEY;
    try {
      env.VORQ_WALLET_KEY = KEY;
      expect(new PrivateKeySigner().address).toBe(ADDRESS);
      // Bare hex too: the constructor adds the `0x` a shell variable usually lacks.
      env.VORQ_WALLET_KEY = KEY.slice(2);
      expect(new PrivateKeySigner().address).toBe(ADDRESS);
      // An explicit key still wins over the environment.
      env.VORQ_WALLET_KEY = `0x${"11".repeat(32)}`;
      expect(new PrivateKeySigner(KEY).address).toBe(ADDRESS);
    } finally {
      if (before === undefined) delete env.VORQ_WALLET_KEY;
      else env.VORQ_WALLET_KEY = before;
    }
  });

  it("consults the env var the caller named, not the default", () => {
    const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process
      .env;
    try {
      env.VORQ_TEST_ALT_KEY = KEY;
      expect(new PrivateKeySigner(undefined, { keyEnv: "VORQ_TEST_ALT_KEY" }).address).toBe(
        ADDRESS,
      );
      // And the default is not consulted when another name was given.
      expect(() => new PrivateKeySigner(undefined, { keyEnv: "VORQ_TEST_ABSENT_KEY" })).toThrowError(
        /VORQ_TEST_ABSENT_KEY/,
      );
    } finally {
      delete env.VORQ_TEST_ALT_KEY;
    }
  });

  it("generates an ephemeral wallet for tests", () => {
    const signer = PrivateKeySigner.generate();
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signer.address).not.toBe(PrivateKeySigner.generate().address);
  });
});

describe("the session handshake vector", () => {
  it("reproduces signing-v3.json's session signature byte for byte", async () => {
    const signer = new PrivateKeySigner(KEY);
    const signature = await signer.signNonce(
      (sessionCase.typed_data.message as { nonce: string }).nonce,
      vectors.chain_id,
    );
    expect(signature).toBe(sessionCase.signature);
  });

  it("signs under the chain-bound domain, which recovers to the wallet", async () => {
    const signer = new PrivateKeySigner(KEY);
    const nonce = "vorq-session-nonce-0001";
    const signature = await signer.signNonce(nonce, CTX.chainId);
    const recovered = await recoverTypedDataAddress({
      domain: sessionDomain(CTX.chainId),
      types: SESSION_TYPES,
      primaryType: "VorqSession",
      message: { address: signer.address, nonce },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(ADDRESS.toLowerCase());
  });

  it("binds chainId to the deployment's chain; a login for another chain is a different digest", async () => {
    const nonce = "vorq-session-nonce-0001";
    const otherChain = hashTypedData({
      domain: sessionDomain(1),
      types: SESSION_TYPES,
      primaryType: "VorqSession",
      message: { address: ADDRESS, nonce },
    });
    expect(otherChain).not.toBe(sessionCase.digest);
    expect(
      hashTypedData({
        domain: sessionDomain(vectors.chain_id),
        types: SESSION_TYPES,
        primaryType: "VorqSession",
        message: { address: ADDRESS, nonce },
      }),
    ).toBe(sessionCase.digest);
  });
});

describe("signMessage", () => {
  it("is EIP-191 personal_sign, deterministic, and matches the Python SDK's bytes", async () => {
    const signer = new PrivateKeySigner(KEY);
    const first = await signer.signMessage("VORQ-ENC-V1");
    const second = await signer.signMessage("VORQ-ENC-V1");
    expect(first).toBe(second);
    // Cross-checked against eth_account's sign_message(encode_defunct(text=...))
    // for this key. Spec 04's derived result cipher rests on exactly these bytes.
    expect(first).toBe(
      "0xd531fb2c3b6a5e0f98f93fe4c498132ac942d848f2c2a24bbac7c3ca4bf3f29b" +
        "1ce89aa974e949d7750c890e85d2f9b43f31658cb4d1d0ca88dccb460c0b79f31b",
    );
  });
});

/**
 * The three chain-bound methods against `signing-v3.json`'s own cases live in
 * `test/vectors.test.ts`, where the digest is recovered against the file's
 * payload rather than a payload rebuilt here. What is left for this file is the
 * two properties the vector cannot state: that the same terms sign identically
 * twice, and that the payment's every member but the amount comes off the order
 * and the context.
 */
describe("the three chain-bound methods", () => {
  const terms = new OrderTerms({
    c: `0x${"11".repeat(32)}`,
    modelId: 1,
    slaSecs: 3600,
    rateIn: 1n,
    rateOut: 1n,
    unitsIn: 1,
    unitsOut: 1,
    designated: 0,
    expiresAt: 1n,
  });

  it("signs an order deterministically — RFC 6979, not a fresh k each time", async () => {
    // Two different signatures over one order are both valid and recover to the
    // same address, so nothing downstream would notice; what breaks is any
    // caller that treats the signature as the order's identity.
    const signer = new PrivateKeySigner(KEY);
    expect(await signer.signOrderV2(terms, CTX)).toBe(await signer.signOrderV2(terms, CTX));
  });

  it("derives the payment's payee, window and nonce, taking only the amount", async () => {
    // The caller names an amount, a job and an expiry; everything else — who may
    // execute the transfer, from whom, and under which token's domain — is the
    // context's. Recovery against a message built from `CTX` is what says so: a
    // signature over any other payee is valid and belongs to a stranger.
    const signer = new PrivateKeySigner(KEY);
    const jobId = `0x${"33".repeat(32)}` as const;
    const signature = await signer.signPaymentAuthorization({
      amount: 210n,
      jobId,
      expiresAt: 1_800_003_600n,
      ctx: CTX,
    });
    const recoverTo = (to: `0x${string}`) =>
      recoverTypedDataAddress({
        domain: paymentDomain(CTX),
        types: RECEIVE_AUTHORIZATION_TYPES,
        primaryType: "ReceiveWithAuthorization",
        message: {
          from: signer.address,
          to,
          value: 210n,
          validAfter: 0n,
          // The token requires `now < validBefore`, and a claim may land exactly
          // on `expiresAt`, so the window is the order's plus one second.
          validBefore: 1_800_003_601n,
          nonce: jobId,
        },
        signature,
      });
    expect(await recoverTo(CTX.jobRegistry)).toBe(ADDRESS);
    expect(await recoverTo(CTX.usdc)).not.toBe(ADDRESS);
  });

  it("signs a cancel over the issuedAt it was given, not a fresh clock", async () => {
    const signer = new PrivateKeySigner(KEY);
    const jobId = `0x${"22".repeat(32)}` as const;
    expect(await signer.signCancel(jobId, 1n, CTX)).toBe(await signer.signCancel(jobId, 1n, CTX));
    expect(await signer.signCancel(jobId, 1n, CTX)).not.toBe(
      await signer.signCancel(jobId, 2n, CTX),
    );
  });
});
