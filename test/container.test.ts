import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  ContainerError,
  assertCommitment,
  buildContainer,
  commitment,
  commitmentOf,
  deriveDek,
  encryptUnderDek,
  jobIdFor,
  newSeed,
  openDek,
  sealSeedTo,
  splitContainer,
} from "../src/crypto/container.js";
import { VorqError } from "../src/errors.js";
import {
  DEK_INFO_PREFIX,
  DEK_SALT,
  SEED_LEN,
  SEED_WRAP_BYTES,
} from "../src/crypto/domains.js";
import { generateCurveKeyPair, sealOpen } from "../src/crypto/sealed-box.js";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

/** The shortest thing that could be a container — recomputed here, not imported. */
const MIN_BYTES = 1 + SEED_WRAP_BYTES;

interface Case {
  name: string;
  seed_wrap: string;
  ciphertext: string;
  container: string;
  ct_hash: string;
  c: `0x${string}`;
  owner: string;
  job_id: string;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/container-v1.json", import.meta.url)), "utf8"),
) as {
  cases: Case[];
  kdf: { info_prefix: string; salt: string; seed: string; owner: string; dek: string };
  wrap_swap: {
    ciphertext_from: string;
    seed_wrap_from: string;
    container: string;
    c: string;
    differs_from: string;
  };
  refusals: Array<{ name: string; fault: string; container: string; c?: `0x${string}` }>;
};

describe("container-v1 vectors", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s: builds, splits, commits and names the same job id",
    (_name, testCase) => {
      const seedWrap = bytes(testCase.seed_wrap);
      const ciphertext = bytes(testCase.ciphertext);

      const container = buildContainer(seedWrap, ciphertext);
      expect(hex(container)).toBe(testCase.container.toLowerCase());

      const split = splitContainer(container);
      expect(hex(split.seedWrap)).toBe(testCase.seed_wrap.toLowerCase());
      expect(hex(split.ciphertext)).toBe(testCase.ciphertext.toLowerCase());

      expect(keccak256(ciphertext)).toBe(testCase.ct_hash.toLowerCase());
      expect(commitment(seedWrap, bytes(testCase.ct_hash))).toBe(testCase.c.toLowerCase());
      expect(commitmentOf(container)).toBe(testCase.c.toLowerCase());
      expect(jobIdFor(testCase.owner, testCase.c)).toBe(testCase.job_id.toLowerCase());

      expect(() => assertCommitment(container, testCase.c)).not.toThrow();
    },
  );

  it("keeps the commitment preimage at 113 bytes however large the payload", () => {
    // The ciphertext enters through its digest, never directly.
    const long = vectors.cases.find((c) => c.name === "long-ciphertext")!;
    const empty = vectors.cases.find((c) => c.name === "empty-ciphertext")!;
    expect(bytes(long.ciphertext).length).toBeGreaterThan(bytes(empty.ciphertext).length);
    for (const testCase of [long, empty]) {
      expect(commitment(bytes(testCase.seed_wrap), bytes(testCase.ct_hash))).toBe(
        testCase.c.toLowerCase(),
      );
    }
  });

  it("treats an empty ciphertext as well formed", () => {
    const empty = vectors.cases.find((c) => c.name === "empty-ciphertext")!;
    expect(bytes(empty.container)).toHaveLength(1 + SEED_WRAP_BYTES);
    expect(commitmentOf(bytes(empty.container))).toBe(empty.c.toLowerCase());
  });

  it("puts the wrap inside the commitment — a lifted wrap names a different job", () => {
    const swap = vectors.wrap_swap;
    const container = bytes(swap.container);
    expect(commitmentOf(container)).toBe(swap.c.toLowerCase());
    // The whole reason c is not simply keccak(ciphertext).
    expect(commitmentOf(container)).not.toBe(swap.differs_from.toLowerCase());
  });

  it.each(vectors.refusals.map((r) => [r.name, r] as const))("refuses: %s", (_name, refusal) => {
    const container = bytes(refusal.container);
    const run = () =>
      refusal.c === undefined ? commitmentOf(container) : assertCommitment(container, refusal.c);
    expect(run).toThrowError(ContainerError);
    try {
      run();
    } catch (error) {
      expect((error as ContainerError).fault).toBe(refusal.fault);
    }
  });

  it("raises refusals the documented `instanceof VorqError` catch-all sees", () => {
    // A wire or protocol condition descends from VorqError. A container refusal
    // outside the hierarchy escapes that catch unrecognized — a commitment
    // mismatch on the submit path would surface as an unknown error.
    try {
      commitmentOf(new Uint8Array(SEED_WRAP_BYTES));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerError);
      expect(error).toBeInstanceOf(VorqError);
      expect((error as ContainerError).type).toBe("invalid_request_error");
      expect((error as ContainerError).name).toBe("ContainerError");
    }
  });
});

