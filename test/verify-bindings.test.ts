import { describe, expect, it } from "vitest";
import { VerificationError } from "../src/errors.js";
import {
  DEFAULT_ALLOWLIST_TTL_S,
  ESCROW_SERVICE_ID,
  KEY_FRESHNESS_S,
  MOCK_COORDINATOR_EVIDENCE_TYPE,
  MOCK_EVIDENCE_TYPES,
  MOCK_PROVIDER_EVIDENCE_TYPE,
  STATIC_COORDINATOR_EVIDENCE_TYPE,
  escrowReportData,
  reportData,
} from "../src/verify.js";
import { BOX, ESCROW_BOX, WALLET, escrowBindingOf } from "./helpers/verify-harness.js";

describe("the tags", () => {
  it("carries both mock tags and no others", () => {
    expect(MOCK_PROVIDER_EVIDENCE_TYPE).toBe("mock-cvm-v1");
    expect(MOCK_COORDINATOR_EVIDENCE_TYPE).toBe("mock-coordinator-v1");
    // Sorted, so membership is asserted rather than insertion order — and
    // `"mock-coordinator-v1" < "mock-cvm-v1"` because `o` sorts before `v`.
    expect([...MOCK_EVIDENCE_TYPES].sort()).toEqual(["mock-coordinator-v1", "mock-cvm-v1"]);
  });

  it("keeps the static tag OUT of the mock set", () => {
    // The reason there is a second tag rather than a reused one: mock evidence
    // is computable by anyone and a mock node hands its whole key set to any
    // caller. This tag makes a smaller and true claim — the binding — and
    // folding it into the mock set would soften that guard.
    expect(STATIC_COORDINATOR_EVIDENCE_TYPE).toBe("static-coordinator-v1");
    expect(MOCK_EVIDENCE_TYPES.has(STATIC_COORDINATOR_EVIDENCE_TYPE)).toBe(false);
  });

  it("states the service id as UTF-8 and unpadded", () => {
    // A cross-language contract. A verifier that padded it to 32 bytes, or
    // encoded it UTF-16, would compute a different digest and refuse every
    // honest node.
    expect(ESCROW_SERVICE_ID).toEqual(new TextEncoder().encode("vorq-coordinator-escrow-v1"));
    expect(ESCROW_SERVICE_ID.length).toBe(26);
  });

  it("carries the protocol's one freshness bound and the allowlist TTL", () => {
    expect(KEY_FRESHNESS_S).toBe(600);
    expect(DEFAULT_ALLOWLIST_TTL_S).toBe(60);
  });
});

describe("reportData", () => {
  it("is sha256(box_pub ‖ wallet) over raw bytes, byte for byte", () => {
    // The literal is what a node's attesting daemon computes. Written out
    // rather than recomputed here, so a change to BOTH sides at once still
    // fails.
    expect(reportData(BOX, WALLET)).toBe(
      "3957e416e5d2ec98737efcfe0278184a397ab2e4589c383c03bf24307c722c1d",
    );
  });

  it("hashes the bytes, not the hex text", () => {
    // 104 hex characters of text, versus 52 bytes. If the implementation
    // concatenated the strings and hashed those, one of these two digests is
    // what it would produce — and neither is the one above.
    const digest = reportData(BOX, WALLET);
    // sha256 of the ASCII "abab…" + "70997970…" pair, bare
    expect(digest).not.toBe("b1aa1aaebf43af1992870bb42dfd065a2c60f7dabbbf74e0c9e7494e2d4442a5");
    // …and of the same pair with the address still spelled `0x…`
    expect(digest).not.toBe("ae14b4c74019755e4f3c7d929a859e417e6b217753256897404148564a948ffa");
    expect(digest).toHaveLength(64);
  });

  it("accepts either 0x spelling on either operand and answers the same digest", () => {
    const bare = reportData(BOX, WALLET.slice(2));
    expect(reportData(`0x${BOX}`, WALLET)).toBe(bare);
    expect(reportData(BOX.toUpperCase(), WALLET.toUpperCase())).toBe(bare);
  });

  it("refuses a malformed key or payee with VerificationError, never a bare Error", () => {
    // A hostile record must never reach `ValueError`-shaped behaviour: a caller
    // catching VorqError has to see this.
    expect(() => reportData("nope", WALLET)).toThrow(VerificationError);
    expect(() => reportData("ab".repeat(31), WALLET)).toThrow(/box_key/);
    expect(() => reportData(BOX, "0x1234")).toThrow(/operator/);
    expect(() => reportData(BOX, undefined as unknown as string)).toThrow(VerificationError);
  });

  it("refuses a key with a trailing newline (R10: ^…$ is \\A…\\Z, not Python's $)", () => {
    expect(() => reportData(`${BOX}\n`, WALLET)).toThrow(VerificationError);
    expect(() => reportData(BOX, `${WALLET}\n`)).toThrow(VerificationError);
  });
});

describe("escrowReportData", () => {
  it("is sha256(escrow_pk32 ‖ utf8 service id)", () => {
    expect(escrowReportData(ESCROW_BOX)).toBe(
      "7945c44471d10df14f863170eca232524150d3300afde196699793f8a94b5b95",
    );
    expect(escrowReportData(ESCROW_BOX)).toBe(escrowBindingOf(ESCROW_BOX));
  });

  it("is a DIFFERENT function of the same key from reportData", () => {
    // The whole reason it has its own function. A provider record binds a key
    // to a payee address; the announcement has no payee and never will, so
    // running it through the record binding would compute a digest over a
    // missing field and refuse every honest node.
    expect(escrowReportData(ESCROW_BOX)).not.toBe(reportData(ESCROW_BOX, WALLET));
    expect(reportData(ESCROW_BOX, WALLET)).toBe(
      "2e519a548b73c711e28661f9a0e18c018847f753ce63545ec494066d657ff11d",
    );
  });

  it("refuses a key that is not 32 bytes of hex", () => {
    expect(() => escrowReportData("1f".repeat(31))).toThrow(VerificationError);
  });
});
