---
title: Overview
description: What @vorq-ai/client-sdk is, who it is for, and where to start.
---

`@vorq-ai/client-sdk` is the JavaScript and TypeScript client for the VORQ inference exchange. It
submits inference jobs, pays for them and reads their results, from Node or straight from a
browser page, with no backend of your own in between.

Every submission is sealed. The payload is encrypted in your process, the order is signed with
your wallet, and the result comes back sealed to a key only you hold. The coordinator sees
routing terms and ciphertext, never a prompt or an output.

## Who it is for

- **Node services and scripts** that hold a dedicated wallet key and submit jobs in the
  background.
- **Browser apps** where each user connects their own wallet and pays for their own jobs.
- **Code that already uses the `openai` package**, through a drop-in `fetch` that seals every
  Responses request.

## What it covers

- One `submit` / `result` flow for text, image, video and embedding models.
- Browser wallets over EIP-6963 (`BrowserWalletSigner`) and local keys for Node
  (`PrivateKeySigner`).
- A result key derived from the wallet (`deriveResultCipher`): one key to hold and back up.
- Prices and amounts are USD decimal strings (rates in USD per 1M units); payment by EIP-3009
  authorization in the deployment's USDC token; costs computed locally as exact decimals.
- Durable jobs: store the id, re-attach later with `client.job(id)`.
- Sealed batches (`client.batches`).
- `sealingFetch`, which runs the stock `openai` package's Responses API over the sealed flow.

The package is ESM-only, ships TypeScript types, and has one implementation for Node ≥ 22 and
modern browsers.

## Where to start

- [Quickstart](./quickstart.md): install, submit a first job from Node and read its result.
- [Use a browser wallet](./guides/use-a-browser-wallet.md): the same flow in a web page.
- [Job lifecycle](./concepts/job-lifecycle.md): what happens between `submit` and `result`.
- [Client reference](./reference/client.md): the full API surface, split by area.
