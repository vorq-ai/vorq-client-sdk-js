---
title: Sealing and keys
description: How a payload is encrypted before it leaves your process, who can open it, and where the result key comes from.
---

Every submission is sealed. There is no plaintext mode: a client without a signer cannot submit
at all, and one without an explicit cipher derives its result key from the signer.

## What the coordinator sees

The coordinator relays orders, payments and cancels, and stores files. It sees the signed terms
(model id, window, rates, unit counts, recipient, expiry) and ciphertext. It never sees the
prompt, the model input, your result key, your `custom_id`, or the output.

## The container

The client builds one sealed container per job:

1. An envelope holding your address, your result public key, the model input and, if you set
   one, your `custom_id`, serialized as canonical JSON.
2. A fresh random 32-byte seed. A data key is derived from the seed and your address
   (HKDF-SHA256), and the envelope is encrypted under it (XSalsa20-Poly1305).
3. The seed is sealed to the recipient's Curve25519 key with an anonymous sealed box.

The container is a version byte, the sealed seed and the ciphertext. The order signs a commitment
to it, and the job id is derived from your address and that commitment.

Because the data key mixes in the owner's address, the sealed seed cannot be lifted into someone
else's order: whoever opens it under a different owner derives a key that does not decrypt the
payload.

## Designated orders

Naming `provider` seals the seed to that provider's published key, read from its registry
record. Only that provider can open the job, and only it can claim it.

With `confidential: true`, the SDK also verifies the provider's attestation evidence before
sealing, and refuses rather than choosing another provider. It needs a client built with a
`Verifier`. See [Verifier](../reference/verifier.md) for which evidence this release accepts.

## Open orders

An order with no `provider` seals the seed to the **coordinator's escrow key** instead. The order
rests on the book until a provider whose ask it meets claims it; that provider then obtains the
seed from the escrow, which releases it only against the job's on-chain claim.

The SDK seals to the escrow key only after verifying its announcement: fresh within ±600 seconds,
bound to the announced key by its evidence, and not a debug build. No verifier, or a key that
fails the check, raises `EscrowKeyUnverified` and posts nothing. A verified key is reused for
three hours.

## The result key

Results come back sealed to the `cipher` the client was built with: its public key rides inside
the sealed envelope, so only the provider that opens the job learns where to seal the answer.

`deriveResultCipher(signer)` makes that cipher from the wallet: the wallet signs a fixed message
(`personal_sign`), and the Curve25519 key is derived from the `keccak256` of the signature. The
same wallet derives the same key every time, on any device, so there is nothing extra to store or
back up. The derivation is shared with the VORQ Python SDK, so either SDK can open a result the
other's submission asked for.

It relies on the wallet producing deterministic (RFC 6979) signatures, as wallets do in practice.
If the same address derives a different key within one process, `DerivedKeyMismatch` is raised;
build a `SealedBoxCipher` yourself and pass it instead.

To hold the result key elsewhere (a KMS, or one key shared by a fleet), construct a
`SealedBoxCipher` from your own 32-byte private key. Results sealed to one key open only with
that key.

## Reading results

A settled job names its result by content id. The client fetches those bytes from a storage
gateway with no credentials, since the content id is the entitlement, and opens them locally.
A result that is not valid, or does not open with your key, raises `ResultIntegrityError`.
