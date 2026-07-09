# Tab402

Pay-per-request API payments for autonomous agents, settled on Casper.

Tab402 is a payment rail that lets any agent or person pay for a premium API one call at a time, on-chain, from a balance they cannot overspend. It uses the [x402](https://x402.org) standard (HTTP 402 Payment Required) and settles every call as a CEP-18 token transfer on Casper testnet.

- Live app: https://tab402.fly.dev
- Roadmap: https://eienel.github.io/tab402
- Demo (no wallet needed): https://tab402.fly.dev/demo

## The problem

Autonomous agents can hold crypto, but the world's APIs still run on credit cards, subscriptions, and manually issued keys. An agent cannot sign up for a card, and nothing stops it from running up an unbounded bill. Tab402 solves both: metered, pay-as-you-go access with a hard spending cap enforced by the payment itself. When the balance runs out, calls stop. There is no overdraft.

## How a paid call works

```
client ── POST /v1/speak ─────────────▶ proxy (rail)
proxy  ── 402 Payment Required + price ▶ client
client ── signs x402 authorization ───▶ proxy
proxy  ── /verify, /settle ───────────▶ facilitator ── CEP-18 transfer ──▶ Casper
proxy  ── (only after settlement) ────▶ upstream API ── result ──▶ client
```

1. The client requests a paid endpoint and receives an HTTP 402 with the price.
2. It signs an x402 payment authorization with its Casper key.
3. The facilitator verifies the authorization and settles a CEP-18 token transfer on Casper, paying gas.
4. Only after the payment settles on-chain does the upstream API run and return its result.

Every call is a final on-chain settlement. The payment either lands on Casper or the request is refused.

## What is live today (Casper testnet)

- A working x402 paywall in front of a real third-party API (Deepgram text-to-speech).
- Our own CEP-18 x402 token deployed on Casper testnet.
- A self-hosted facilitator that verifies signatures and settles transfers on-chain.
- A dashboard with a house-funded "Try it" demo, a global settlement feed, and per-key usage tracking. Each settlement links to the Casper block explorer.
- A drop-in client snippet so any developer can point an agent at the gateway and have it pay automatically.

### Verify on-chain

| Item | Value |
|---|---|
| Network | `casper:casper-test` |
| CEP-18 x402 token package hash | `50ec5690bde5e72f5152cb5154119eb706961e376b19050534a95a13ead8baaf` |

Sample Testnet transaction:

| Transaction | What it is |
|---|---|
| [`2458f77b...e774b4`](https://testnet.cspr.live/transaction/2458f77bcd56ae960c02d0dfba616c63f3008c7ee7e87bcfd861c4da87e774b4) | An x402 settlement: a CEP-18 X402 transfer that paid for one text-to-speech API call through the rail |

Live settlement transactions are also visible in the dashboard's "Live transaction feed" at https://tab402.fly.dev/dashboard. Each row links to the transaction on `testnet.cspr.live`, so you can confirm that a payment for an API call is a real CEP-18 transfer on Casper.

## Components

| Service | Path | Port | Role |
|---|---|---|---|
| Facilitator | `src/facilitator` | 4022 | Verifies x402 signatures, settles CEP-18 transfers on-chain, pays gas |
| Proxy (rail) | `src/proxy` | 4021 | x402 paywall in front of the upstream API, serves the dashboard and demo |
| Agent | `src/agent` | n/a | Reference client that holds X402 tokens and pays per call; balance is its hard cap |
| Dashboard API | `src/dashboard` | mounted on 4021 | Key provisioning, funding, usage, stats, live feed |

## Test the live demo (no setup)

1. Open https://tab402.fly.dev/demo.
2. Choose a budget and run the agent, or open https://tab402.fly.dev/dashboard and use the "Try it" box.
3. Type a sentence and submit. Watch the staged status: signing the x402 authorization, settling on Casper, then synthesizing.
4. When it finishes, play the returned audio and click the green transaction link to see the settlement on `testnet.cspr.live`.
5. Scroll to the "Live transaction feed" to see the payment you just made recorded on-chain.

## Run locally

Prerequisites: Node 22+, a Casper testnet account funded with CSPR for gas.

```bash
npm install
cp .env.example .env

# 1. Generate a treasury/facilitator key and an agent key
npm run keygen -- ed25519 facilitator.pem
npm run keygen -- ed25519 agent.pem

# 2. Fund the facilitator account with testnet CSPR (for gas):
#    https://testnet.cspr.live/tools/faucet
#    Put the agent's account-hash in AGENT_ACCOUNT_HASH in .env.

# 3. Deploy the CEP-18 x402 token (mints supply to the facilitator account,
#    sends a starting balance to the agent, and writes ASSET_PACKAGE to .env)
npm run deploy-token

# 4. Fill DEEPGRAM_API_KEY and PAYEE_ADDRESS in .env, then run the stack:
npm run facilitator   # :4022
npm run proxy         # :4021  (dashboard at http://localhost:4021)
npm run agent         # makes one paid call and writes out.mp3
```

On success the agent writes `out.mp3` and the facilitator logs a settled on-chain transaction.

## Use it in your own agent

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";

const signer = await createClientCasperSigner("./agent.pem", casperSdk.KeyAlgorithm.ED25519);
const client = new x402Client((_v, o) => o.find(x => x.network.startsWith("casper:")) || o[0])
  .register("casper:*", new ExactCasperScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("https://tab402.fly.dev/v1/speak", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello, paid on Casper." }),
});
const audio = Buffer.from(await res.arrayBuffer()); // your MP3, paid on-chain
```

The agent's account needs an X402 token balance. Fund it from the dashboard, then it pays automatically on every 402.

## Configuration

Key environment variables (see `.env.example` for the full list):

| Variable | Meaning |
|---|---|
| `CAIP2_CHAIN_ID` | `casper:casper-test` |
| `RPCURL_CASPER_CASPER_TEST` | Casper testnet JSON-RPC endpoint |
| `ASSET_PACKAGE` | CEP-18 x402 token package hash (written by `deploy-token`) |
| `PRICE_MOTES` | Price per call, in token motes (9 decimals) |
| `PAYEE_ADDRESS` | Account that receives payments |
| `DEEPGRAM_API_KEY` | Key for the upstream API behind the paywall |
| `DEPLOYER_PRIVATE_KEY_PATH` | Treasury/facilitator key that holds the token supply and pays gas |

## Deploy

The app is a single container (facilitator plus proxy) deployed on Fly.io. See `Dockerfile` and `fly.toml`. The container starts the facilitator, waits for it to be ready, then starts the proxy, which serves the API, the dashboard, and the static pages.

## Why this is bigger than the demo

The reference integration gates Deepgram text-to-speech, but Deepgram is only the first API on the rail. The gateway is provider-agnostic: the same paywall, facilitator, and settlement flow work in front of any HTTP API. Text-to-speech was chosen because it produces an obvious, verifiable output (audio you can play) for a payment you can click through to on-chain. The value is the rail, not the specific API behind it.

## Roadmap

1. Claude, metered: the same rail in front of the Claude Messages API, so people and agents get pay-per-message access with token-accurate pricing and streaming.
2. Developer platform: API keys tied to on-chain balances, usage metering, per-key spend caps, and an SDK.
3. Hard guarantees: an Odra budget-escrow contract so the spend ceiling is enforced by a smart contract, not just per call.
4. Scale: mainnet, a fiat on-ramp for non-crypto users, a multi-provider marketplace, and agent-to-agent payments.

See the full roadmap at https://eienel.github.io/tab402.

## Tech stack

TypeScript, Express, the x402 protocol (`@x402/core`, `@x402/express`, `@x402/fetch`, `@make-software/casper-x402`), `casper-js-sdk`, a CEP-18 token on Casper testnet, Deepgram as the first paid upstream, deployed on Fly.io with the roadmap on GitHub Pages.

## License

MIT. See [LICENSE](LICENSE).

Built for the Casper Agentic Buildathon 2026.
