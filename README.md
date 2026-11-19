# @vorq-ai/client-sdk

JavaScript and TypeScript client for the VORQ inference exchange.

[![npm](https://img.shields.io/npm/v/@vorq-ai/client-sdk.svg)](https://www.npmjs.com/package/@vorq-ai/client-sdk)

Submit inference jobs, read their results and pay for them from a browser or from Node, with no
backend of your own in between. Every submission is sealed: the payload is encrypted in your
process, the order is signed with your wallet, and the result comes back sealed to a key only
you hold. The coordinator sees routing terms and ciphertext, never a prompt or an output.

## Features

- One `submit` / `result` flow for text, image, video and embedding models.
- Browser wallets over EIP-6963 (`BrowserWalletSigner`) and local keys for Node
  (`PrivateKeySigner`).
- Result key derived from the wallet (`deriveResultCipher`): one key to hold and back up.
- Prices and amounts are USD decimal strings (rates in USD per 1M units); jobs are paid from a
  prepaid USDC balance, topped up by gasless EIP-3009 deposits and withdrawable at any time;
  costs computed locally as exact decimals.
- `client.balance()`, `client.deposit(amount)`, `client.withdraw(amount)`; `submit` deposits a
  shortfall itself unless the client is built with `autoDeposit: false`, which raises
  `InsufficientBalance` instead.
- Durable jobs: persist the id, re-attach later with `client.job(id)`.
- Sealed batches (`client.batches`).
- `sealingFetch`: use the stock `openai` package's Responses API over the sealed flow.
- ESM-only, TypeScript types included; one implementation for Node ≥ 22 and modern browsers.

## Installation

```sh
npm install @vorq-ai/client-sdk
```

The OpenAI-compatible path also needs the `openai` package, which you install yourself:
`npm install openai`.

## Quick start

```sh
export VORQ_WALLET_KEY=0x...   # a dedicated wallet funded with your inference budget
```

```ts
import { Client, TextResult } from "@vorq-ai/client-sdk";

const client = new Client(); // signs with $VORQ_WALLET_KEY; pass a BrowserWalletSigner in a browser

const handle = await client.submit({
  model: "moonshotai/kimi-k3.1-pro:mxfp4",
  input: "Summarize the plot of Hamlet in three bullet points.",
  sla: "batch",
});
console.log(handle.id); // persist this before waiting

const result = await handle.result();
if (result instanceof TextResult) console.log(result.text, result.cost);
```

Use a dedicated wallet funded with your inference budget, never a main wallet's key.
VORQ runs on Base: fund the wallet with USDC on Base (buy or withdraw it to the Base network,
or bridge it). No ETH is needed: deposits into the prepaid balance are gasless signatures the
coordinator relays. The first `submit` deposits what the job needs (plus a flat deposit fee);
`client.deposit("10")` tops up ahead of time and `client.withdraw(amount)` takes the balance
back.

## Documentation

Full documentation: https://docs.vorq.co/docs/js

- [Quickstart](https://docs.vorq.co/docs/js/quickstart)
- [Use a browser wallet](https://docs.vorq.co/docs/js/guides/use-a-browser-wallet)
- [Persist and resume jobs](https://docs.vorq.co/docs/js/guides/persist-and-resume-jobs)
- [Submit a batch](https://docs.vorq.co/docs/js/guides/submit-a-batch)
- [Use the openai package](https://docs.vorq.co/docs/js/guides/use-the-openai-package)
- [API reference](https://docs.vorq.co/docs/js/reference/client)

## Contributing

```sh
npm install
npm run build        # tsc -> dist/
npm test             # node and browser test projects
npm run typecheck
```

## License

[Apache-2.0](LICENSE).
