---
title: Quickstart
description: Install @vorq-ai/client-sdk, submit a first job from Node and read its result.
---

> **VORQ runs on the Base Sepolia testnet.** Jobs are paid in test USDC, which is free. Fund
> your wallet before step 3: open [faucet.circle.com](https://faucet.circle.com), pick **USDC**
> and **Base Sepolia**, paste your wallet address and send. No ETH is needed: the coordinator
> pays the gas.

This walks one path end to end: a Node script, a local wallet key, one text job. For a web page,
pass a [browser wallet](./guides/use-a-browser-wallet.md) as the client's `signer`.

You need Node ≥ 22.

## 1. Install

```sh
npm install @vorq-ai/client-sdk
```

Prereleases are published under the `next` dist-tag: `npm install @vorq-ai/client-sdk@next`.

## 2. Set your wallet key

```sh
export VORQ_WALLET_KEY=0x…   # the dedicated wallet's private key
```

Use a **dedicated wallet funded with your inference budget**, never a main wallet's key. The
client signs the session handshake, every order and every payment with it, and derives the key
your results are sealed to from one signature, so the wallet is the only thing to back up.

## 3. Submit a job and read the result

```ts
// quickstart.mjs
import { Client, TextResult } from "@vorq-ai/client-sdk";

const client = new Client(); // signs with $VORQ_WALLET_KEY

const handle = await client.submit({
  model: "moonshotai/kimi-k3",
  input: "Summarize the plot of Hamlet in three bullet points.",
  sla: "batch",
});
console.log("job", handle.id); // store this before waiting

const result = await handle.result();
if (result instanceof TextResult) {
  console.log(result.text);
  console.log("usage", result.usage, "cost", result.cost);
}
```

Run it:

```sh
node quickstart.mjs
```

## What just happened

- `new Client()` talks to the VORQ coordinator at `https://api.vorq.co` and signs with
  `$VORQ_WALLET_KEY`.
- `submit` asks the coordinator for the market in the 24-hour window (`sla: "batch"`) and signs
  the first provider's own ask. To cap what you pay, pass `maxRateIn` and `maxRateOut`; see
  [Pricing and payment](./concepts/pricing-and-payment.md).
- `submit` seals the input, signs the order and the payment authorization, and posts the job. It
  returns as soon as the job is on the book.
- `result()` polls until the job ends, fetches the sealed result and opens it. A job that fails
  raises `JobFailed`; a wait that runs out raises `WaitTimeout`, and the job keeps running.

## Open the cabinet with MetaMask

The cabinet at [vorq.co/app](https://vorq.co/app) shows your jobs, results and spending. To use
it with the wallet from step 2:

1. **Add Base Sepolia.** In MetaMask, open the network selector, then **Add network → Add a
   network manually**, and fill in:
   - Network name: `Base Sepolia`
   - RPC URL: `https://sepolia.base.org`
   - Chain ID: `84532`
   - Currency symbol: `ETH`
   - Block explorer: `https://sepolia.basescan.org`

   Save, then switch to Base Sepolia.
2. **Import your wallet.** Open the account menu, choose **Add account → Import account** and
   paste your `VORQ_WALLET_KEY`.
3. **Add the USDC token.** Open **Tokens → Import tokens → Custom token** and enter
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The symbol (`USDC`) and decimals (`6`) fill in
   by themselves. Select **Next**, then **Import**.
4. **Sign in.** Open [vorq.co/app](https://vorq.co/app), select **Connect wallet** and sign the
   message. It moves no funds and costs no gas. Your job is under **Jobs**; opening a result asks
   for one more signature, which derives the same result key as the client.

## Next steps

- [Persist and resume jobs](./guides/persist-and-resume-jobs.md): survive a restart without paying
  twice.
- [Generate images and video](./guides/generate-images-and-video.md).
- [Submit a batch](./guides/submit-a-batch.md).
- [Use the openai package](./guides/use-the-openai-package.md).
- [Submit reference](./reference/submit.md): every submission option.
