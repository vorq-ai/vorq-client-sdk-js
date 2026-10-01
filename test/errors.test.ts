import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BatchFailed,
  EscrowKeyUnverified,
  JobFailed,
  NotFoundError,
  ResultIntegrityError,
  StateConflictError,
  TransportError,
  ValidationError,
  VerificationError,
  VorqError,
  WaitTimeout,
  errorFromWire,
} from "../src/errors.js";

describe("errorFromWire", () => {
  it("maps each mapped status to its class and keeps the envelope's fields", () => {
    const cases: Array<[number, new (...a: never[]) => VorqError]> = [
      [400, ValidationError],
      [401, AuthenticationError],
      [404, NotFoundError],
      [409, StateConflictError],
    ];
    for (const [status, cls] of cases) {
      const err = errorFromWire(
        status,
        { error: { message: "nope", type: "invalid_request_error" } },
        { requestId: "req-1" },
      );
      expect(err).toBeInstanceOf(cls);
      expect(err.message).toBe("nope");
      expect(err.type).toBe("invalid_request_error");
      expect(err.requestId).toBe("req-1");
      expect(err.statusCode).toBe(status);
    }
  });

  it("falls back to the base class for an unmapped status", () => {
    const err = errorFromWire(503, { error: { message: "later" } }, { requestId: null });
    expect(err.constructor).toBe(VorqError);
    expect(err.statusCode).toBe(503);
    expect(err.type).toBeNull();
  });

  it("degrades rather than crashing on a malformed or missing envelope", () => {
    for (const body of [null, undefined, "plain text", 42, {}, { error: "not an object" }]) {
      const err = errorFromWire(500, body, { requestId: null });
      expect(err.message).toBe("HTTP 500");
      expect(err.type).toBeNull();
    }
  });

  it("degrades to HTTP <status> when the envelope carries an empty message", () => {
    const err = errorFromWire(400, { error: { message: "" } }, { requestId: null });
    expect(err.message).toBe("HTTP 400");
  });
});

describe("the taxonomy", () => {
  it("descends from VorqError and reports its own class name", () => {
    const err = new NotFoundError("gone");
    expect(err).toBeInstanceOf(VorqError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotFoundError");
    expect(String(err)).toContain("gone");
  });

  it("makes EscrowKeyUnverified a VerificationError", () => {
    const err = new EscrowKeyUnverified("unproven");
    expect(err).toBeInstanceOf(VerificationError);
    expect(err).toBeInstanceOf(VorqError);
  });

  it("carries the extra fields the three job errors add", () => {
    const timeout = new WaitTimeout("too slow", { jobId: "0xabc" });
    expect(timeout.jobId).toBe("0xabc");
    expect(timeout.type).toBe("wait_timeout");

    const failed = new JobFailed("dead", { errorType: "provider_fail", jobId: "0xabc" });
    expect(failed.errorType).toBe("provider_fail");
    expect(failed.type).toBe("provider_fail");

    const batch = new BatchFailed("bad file", { batchId: "batch_1" });
    expect(batch.batchId).toBe("batch_1");
    expect(batch.type).toBe("batch_failed");
  });

  it("gives ResultIntegrityError its own type and carries the request id", () => {
    // On the export contract, and until now untested — so a class that had lost
    // its `type`, or that no longer descended from `VorqError`, would have gone
    // out in a published package unnoticed.
    const err = new ResultIntegrityError("the seal does not open", { requestId: "req-4" });
    expect(err).toBeInstanceOf(VorqError);
    expect(err.name).toBe("ResultIntegrityError");
    expect(err.type).toBe("result_integrity");
    expect(err.requestId).toBe("req-4");
    // Raised locally, off no response of its own.
    expect(err.statusCode).toBeNull();
    expect(new ResultIntegrityError("no result").requestId).toBeNull();
  });

  it("gives TransportError a null status and keeps the original as cause", () => {
    // There was no HTTP status: the request never became a response. The cause
    // is the only place the underlying TypeError or DOMException survives.
    const dropped = new TypeError("fetch failed");
    const err = new TransportError("GET http://node.test/key could not be reached", {
      cause: dropped,
    });
    expect(err).toBeInstanceOf(VorqError);
    expect(err.name).toBe("TransportError");
    expect(err.type).toBe("transport_error");
    expect(err.statusCode).toBeNull();
    expect(err.cause).toBe(dropped);
  });
});
