/**
 * The public surface of `@vorq-ai/client-sdk`.
 *
 * Everything reachable from here is supported. Everything else in `src/` is an
 * implementation detail: `package.json` exports `.` and `./package.json` and
 * nothing more, so a deep import is not a thing this package promises to keep
 * working.
 */
export { Client, mintSessionToken } from "./client.js";
export type {
  Allowlist, AllowlistEntry, Ask, AskBook, ClientJob, ClientOptions, EscrowKeyAnnouncement,
  EvmJob, Floor, FloorBook, JobBook, JobQuery, JobsSummary, JobsSummaryModel, PagedListing, SlaWindow,
  ProviderRecord, SealedLine, SealLineArgs, SubmitArgs, VorqFile,
} from "./client.js";

// The rest of what a public `Client` member hands back or takes. Without these
// a caller cannot write `const ctx: ChainContext = await client.chainContext()`
// at all — the only recourse is `Awaited<ReturnType<Client["chainContext"]>>`,
// which is not a usable TypeScript surface.
//
// `Models` and `ChainContext` are classes, re-exported type-only for the same
// reason `Batches` is: a caller receives one and annotates it, never constructs
// one and never narrows a union containing one, so `instanceof` has no job
// here, and a value export would put a runtime class on the barrel that nothing
// calls. `test/index-surface.test.ts` pins all twelve at compile time, since a
// type-only export is invisible to `Object.keys` and would otherwise rot
// silently.
export type { Models, ModelRecord } from "./models.js";
export type { ChainContext } from "./terms.js";
export type { RequestOptions } from "./transport.js";

export { JobHandle } from "./jobs.js";
export { EmbeddingResult, JobError, MediaResult, TextResult } from "./results.js";
export type { Rates } from "./results.js";

// `Batches` and `BatchHandle` are classes, re-exported type-only on purpose:
// both are reached through `client.batches`, never constructed by a caller, so
// what a caller needs from them is the name to annotate with.
export type { BatchPage, BatchResult, BatchSubmitOptions, Batches, BatchHandle } from "./batches.js";

export { BrowserWalletSigner } from "./signer/browser-wallet.js";
export { PrivateKeySigner } from "./signer/private-key.js";
export type { DiscoveredWallet, Eip1193Provider } from "./signer/browser-wallet.js";
export type { PrivateKeySignerOptions } from "./signer/private-key.js";
export type { Cipher, Signer } from "./signer/types.js";

export { deriveResultCipher, SealedBoxCipher } from "./crypto/cipher.js";

export { Verifier } from "./verify.js";
export type { VerifierOptions } from "./verify.js";

export { sealingFetch } from "./openai-compat.js";
export type { SealingFetch, SealingFetchOptions } from "./openai-compat.js";

// `sla.ts` is deliberately NOT on the barrel: `vorq/_sla.py` is private in the
// authority, nothing outside this package needs it, and the rule above adds
// only what an exported value forces. `scripts/*.mjs` deep-import from `dist/`
// because they are in-repo tooling, not consumers of the published package.

// The full error taxonomy. Every one of these is catchable and nameable.
export {
  AuthenticationError, BatchFailed, EscrowKeyUnverified, JobFailed, NotFoundError,
  ResultIntegrityError, StateConflictError, TransportError, ValidationError,
  VerificationError, VorqError, WaitTimeout,
} from "./errors.js";
export { ContainerError } from "./crypto/container.js";
export { DerivedKeyMismatch } from "./crypto/cipher.js";
export { NoWalletError, WalletRejectedError } from "./signer/browser-wallet.js";
