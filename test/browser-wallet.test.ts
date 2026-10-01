import { recoverTypedDataAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserWalletSigner,
  NoWalletError,
  WalletRejectedError,
  type Eip1193Provider,
} from "../src/signer/browser-wallet.js";
import { VorqError } from "../src/errors.js";
import { PrivateKeySigner } from "../src/signer/private-key.js";
import {
  CANCEL_TYPES,
  ORDER_TYPES,
  OrderTerms,
  RECEIVE_AUTHORIZATION_TYPES,
  sessionDomain,
  SESSION_TYPES,
} from "../src/terms.js";
import { CASES, CTX, message } from "./vectors-loader.js";

const KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
/** The chain the session domain is bound to in these tests: the vectors' Base Sepolia. */
const CHAIN_ID = 84532;
const ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

/** An EIP-1193 provider backed by a local key — no extension needed. */
function stubProvider(overrides: Partial<Record<string, unknown>> = {}): Eip1193Provider {
  const local = new PrivateKeySigner(KEY);
  return {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return value;
      }
      if (method === "eth_requestAccounts") return [ADDRESS.toLowerCase()];
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(params![1] as string) as {
          domain: Record<string, unknown>;
          message: Record<string, unknown>;
        };
        expect(typed.domain).toMatchObject({ name: "VORQ Session", version: "1", chainId: CHAIN_ID });
        return local.signNonce(typed.message.nonce as string, CHAIN_ID);
      }
      if (method === "personal_sign") {
        return local.signMessage(new TextDecoder().decode(hexToBytes(params![0] as string)));
      }
      throw new Error(`unexpected RPC ${method}`);
    }),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(raw.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

/** A minimal `window` that replays EIP-6963 announcements on request. */
function fakeWindow(wallets: Array<{ info: Record<string, string>; provider: Eip1193Provider }>) {
  const listeners = new Set<(event: Event) => void>();
  return {
    ethereum: undefined as Eip1193Provider | undefined,
    addEventListener(type: string, handler: (event: Event) => void) {
      if (type === "eip6963:announceProvider") listeners.add(handler);
    },
    removeEventListener(_type: string, handler: (event: Event) => void) {
      listeners.delete(handler);
    },
    dispatchEvent(event: Event) {
      if (event.type !== "eip6963:requestProvider") return true;
      for (const wallet of wallets) {
        for (const handler of listeners) {
          handler(new CustomEvent("eip6963:announceProvider", { detail: wallet }));
        }
      }
      return true;
    },
  };
}

const WALLET_A = { info: { uuid: "a", name: "Wallet A", icon: "data:,", rdns: "test.a" } };
const WALLET_B = { info: { uuid: "b", name: "Wallet B", icon: "data:,", rdns: "test.b" } };

describe("BrowserWalletSigner.discover", () => {
  it("returns every announced wallet so a UI can offer a choice", async () => {
    const provider = stubProvider();
    const window = fakeWindow([
      { ...WALLET_A, provider },
      { ...WALLET_B, provider },
    ]);
    const found = await BrowserWalletSigner.discover({ window: window as never, timeoutMs: 0 });
    expect(found.map((w) => w.info.rdns)).toEqual(["test.a", "test.b"]);
  });

  it("dedupes a wallet that announces twice", async () => {
    const provider = stubProvider();
    const window = fakeWindow([
      { ...WALLET_A, provider },
      { ...WALLET_A, provider },
    ]);
    const found = await BrowserWalletSigner.discover({ window: window as never, timeoutMs: 0 });
    expect(found).toHaveLength(1);
  });

  it("falls back to window.ethereum when nothing announces", async () => {
    const window = fakeWindow([]);
    window.ethereum = stubProvider();
    const found = await BrowserWalletSigner.discover({ window: window as never, timeoutMs: 0 });
    expect(found).toHaveLength(1);
    expect(found[0]!.info.rdns).toBe("unknown");
  });

  it("returns an empty list when there is no wallet at all", async () => {
    const found = await BrowserWalletSigner.discover({
      window: fakeWindow([]) as never,
      timeoutMs: 0,
    });
    expect(found).toEqual([]);
  });
});

describe("BrowserWalletSigner.from", () => {
  it("prompts eth_requestAccounts and takes the first address", async () => {
    const provider = stubProvider();
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    expect(signer.address).toBe(ADDRESS);
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
  });

  it("raises NoWalletError when the wallet returns no accounts", async () => {
    const provider = stubProvider({ eth_requestAccounts: [] });
    await expect(BrowserWalletSigner.from({ ...WALLET_A, provider })).rejects.toBeInstanceOf(
      NoWalletError,
    );
  });

  it("turns the 4001 rejection into a typed error, not a raw RPC object", async () => {
    const rejection = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const provider = stubProvider({ eth_requestAccounts: rejection });
    const err = await BrowserWalletSigner.from({ ...WALLET_A, provider }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletRejectedError);
    expect((err as WalletRejectedError).statusCode).toBeNull();
  });
});

describe("signing through EIP-1193", () => {
  it("produces a session signature that recovers to the wallet", async () => {
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider: stubProvider() });
    const nonce = "vorq-session-nonce-0001";
    const signature = await signer.signNonce(nonce, CHAIN_ID);
    const recovered = await recoverTypedDataAddress({
      domain: sessionDomain(CHAIN_ID),
      types: SESSION_TYPES,
      primaryType: "VorqSession",
      message: { address: signer.address, nonce },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(ADDRESS.toLowerCase());
  });

  it("sends personal_sign as hex, and agrees with PrivateKeySigner byte for byte", async () => {
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider: stubProvider() });
    const viaWallet = await signer.signMessage("VORQ-ENC-V1");
    const viaKey = await new PrivateKeySigner(KEY).signMessage("VORQ-ENC-V1");
    // Spec 04 derives the result cipher from these bytes. If the two runtimes
    // disagree, a browser cannot open a result a Node client sealed.
    expect(viaWallet).toBe(viaKey);
  });

  it("addresses personal_sign to the connected account, hex first", async () => {
    const provider = stubProvider();
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await signer.signMessage("VORQ-ENC-V1");
    // `personal_sign` is [message, address]. Nothing else in this suite reads
    // params[1], so a signer that addressed the prompt at the wrong account —
    // or swapped the pair — would go unnoticed.
    const hex = `0x${Array.from(new TextEncoder().encode("VORQ-ENC-V1"), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")}`;
    expect(provider.request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: [hex, signer.address],
    });
    // `toHaveBeenCalledWith` is satisfied by *any* matching call, so on its own
    // it cannot see a second prompt — and a duplicate `personal_sign` is a
    // second modal in the user's face for one derivation. The count is the
    // assertion; the shape above only says the one call was right.
    const prompts = vi
      .mocked(provider.request)
      .mock.calls.filter(([args]) => args.method === "personal_sign");
    expect(prompts).toHaveLength(1);
    // One connection prompt too, and nothing else was asked of the wallet.
    expect(provider.request).toHaveBeenCalledTimes(2);
  });

  it("refuses a wallet answer that is not a signature, and names the wallet", async () => {
    // An unchecked cast makes this somebody else's bug: the value travels as a
    // `Hex` and fails much later, inside viem's recovery or inside the result
    // cipher's keccak, with a message about hex parsing and no mention of the
    // wallet that caused it.
    // The last two are 0x-prefixed hex and would pass a `/^0x[0-9a-f]+$/` guard.
    // The guard refuses answers that are not whole bytes; it deliberately fixes
    // no length, because ERC-1271 smart accounts reaching this path over
    // EIP-6963 return signatures that are not 65 bytes. So an even-length
    // truncation still gets through — closing that would need a floor, and a
    // floor is an assumption about the account type.
    for (const answer of [
      null,
      undefined,
      42,
      { r: "0x1", s: "0x2" },
      "not hex",
      "abc123",
      "",
      "0x1",
      "0xdeadbee",
    ]) {
      const provider: Eip1193Provider = {
        request: async ({ method }) =>
          method === "eth_requestAccounts" ? [ADDRESS.toLowerCase()] : answer,
      };
      const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
      await expect(signer.signNonce("n", CHAIN_ID)).rejects.toThrowError(WALLET_A.info.name);
      await expect(signer.signNonce("n", CHAIN_ID)).rejects.toThrowError(
        /not a 0x-prefixed signature of whole bytes/,
      );
      await expect(signer.signMessage("VORQ-ENC-V1")).rejects.toThrowError(WALLET_A.info.name);
      // And it is one of this SDK's own errors, not a stray TypeError.
      await expect(signer.signNonce("n", CHAIN_ID)).rejects.toBeInstanceOf(VorqError);
    }
  });

  it("sends the exact session struct: account, domain, types, primaryType, message", async () => {
    const sent: unknown[][] = [];
    const local = new PrivateKeySigner(KEY);
    const provider: Eip1193Provider = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts") return [ADDRESS.toLowerCase()];
        sent.push(params!);
        return local.signNonce("n", CHAIN_ID);
      },
    };
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await signer.signNonce("n", CHAIN_ID);

    // A stub that re-signs supplies its own correct domain, types and message,
    // so recovery proves nothing about what was *sent*. These five are every
    // input to the digest a real wallet would build, and each is matched
    // exactly — a subset match is what leaves the rest of the struct open.
    const [account, payload] = sent[0]!;
    expect(account).toBe(signer.address);
    const typed = JSON.parse(payload as string) as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    expect(typed.domain).toEqual({ ...sessionDomain(CHAIN_ID) });
    expect(typed.primaryType).toBe("VorqSession");
    expect(typed.types.VorqSession).toEqual(SESSION_TYPES.VorqSession);
    // viem derives this list for a local account; `eth_signTypedData_v4` does
    // not. The session domain carries no `verifyingContract`, so nor does this.
    expect(typed.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    expect(typed.message).toEqual({ address: signer.address, nonce: "n" });
  });

  it("wraps a 4001 rejection at signing time too", async () => {
    const rejection = Object.assign(new Error("User denied"), { code: 4001 });
    const provider = stubProvider({ eth_signTypedData_v4: rejection });
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await expect(signer.signNonce("n", CHAIN_ID)).rejects.toBeInstanceOf(WalletRejectedError);
  });
});

