# Tab

> Your agent's running tab, on-chain. Open a Tab, fund it once, and your agent pays
> per call over x402 — capped by a balance it can't exceed.

A crypto-funded, **spend-bounded** API payment rail for autonomous agents, built on
[Casper](https://casper.network) x402 micropayments.

Agents hold a crypto budget but the world's APIs run on cards. This rail lets an
agent pay for a real API **per request** from an on-chain balance — and enforces a
hard spending cap the agent physically cannot exceed.

The reference integration gates **Deepgram text-to-speech** behind an x402 paywall:
the agent pays in WCSPR on Casper testnet, and the rail fulfills the call using the
operator's Deepgram credits.

```
agent ──POST /v1/speak──▶ proxy(rail) ──402 + price──▶ agent
agent ──signs x402 auth──▶ proxy ──/verify,/settle──▶ facilitator ──tx──▶ Casper testnet
proxy ──(paid)──▶ Deepgram TTS ──audio──▶ agent
```

## Components

| Service | Path | Port | Role |
|---|---|---|---|
| Facilitator | `src/facilitator` | 4022 | Verifies signatures, settles CEP-18 transfers on-chain (pays gas) |
| Proxy (rail) | `src/proxy` | 4021 | x402 paywall in front of Deepgram TTS |
| Agent | `src/agent` | — | Holds a WCSPR budget; pays per call; budget = hard cap |

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Generate keys: `npm run keygen -- ed25519 facilitator.pem` and again for `agent.pem`.
4. Fund both accounts with testnet CSPR ([faucet](https://testnet.cspr.live/tools/faucet)).
   Wrap some CSPR → WCSPR for the **agent** so it has a budget to spend.
5. Fill the secrets in `.env`: facilitator PEM, `PAYEE_ADDRESS`, `DEEPGRAM_API_KEY`,
   agent PEM path. Testnet RPC + WCSPR package hash are pre-filled.

## Run (three terminals)

```bash
npm run facilitator   # :4022
npm run proxy         # :4021
npm run agent         # makes one paid TTS call -> out.mp3
```

On success the agent writes `out.mp3` and the facilitator logs a settled on-chain tx.

## Status

- [x] Spine: x402-gated proxy → Deepgram, facilitator, paying agent (this repo)
- [ ] Website + developer onboarding (get API key, load on-chain balance)
- [ ] Hard-cap budget-escrow contract (Odra) — cumulative ceiling, per-merchant sub-limits

Built for the Casper Agentic Buildathon 2026.
