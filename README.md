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
- Prices and amounts are USD decimal strings (rates in USD per 1M units); payment by EIP-3009
  authorization in the deployment's USDC token; costs computed locally as exact decimals.
- Durable jobs: persist the id, re-attach later with `client.job(id)`.
- Sealed batches (`client.batches`).
- `sealingFetch`: use the stock `openai` package's Responses API over the sealed flow.
- ESM-only, TypeScript types included; one implementation for Node ≥ 22 and modern browsers.

## Installation

```sh
npm install @vorq-ai/client-sdk
```

Prereleases are published under the `next` dist-tag: `npm install @vorq-ai/client-sdk@next`.

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
  model: "moonshotai/kimi-k3",
  input: "Summarize the plot of Hamlet in three bullet points.",
  sla: "batch",
});
console.log(handle.id); // persist this before waiting

const result = await handle.result();
if (result instanceof TextResult) console.log(result.text, result.cost);
```

Use a dedicated wallet funded with your inference budget, never a main wallet's key.
VORQ runs on the Base Sepolia testnet: fund the wallet with free test USDC from
[faucet.circle.com](https://faucet.circle.com) (pick USDC and Base Sepolia). No ETH is needed.

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