/**
 * The three chain-bound prompts.
 *
 * A wallet is handed a JSON **string**, so what matters is the bytes in that
 * string rather than a signature a stub invented: the digest is built inside
 * the wallet, from exactly this payload. Each assertion below is against
 * `signing-v3.json`'s own case, so a renamed member or a `version` dropped from
 * the token's domain fails here.
 *
 * `jsonSafe`'s `bigint` branch is exercised for the first time by these:
 * `rateIn`, `rateOut`, `expiresAt`, `issuedAt`, `value`, `validAfter` and
 * `validBefore` are all `bigint`, and `JSON.stringify` throws on one — an order
 * that reached the wallet unconverted would fail at the prompt with a
 * TypeError.
 */
describe("the chain-bound prompts", () => {
  /** A provider that records the payload and answers with well-formed bytes. */
  function recordingProvider(): { provider: Eip1193Provider; sent: () => unknown[] } {
    const calls: unknown[][] = [];
    return {
      provider: {
        request: async ({ method, params }) => {
          if (method === "eth_requestAccounts") return [ADDRESS.toLowerCase()];
          calls.push(params!);
          return `0x${"ab".repeat(65)}`;
        },
      },
      sent: () => calls[0]!,
    };
  }

  const typedSent = (params: unknown[]) =>
    JSON.parse(params[1] as string) as {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    };

  const orderTerms = (name: string) => {
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
  };

  it("sends the Order struct the vector publishes, bigints as decimal strings", async () => {
    const { provider, sent } = recordingProvider();
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await signer.signOrderV2(orderTerms("order-designated"), CTX);

    const [account, payload] = sent();
    expect(account).toBe(signer.address);
    // `JSON.stringify` throws on a bigint, so this is the assertion that the
    // conversion happened at all — and that it is decimal, not hex.
    expect(payload).toContain('"rateIn":"30000"');
    expect(payload).toContain('"rateOut":"90000"');
    expect(payload).toContain('"expiresAt":"1800003600"');

    const typed = typedSent(sent());
    expect(typed.domain).toEqual(CASES["order-designated"]!.typed_data.domain);
    expect(typed.primaryType).toBe("Order");
    expect(typed.types.Order).toEqual(ORDER_TYPES.Order);
    // viem derives this list for a local account; `eth_signTypedData_v4` does not.
    expect(typed.types.EIP712Domain).toEqual(
      CASES["order-designated"]!.typed_data.types.EIP712Domain,
    );
    // Every member the vector carries, and no tenth of any spelling.
    expect(Object.keys(typed.message)).toEqual(ORDER_TYPES.Order.map((m) => m.name));
    expect(typed.message.c).toBe(CASES["order-designated"]!.typed_data.message.c);
  });

  it("sends the Cancel struct under the JobRegistry's domain", async () => {
    const { provider, sent } = recordingProvider();
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    const m = message("cancel");
    await signer.signCancel(m.jobId as `0x${string}`, m.issuedAt as bigint, CTX);

    const typed = typedSent(sent());
    expect(typed.domain).toEqual(CASES.cancel!.typed_data.domain);
    expect(typed.primaryType).toBe("Cancel");
    expect(typed.types.Cancel).toEqual(CANCEL_TYPES.Cancel);
    expect(typed.message).toEqual({ jobId: m.jobId, issuedAt: String(m.issuedAt) });
  });

  it("sends the ReceiveWithAuthorization struct under the token's four-member domain", async () => {
    const { provider, sent } = recordingProvider();
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    const m = message("payment-authorization");
    await signer.signPaymentAuthorization({
      amount: m.value as bigint,
      jobId: m.nonce as `0x${string}`,
      expiresAt: (m.validBefore as bigint) - 1n,
      ctx: CTX,
    });

    const typed = typedSent(sent());
    // A missing `version` here is well formed and silently fatal: it changes the
    // separator, and the authorization then verifies nowhere.
    expect(typed.domain).toEqual(CASES["payment-authorization"]!.typed_data.domain);
    expect(typed.types.EIP712Domain).toHaveLength(4);
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed.types).toMatchObject(RECEIVE_AUTHORIZATION_TYPES);
    // The struct against the vector's own values. `value`, `validAfter` and
    // `validBefore` are `uint256` and go out as decimal strings; `nonce` is
    // `bytes32` and stays hex, which is the one value a JSON number could not
    // carry at all.
    expect(typed.message).toEqual({
      from: signer.address,
      to: m.to,
      value: String(m.value),
      validAfter: "0",
      validBefore: String(m.validBefore),
      nonce: m.nonce,
    });
  });

  it("wraps a 4001 rejection on an order prompt too", async () => {
    const rejection = Object.assign(new Error("User denied"), { code: 4001 });
    const provider = stubProvider({ eth_signTypedData_v4: rejection });
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await expect(signer.signOrderV2(orderTerms("order-open"), CTX)).rejects.toBeInstanceOf(
      WalletRejectedError,
    );
  });

  it("refuses a wallet answer to an order prompt that is not a signature", async () => {
    const provider: Eip1193Provider = {
      request: async ({ method }) =>
        method === "eth_requestAccounts" ? [ADDRESS.toLowerCase()] : "0xdeadbee",
    };
    const signer = await BrowserWalletSigner.from({ ...WALLET_A, provider });
    await expect(signer.signOrderV2(orderTerms("order-open"), CTX)).rejects.toThrowError(
      /not a 0x-prefixed signature of whole bytes/,
    );
  });
});
