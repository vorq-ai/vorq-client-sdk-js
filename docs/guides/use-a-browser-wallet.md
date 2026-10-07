---
title: Use a browser wallet
description: Discover the user's wallets, connect one, and submit jobs from a web page.
---

In a browser the user's own wallet signs and pays. Everything on the package's main entry runs
unchanged in the page; only the signer differs from Node.

## Discover and connect

Every installed wallet announces itself over EIP-6963, so `discover()` returns a **list**. With
one wallet, take it; with several, let the user choose.

```ts
import { BrowserWalletSigner } from "@vorq-ai/client-sdk";

const wallets = await BrowserWalletSigner.discover();
if (wallets.length === 0) throw new Error("no wallet found");

// More than one? Show `info.name` and `info.icon` and let the user pick.
for (const wallet of wallets) console.log(wallet.info.name, wallet.info.rdns);

const signer = await BrowserWalletSigner.from(wallets[0]); // prompts eth_requestAccounts
console.log(signer.address, signer.info.name);
```

- `discover()` listens for announcements for 100 ms by default (`{ timeoutMs }` changes it).
- If no wallet announces itself but `window.ethereum` exists, that injected provider is returned
  as the only entry, named `"Injected Wallet"` with `rdns: "unknown"`.
- `from()` binds the signer to the first account the wallet returns. A dismissed prompt raises
  `WalletRejectedError`; a wallet with no account raises `NoWalletError`.

## Switch to the right chain

The session handshake, every order and every payment are EIP-712 typed data bound to the
deployment's chain id. Wallets generally refuse to sign typed data for a chain other than the one
they are switched to, and the SDK does not switch networks for you. Read the chain id from the
coordinator and switch first:

```ts
import { Client } from "@vorq-ai/client-sdk";

const baseUrl = "https://api.vorq.co";
const { chainId } = await new Client({ baseUrl }).chainContext(); // no wallet needed for this read
await wallets[0].provider.request({
  method: "wallet_switchEthereumChain",
  params: [{ chainId: `0x${chainId.toString(16)}` }],
});
```

## Build the client

```ts
import { Verifier, deriveResultCipher } from "@vorq-ai/client-sdk";

const client = new Client({
  baseUrl,
  signer,
  cipher: await deriveResultCipher(signer), // one signing prompt
  verifier: new Verifier(baseUrl),          // only needed for open orders
});
```

`deriveResultCipher` asks for one `personal_sign` signature over a fixed message and derives the
result key from it. The same wallet always derives the same key, so results stay readable after a
reload or on another device, and there is nothing else to store. See
[Sealing and keys](../concepts/sealing-and-keys.md#the-result-key).

## What the user is asked to sign

| When | Prompt |
| --- | --- |
| `BrowserWalletSigner.from()` | Connect (`eth_requestAccounts`). |
| `deriveResultCipher()` | `personal_sign` over a fixed message, on every call. |
| The first request that needs a session | `VorqSession` typed data (the login handshake). Repeated when the session expires. |
| Each `submit` | `Order` typed data, then `ReceiveWithAuthorization` typed data (the payment). A gas-fee re-quote asks for the payment signature again. |
| Each `handle.cancel()` | `Cancel` typed data. |

Any prompt the user dismisses raises `WalletRejectedError` and sends nothing further.

## Store job ids across reloads

A page reload loses the handle but never the job. Save the id as soon as `submit` returns:

```ts
const handle = await client.submit({ model, input, sla: "async", maxRateIn, maxRateOut, provider });
localStorage.setItem("vorq:pending", handle.id);

// after a reload:
const jobId = localStorage.getItem("vorq:pending");
if (jobId !== null) {
  const result = await client.job(jobId).result();
}
```

See [Persist and resume jobs](./persist-and-resume-jobs.md).

## Browser specifics

- **CORS.** A page on another origin needs the coordinator to allow that origin.
- **Retries.** Automatic retries depend on the `x-vorq-retryable` response header, which a
  cross-origin page can read only if the coordinator exposes it.
- **Cancel clock check.** Before signing a cancel, the SDK compares your clock with the
  coordinator's `Date` header. Cross-origin, that header is not readable unless exposed, so the
  local check is skipped and the chain enforces its ±600 s bound on its own.
- **No environment.** `PrivateKeySigner` cannot read `$VORQ_WALLET_KEY` in a page; use
  `BrowserWalletSigner`.
- **Result bytes** are read from a content-addressed storage gateway, not from the coordinator.
  See [Client reference](../reference/client.md#reading-result-bytes).
