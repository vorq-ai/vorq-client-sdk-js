---
title: Signers and ciphers
description: The Signer and Cipher interfaces, PrivateKeySigner, BrowserWalletSigner, SealedBoxCipher and deriveResultCipher.
---

## Interfaces

```ts
interface Signer {
  readonly address: Address;
  signOrderV2(terms: OrderTerms, ctx: ChainContext): Promise<Hex>;
  signCancel(jobId: Hex, issuedAt: bigint, ctx: ChainContext): Promise<Hex>;
  signPaymentAuthorization(args: {
    amount: bigint; jobId: Hex; expiresAt: bigint; ctx: ChainContext;
  }): Promise<Hex>;
  signNonce(nonce: string, chainId: number): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

interface Cipher {
  readonly publicKey: string;          // 64 lowercase hex characters, no 0x
  encrypt(data: Uint8Array): Uint8Array;
  decrypt(data: Uint8Array): Uint8Array;
}
```

`Address` and `Hex` are viem's types. `OrderTerms` is built by the client and is not exported.
Every `Signer` method is asynchronous, because a wallet prompt is a promise; `Cipher` is
synchronous.

| Method | Signs |
| --- | --- |
| `signNonce` | `VorqSession { address, nonce }` under the domain `"VORQ Session"`, version `"1"`, on `chainId`. The session handshake. |
| `signOrderV2` | `Order { c, modelId, slaSecs, rateIn, rateOut, unitsIn, unitsOut, designated, expiresAt }` under `"VORQ Jobs"`, version `"2"`, verifying contract `ctx.jobRegistry`. |
| `signCancel` | `Cancel { jobId, issuedAt }` under the same domain as orders. |
| `signPaymentAuthorization` | EIP-3009 `ReceiveWithAuthorization` under the payment token's own domain (`ctx.tokenDomain`, `ctx.usdc`): `from` the wallet, `to` `ctx.jobRegistry`, `value` the amount, `validAfter` 0, `validBefore` `expiresAt + 1`, `nonce` the job id. |
| `signMessage` | An EIP-191 `personal_sign` message. Used by `deriveResultCipher`. |

Implement `Signer` yourself only to keep the key elsewhere (a KMS, an HSM, a remote signer). Use a
**dedicated wallet funded with your inference budget, never a main wallet's key**.

## `PrivateKeySigner`

For Node and standalone use. Holds a secp256k1 private key in the process; only signatures and
the address leave it.

```ts
new PrivateKeySigner();                                  // key from $VORQ_WALLET_KEY
new PrivateKeySigner("0x…");                             // explicit; the 0x prefix is optional
new PrivateKeySigner(undefined, { keyEnv: "MY_KEY" });   // key from another variable
PrivateKeySigner.generate();                             // a fresh random wallet
```

`.address` is the wallet address. No key, and no variable set, throws a plain `Error`. In a
browser there is no environment, so the key must be passed; use `BrowserWalletSigner` there.

## `BrowserWalletSigner`

For browsers, over EIP-6963 discovery and EIP-1193 providers.

```ts
BrowserWalletSigner.discover(options?: { window?: Window; timeoutMs?: number }): Promise<DiscoveredWallet[]>
BrowserWalletSigner.from(wallet: DiscoveredWallet): Promise<BrowserWalletSigner>
signer.address   // the bound account, checksummed
signer.info      // { uuid, name, icon, rdns } as announced by the wallet
```

- `discover()` collects `eip6963:announceProvider` events for `timeoutMs` (default 100 ms) and
  returns one entry per wallet. If none announced itself and `window.ethereum` exists, it
  returns that provider alone, as `{ uuid: "injected", name: "Injected Wallet", icon: "", rdns:
  "unknown" }`. Outside a browser it returns `[]`.
- `DiscoveredWallet` is `{ info, provider }`; `provider` is the wallet's `Eip1193Provider`.
- `from()` calls `eth_requestAccounts` and binds to the first account. No account raises
  `NoWalletError`.
- Typed data is signed with `eth_signTypedData_v4`, messages with `personal_sign`.
- A prompt the user dismisses (EIP-1193 error `4001`) raises `WalletRejectedError`; other wallet
  errors propagate as thrown. An answer that is not a hex signature raises `VorqError`.
- The signer does not switch networks. See
  [Use a browser wallet](../guides/use-a-browser-wallet.md#switch-to-the-right-chain).

## `SealedBoxCipher`

A Curve25519 sealed-box cipher (libsodium-compatible `crypto_box_seal`): anonymous sender,
authenticated recipient.

```ts
new SealedBoxCipher(privateKey: Uint8Array | string, options?: { recipientPublicKey?: string | Uint8Array })
SealedBoxCipher.generate()                 // random key
SealedBoxCipher.fromSeed(seed: Uint8Array) // deterministic, from the first 32 bytes
cipher.publicKey                           // 64 lowercase hex, no 0x
cipher.privateKeyHex
cipher.setRecipient(key: string | Uint8Array)
cipher.encrypt(data) / cipher.decrypt(data)
```

`decrypt` opens data sealed to this key; the SDK uses it to open results. `encrypt` seals to the
recipient set on the instance and throws until one is set.

The private key is held in a private field: `JSON.stringify` and Node's `console.log` show only
the public key. `privateKeyHex` returns it on request.

## `deriveResultCipher`

```ts
deriveResultCipher(signer: Pick<Signer, "address" | "signMessage">): Promise<SealedBoxCipher>
```

Asks the wallet to `personal_sign` the fixed message `VORQ-ENC-V1`, and derives the X25519 key
from the `keccak256` of the signature. The same wallet derives the same key every time. See
[Sealing and keys](../concepts/sealing-and-keys.md#the-result-key).

If the same address derives a different key within one process (a wallet whose signatures are
not deterministic), `DerivedKeyMismatch` is raised; pass an explicit cipher instead.
