import { describe, expect, it } from "vitest";
import { VerificationError } from "../src/errors.js";
import { Verifier } from "../src/verify.js";
import {
  ACTIVE,
  BOX,
  MEASUREMENT,
  WALLET,
  bindingOf,
  evidence,
  otherRecord,
  record,
  scriptedNode,
} from "./helpers/verify-harness.js";

const verifier = (entries: unknown[] = ACTIVE, mode: "mock" | "structural" = "mock") =>
  new Verifier("http://node", { mode, fetch: scriptedNode({ entries: () => entries }).fetch });

describe("verifyRecord — the happy path", () => {
  it("accepts valid mock evidence in mock mode", async () => {
    await expect(verifier().verifyRecord(record())).resolves.toBeUndefined();
  });

  it("accepts the node's own record shape", async () => {
    // `GET /evm/providers/:id` answers `box_key`. Before that rename the
    // verifier bound `box_public_key` — a field the node never sends — so the
    // binding raised on every honest record. This is the assertion that says
    // which spelling is the wire's.
    await expect(
      verifier().verifyRecord({
        provider_id: 7,
        provider: 7,
        operator: WALLET,
        box_key: BOX,
        evidence: evidence(),
        listed: true,
        reputation: 1000,
        capacity: 8,
        active_jobs: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses the OLD field name rather than ignoring it", async () => {
    // Not a synonym: a record carrying only the old spelling has no key to
    // bind, and that is a refusal.
    await expect(
      verifier().verifyRecord({
        provider: 7,
        operator: WALLET,
        box_public_key: BOX,
        evidence: evidence(),
      }),
    ).rejects.toThrow(/box_key/);
  });

  it("verifies a record for a DIFFERENT key pair on its own merits", async () => {
    // Guards the candidate suite: provider 2 must fail only the seal-target
    // pin, never verification itself.
    await expect(verifier().verifyRecord(otherRecord())).resolves.toBeUndefined();
  });

  it("takes the payee from `operator`, which is what the record carries", async () => {
    // The registry's payee is `operatorOf(id)` on chain and `operator` on the
    // route. There is no `address` key on that wire, and a verifier that read
    // one would compute the binding over `undefined` and refuse every honest
    // record — so no confidential designated submission could succeed at all.
    const phantom = {
      provider: 7,
      address: WALLET,
      box_key: BOX,
      evidence: evidence(),
    };
    await expect(verifier().verifyRecord(phantom)).rejects.toThrow(/operator/);
  });
});

describe("verifyRecord — the four checks", () => {
  it.each<[unknown, RegExp]>([
    // `{ ...record(), evidence: undefined }`, NOT `record(undefined)`: the
    // harness gives `ev` a default, so passing `undefined` hands the record
    // perfectly valid evidence and this case would assert nothing.
    [{ ...record(), evidence: undefined }, /no attestation evidence/],
    [record(null), /no attestation evidence/],
    [record("mock-cvm-v1"), /no attestation evidence/],
    [record(evidence({ type: "unknown-v9" })), /unrecognized evidence type/],
    [record(evidence({ measurement: "00".repeat(32) })), /not on the allowlist/],
    [record(evidence({ reportData: "00".repeat(32) })), /does not bind/],
    [record(evidence({ debug: true })), /debug/],
    [record(evidence({ svn: 0 })), /TCB/],
  ])("refuses %#", async (rec, match) => {
    await expect(verifier().verifyRecord(rec)).rejects.toThrow(match);
    await expect(verifier().verifyRecord(rec)).rejects.toBeInstanceOf(VerificationError);
  });

  it("resolves the allowlist BEFORE it computes the binding", async () => {
    // Both orders fail closed, so this is a diagnostics contract rather than a
    // hole: a record that is wrong twice over must report the same failure the
    // Python authority reports, or the same bad record reads as two different
    // bugs depending on which SDK the operator ran.
    await expect(
      verifier().verifyRecord({
        ...record(evidence({ measurement: "00".repeat(32) })),
        box_key: "not-hex",
      }),
    ).rejects.toThrow(/not on the allowlist/);
  });

  it("refuses a revoked measurement", async () => {
    await expect(
      verifier([{ ...ACTIVE[0], status: "revoked" }]).verifyRecord(record()),
    ).rejects.toThrow(/revoked/);
  });

  it("binds THIS record, not another one that also verifies", async () => {
    // Evidence lifted from a record that is itself entirely honest.
    const lifted = record({ ...evidence(), report_data: bindingOf("cd".repeat(32), WALLET) });
    await expect(verifier().verifyRecord(lifted)).rejects.toThrow(/does not bind/);
  });

  it("accepts an uppercase report_data — hex case is a spelling, not a value", async () => {
    const upper = record({ ...evidence(), report_data: bindingOf(BOX, WALLET).toUpperCase() });
    await expect(verifier().verifyRecord(upper)).resolves.toBeUndefined();
  });

  // Every row is wrapped in its own array, including the rows that are not
  // themselves arrays. `it.each` spreads rows into the callback's arguments
  // only when EVERY row is an array; one non-array row silently switches the
  // whole table to pass-the-row-whole, and switches `%o` to naming the row's
  // first element instead of the row. The value reaching the callback is the
  // same either way — this keeps the arity rule from depending on the rest of
  // the table, and keeps the array row's title from reading as a bare string.
  //
  // The last two rows are the ones that make this table say what its name says.
  // Every other row carries a value that is BOTH a non-string and not the
  // binding, so the table pins "wrong value refused" and would stay green if the
  // `typeof got !== "string"` guard were dropped as redundant — after which
  // `String(got).toLowerCase()` verifies anything that merely *stringifies* to
  // the binding. A boxed string and an object with its own `toString` are the
  // two shapes that do, and neither is a string. (The array row is a near miss:
  // it stringifies to the box key, not to the binding.)
  it.each<[unknown]>([
    [null],
    [7],
    [["ab".repeat(32)]],
    [{ rd: 1 }],
    [""],
    [undefined],
    [new String(bindingOf(BOX, WALLET))],
    [{ toString: () => bindingOf(BOX, WALLET) }],
  ])("refuses a non-string report_data %o", async (rd) => {
    await expect(
      verifier().verifyRecord(record({ ...evidence(), report_data: rd })),
    ).rejects.toThrow(/does not bind/);
  });

  // The binding is an EQUALITY, not a containment. Both rows survive a
  // `.includes(expected)` comparison; the suffix row also survives
  // `.startsWith`, the prefix row also survives `.endsWith`. A quote whose
  // report data is the right digest with anything appended is not this record's
  // binding.
  it.each<[string]>([
    [`${bindingOf(BOX, WALLET)}00`],
    [`00${bindingOf(BOX, WALLET)}`],
  ])("refuses a report_data that merely CONTAINS the binding: %s", async (rd) => {
    await expect(
      verifier().verifyRecord(record({ ...evidence(), report_data: rd })),
    ).rejects.toThrow(/does not bind/);
  });
});

describe("verifyRecord — fail closed", () => {
  it("refuses an unknown tag in structural mode — the whole property", async () => {
    const prod = [{ kind: "image", measurement: MEASUREMENT, release: "prod", status: "active" }];
    await expect(
      verifier(prod, "structural").verifyRecord(record(evidence({ type: "unknown-v9" }))),
    ).rejects.toThrow(/unrecognized evidence type/);
  });

  it("refuses mock evidence outside mock mode, on a NON-mock allowlist", async () => {
    // Isolates the evidence half of the rule: with a production allowlist
    // entry, only the evidence tag can refuse this. On the mock ACTIVE list
    // the entry gate would fire too, and the test would pass with the evidence
    // gate deleted.
    const prod = [{ kind: "image", measurement: MEASUREMENT, release: "prod", status: "active" }];
    await expect(verifier(prod, "structural").verifyRecord(record())).rejects.toThrow(
      /mock evidence is refused outside mock mode/,
    );
  });

  it("refuses a mock record outside mock mode on a mock allowlist too", async () => {
    // The whole mock-honesty rule, stated as the user meets it: nothing about a
    // mock deployment verifies in the default mode. Which of the two gates
    // fires is NOT what this asserts — the evidence gate runs first, so the
    // entry gate is pinned separately, below.
    await expect(verifier(ACTIVE, "structural").verifyRecord(record())).rejects.toThrow(/mock/);
  });

  it("refuses a mock ENTRY outside mock mode even when a non-mock duplicate shadows it", async () => {
    // Reached directly, and that is not a shortcut — it is the only door there
    // is. In structural mode `verifyRecord` refuses the provider tag before
    // `matchImageEntry` is ever called, and no other tag has a validator, so no
    // route through the public method can exercise this gate today. Deleting
    // the gate outright left all 634 tests green until this test existed; the
    // Python authority pins it the same way and for the same stated reason.
    //
    // The gate guards the future strict tier: once a non-mock validator lands,
    // an entry curation filed as mock must still not verify in the default
    // mode, and a non-mock duplicate must not shadow it.
    const v = verifier(
      [{ ...ACTIVE[0] }, { kind: "image", measurement: MEASUREMENT, release: "prod", status: "active" }],
      "structural",
    ) as unknown as { matchImageEntry(measurement: unknown): Promise<unknown> };
    await expect(v.matchImageEntry(MEASUREMENT)).rejects.toThrow(/mock allowlist entry/);
  });

  it.each([["mock-coordinator-v1"], ["static-coordinator-v1"]])(
    "refuses %s on the RECORD path — a different trust domain",
    async (type) => {
      // A verifier that took either tag for either would accept a provider's
      // evidence as proof about the coordinator's escrow key.
      await expect(verifier().verifyRecord(record(evidence({ type })))).rejects.toThrow(
        /unrecognized evidence type/,
      );
    },
  );

  it.each<[unknown]>([
    ["mock-cvm-v1"],
    [7],
    [null],
    [undefined],
    [{ a: 1 }],
    [["mock-cvm-v1"]],
  ])("compares the tag by identity, not by shape: %o", async (type) => {
    if (type === "mock-cvm-v1") {
      await expect(verifier().verifyRecord(record(evidence({ type })))).resolves.toBeUndefined();
    } else {
      await expect(verifier().verifyRecord(record(evidence({ type })))).rejects.toThrow(
        /unrecognized evidence type/,
      );
    }
  });
});

describe("verifyRecord — an unevaluable check is a FAILED check", () => {
  it.each<[Record<string, unknown>, RegExp]>([
    [{ debug: undefined }, /boolean debug flag/],
    [{ debug: 1 }, /boolean debug flag/],
    [{ debug: "false" }, /boolean debug flag/],
    [{ debug: [0] }, /boolean debug flag/],
    [{ debug: { on: false } }, /boolean debug flag/],
    [{ debug: null }, /boolean debug flag/],
  ])("refuses an unstated debug status %o", async (over, match) => {
    await expect(verifier().verifyRecord(record(evidence(over)))).rejects.toThrow(match);
  });

  it("refuses a debug flag that IS stated and IS true", async () => {
    await expect(verifier().verifyRecord(record(evidence({ debug: true })))).rejects.toThrow(
      /carries a debug flag/,
    );
  });

  // `/not a number/` and `/not a finite number/` are each other's opposites
  // here, not one another's substrings: "not a finite number" does not contain
  // "not a number", so the two halves of `tcbSvn` cannot cover for each other.
  it.each<[Record<string, unknown>, RegExp]>([
    [{}, /no TCB version/],
    [{ tcb: null }, /no TCB version/],
    [{ tcb: 3 }, /not an object/],
    [{ tcb: [1] }, /not an object/],
    [{ tcb: "1" }, /not an object/],
    [{ tcb: {} }, /not a number/],
    [{ tcb: { svn: "1" } }, /not a number/],
    [{ tcb: { svn: true } }, /not a number/],
    [{ tcb: { svn: Number.NaN } }, /not a finite number/],
    [{ tcb: { svn: Number.POSITIVE_INFINITY } }, /not a finite number/],
  ])("refuses a malformed TCB block %o", async (patch, match) => {
    const ev = { ...evidence() };
    delete (ev as Record<string, unknown>).tcb;
    await expect(verifier().verifyRecord(record({ ...ev, ...patch }))).rejects.toThrow(match);
  });

  it("refuses an svn below a raised floor", async () => {
    const v = new Verifier("http://node", {
      mode: "mock",
      minTcbSvn: 4,
      fetch: scriptedNode({ entries: () => ACTIVE }).fetch,
    });
    await expect(v.verifyRecord(record(evidence({ svn: 3 })))).rejects.toThrow(/TCB/);
    await expect(v.verifyRecord(record(evidence({ svn: 4 })))).resolves.toBeUndefined();
  });
});

describe("verifyRecord — hostile shapes never escape as a TypeError", () => {
  it.each<[unknown]>([[null], [undefined], [7], ["a record"], [["a record"]], [true]])(
    "refuses a non-object record %o",
    async (rec) => {
      await expect(verifier().verifyRecord(rec)).rejects.toBeInstanceOf(VerificationError);
      await expect(verifier().verifyRecord(rec)).rejects.toThrow(/not an object/);
    },
  );

  it.each<[Record<string, unknown>, RegExp]>([
    [{ box_key: "not-hex" }, /box_key/],
    [{ box_key: 7 }, /box_key/],
    [{ box_key: `${BOX}\n` }, /box_key/],
    [{ box_key: "ab".repeat(31) }, /box_key/],
    [{ operator: "0x" }, /operator/],
    [{ operator: null }, /operator/],
    [{ operator: `${WALLET}\n` }, /operator/],
  ])("refuses a malformed field %o with VerificationError", async (patch, match) => {
    const rejected = verifier().verifyRecord({ ...record(), ...patch });
    await expect(rejected).rejects.toBeInstanceOf(VerificationError);
    await expect(verifier().verifyRecord({ ...record(), ...patch })).rejects.toThrow(match);
  });

  // The four decoys are the point of the list. An absent measurement, an empty
  // one, a bare `0x` and a non-hex string all normalize to `null`, exactly as an
  // unusable evidence measurement does — so a verifier that compared the
  // normalized values without first refusing a `null` on the evidence side would
  // MATCH them and accept a record that named no image at all. (Python splits
  // the same four across two tests, two and two.)
  const decoyed = [
    ...ACTIVE,
    { kind: "image", status: "active", mock: true },
    { kind: "image", measurement: "", status: "active", mock: true },
    { kind: "image", measurement: "0x", status: "active", mock: true },
    { kind: "image", measurement: "not-hex", status: "active", mock: true },
  ];

  it.each<[unknown]>([
    [null],
    [""],
    [7],
    [["aa"]],
    [{ m: 1 }],
    [undefined],
    ["0x"],
    ["not-hex"],
    [`${MEASUREMENT}zz`],
    [`0x0x${MEASUREMENT}`],
  ])("refuses an unusable measurement %o", async (measurement) => {
    const rejected = verifier(decoyed).verifyRecord(record(evidence({ measurement })));
    await expect(rejected).rejects.toBeInstanceOf(VerificationError);
    await expect(
      verifier(decoyed).verifyRecord(record(evidence({ measurement }))),
    ).rejects.toThrow(/measurement/);
  });

  it("matches a measurement across case and 0x on EITHER side", async () => {
    for (const entryM of [MEASUREMENT, `0x${MEASUREMENT}`, `0X${MEASUREMENT.toUpperCase()}`]) {
      for (const evM of [MEASUREMENT, `0x${MEASUREMENT}`, MEASUREMENT.toUpperCase()]) {
        await expect(
          verifier([{ ...ACTIVE[0], measurement: entryM }]).verifyRecord(
            record(evidence({ measurement: evM })),
          ),
        ).resolves.toBeUndefined();
      }
    }
  });

  it("applies a revocation across 0x spellings", async () => {
    // A revocation written in one spelling must not leave the other live.
    for (const entryM of [MEASUREMENT, `0x${MEASUREMENT}`]) {
      for (const evM of [MEASUREMENT, `0x${MEASUREMENT}`]) {
        await expect(
          verifier([{ ...ACTIVE[0], measurement: entryM, status: "revoked" }]).verifyRecord(
            record(evidence({ measurement: evM })),
          ),
        ).rejects.toThrow(/revoked/);
      }
    }
  });
});

describe("verifyRecord — a check that joins an in-flight allowlist read", () => {
  it("sees a revocation that landed while that read was on the wire", async () => {
    // `invalidate()` clears `inflight` as well as `entries`, and this is the
    // door that proves why. A joined promise re-evaluates nothing: it can only
    // replay the answer it was created with. Were `inflight` left set across
    // the invalidation, THIS call would join the read composed before the
    // revocation notice and accept a revoked image.
    let entries: unknown[] = ACTIVE;
    let openTheGate!: () => void;
    let readReachedTheGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      readReachedTheGate = resolve;
    });
    const node = scriptedNode({
      entries: () => entries,
      beforeAllowlist: async (n) => {
        if (n === 1) {
          readReachedTheGate();
          await gate;
        }
      },
    });
    const v = new Verifier("http://node", { mode: "mock", fetch: node.fetch });

    const parked = v.verifyRecord(record());
    await reached;

    // The notice arrives after the parked read's answer was already composed.
    entries = [{ ...ACTIVE[0], status: "revoked" }];
    v.invalidate();

    // The join decision is taken synchronously inside this call — nothing is
    // awaited between `verifyRecord` and `cachedEntries`'s `if (this.inflight
    // !== null)` — so the gate may be opened on the next line without changing
    // what this call decided. Opening it here rather than after the assertion
    // is what makes a regression fail as a wrong ANSWER instead of as a
    // five-second timeout.
    const joining = v.verifyRecord(record());
    openTheGate();

    await expect(joining).rejects.toThrow(/revoked/);
    // The parked read still answers its own caller with what it fetched; it is
    // simply not cached, which is a separate property from this one.
    await expect(parked).resolves.toBeUndefined();
    // Two reads, not one: the joining caller opened its own socket.
    expect(node.allowlistReads).toBe(2);
  });
});