describe("deriveDek", () => {
  it("matches the vectors' precomputed answer", () => {
    const { seed, owner, dek } = vectors.kdf;
    expect(hex(deriveDek(bytes(seed), owner))).toBe(dek.toLowerCase());
  });

  it("is pinned as arithmetic, not as a round trip through this module", () => {
    // A round trip proves agreement with yourself. The inputs are the contract:
    // both sides run this and never exchange the result.
    const { seed, owner, dek } = vectors.kdf;
    // The two labels are a free cross-language anchor and are checked here
    // rather than assumed: they are the whole `info` and the whole `salt`, so a
    // repo that drifted on either derives a different key from identical bytes
    // and nothing but the counterpart SDK would ever notice.
    expect(new TextDecoder().decode(DEK_INFO_PREFIX)).toBe(vectors.kdf.info_prefix);
    expect(`0x${Buffer.from(DEK_SALT).toString("hex")}`).toBe(vectors.kdf.salt);
    expect(DEK_SALT).toHaveLength(0);
    const ownerBytes = bytes(owner);
    const info = new Uint8Array(DEK_INFO_PREFIX.length + ownerBytes.length);
    info.set(DEK_INFO_PREFIX, 0);
    info.set(ownerBytes, DEK_INFO_PREFIX.length);
    const arithmetic = hkdf(sha256, bytes(seed), new Uint8Array(0), info, 32);
    expect(hex(arithmetic)).toBe(dek.toLowerCase());
    expect(hex(deriveDek(bytes(seed), owner))).toBe(hex(arithmetic));
  });

  it("derives under 20 raw owner bytes, so casing does not change the key", () => {
    const { seed, owner } = vectors.kdf;
    expect(hex(deriveDek(bytes(seed), owner.toLowerCase()))).toBe(
      hex(deriveDek(bytes(seed), owner)),
    );
    expect(hex(deriveDek(bytes(seed), bytes(owner)))).toBe(hex(deriveDek(bytes(seed), owner)));
    expect(hex(deriveDek(bytes(seed), owner.replace(/^0x/, "")))).toBe(
      hex(deriveDek(bytes(seed), owner)),
    );
  });

  it("derives a DIFFERENT key for a different owner — the whole seed rule", () => {
    // This is what refuses a lifted wrap: the attacker derives under their own
    // address and does not open the victim's ciphertext.
    const { seed, owner } = vectors.kdf;
    const attacker = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    expect(hex(deriveDek(bytes(seed), attacker))).not.toBe(hex(deriveDek(bytes(seed), owner)));
  });

  it("refuses a seed or an owner of the wrong width", () => {
    // The message, not merely "something threw": a bare `toThrowError()` here
    // is green against an empty module, and green again if the seed guard were
    // to start reporting the *owner* width — which is the one confusion a
    // caller staring at 20 bytes and 32 bytes is actually likely to hit.
    expect(() => deriveDek(new Uint8Array(31), vectors.kdf.owner)).toThrowError(
      `seed must be ${SEED_LEN} bytes, got 31`,
    );
    expect(() => deriveDek(new Uint8Array(SEED_LEN), "0x1234")).toThrowError(
      "owner must be a 20-byte address, got 2 bytes",
    );
    // And a plain Error, not a ContainerError: this is argument validation of a
    // caller's own scalar, which `errors.ts` keeps outside the wire hierarchy —
    // exactly as Python keeps it a `ValueError`.
    expect(() => deriveDek(new Uint8Array(31), vectors.kdf.owner)).not.toThrowError(VorqError);
  });
});

describe("the seed rule", () => {
  it("seals a SEED, and the DEK is derived from it — never sealed", () => {
    // Sealing the DEK produces byte-perfect containers no provider can open.
    // Nothing structural catches it, so it is asserted directly.
    const owner = vectors.kdf.owner;
    const { privateKey, publicKey } = generateCurveKeyPair();
    const seed = bytes(vectors.kdf.seed);
    const wrap = sealSeedTo(publicKey, seed);
    expect(wrap).toHaveLength(SEED_WRAP_BYTES);

    const unsealed = sealOpen(privateKey, wrap);
    expect(hex(unsealed)).toBe(hex(seed));
    expect(hex(unsealed)).not.toBe(hex(deriveDek(seed, owner)));

    // And the recipient reaches the DEK the same way the client did.
    expect(hex(deriveDek(unsealed, owner))).toBe(vectors.kdf.dek.toLowerCase());
  });

  it("refuses a seed of the wrong width rather than sealing it", () => {
    const { publicKey } = generateCurveKeyPair();
    // Named as the *seed* width, and refused before the seal: a guard that
    // sealed first and checked the wrap afterwards would also throw, and would
    // report an 80-byte disagreement for a 16-byte cause.
    expect(() => sealSeedTo(publicKey, new Uint8Array(16))).toThrowError(
      `seed must be ${SEED_LEN} bytes, got 16`,
    );
    expect(() => sealSeedTo(publicKey, new Uint8Array(16))).not.toThrowError(/seed_wrap|sealed/);
  });
});

describe("newSeed", () => {
  it("is 32 fresh bytes", () => {
    expect(newSeed()).toHaveLength(SEED_LEN);
    expect(hex(newSeed())).not.toBe(hex(newSeed()));
  });
});

describe("the bulk cipher", () => {
  it("round-trips under a derived DEK", () => {
    const dek = deriveDek(bytes(vectors.kdf.seed), vectors.kdf.owner);
    const payload = new TextEncoder().encode('{"input":"hello"}');
    expect(new TextDecoder().decode(openDek(encryptUnderDek(payload, dek), dek))).toBe(
      '{"input":"hello"}',
    );
  });

  it("refuses a DEK that is not 32 bytes", () => {
    // The DEK width, named — and refused at this module's own door rather than
    // deeper in, where the message would be about a secret-box key and the
    // caller would have to work back to which of the two keys was wrong.
    expect(() => encryptUnderDek(new Uint8Array(1), new Uint8Array(16))).toThrowError(
      "dek must be 32 bytes, got 16",
    );
    expect(() => openDek(new Uint8Array(64), new Uint8Array(31))).toThrowError(
      "dek must be 32 bytes, got 31",
    );
  });
});

describe("splitContainer's guards", () => {
  it("refuses an 80-byte buffer as too_short rather than slicing garbage", () => {
    // A *valid* version byte, so the buffer reaches the split: `subarray` clamps
    // out of range instead of throwing, and without the length check this yields
    // a 79-byte wrap and a plausible-looking commitment over a slice of garbage.
    const truncated = new Uint8Array(SEED_WRAP_BYTES);
    truncated[0] = 1;
    try {
      splitContainer(truncated);
      expect.unreachable();
    } catch (error) {
      expect((error as ContainerError).fault).toBe("too_short");
    }

    // And a split that does succeed always hands back a full-width wrap — the
    // invariant a caller who never routes the result through `commitment()` has
    // to be able to rely on.
    const shortest = new Uint8Array(MIN_BYTES);
    shortest[0] = 1;
    const split = splitContainer(shortest);
    expect(split.seedWrap).toHaveLength(SEED_WRAP_BYTES);
    expect(split.ciphertext).toHaveLength(0);
  });

  it("refuses a version byte this build does not read", () => {
    const wrong = new Uint8Array(MIN_BYTES);
    wrong[0] = 2;
    try {
      splitContainer(wrong);
      expect.unreachable();
    } catch (error) {
      expect((error as ContainerError).fault).toBe("bad_version");
    }
  });

  it("refuses a wrap of the wrong width at build time", () => {
    expect(() => buildContainer(new Uint8Array(79), new Uint8Array(0))).toThrowError(
      ContainerError,
    );
  });
});
