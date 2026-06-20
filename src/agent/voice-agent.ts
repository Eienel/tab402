// The demo hero: an autonomous voice agent with a hard spending cap.
//
// 1. Claude (the brain) writes a short script about a topic.
// 2. For each line, the agent pays the rail per call and gets back audio.
// 3. Its budget is a hard cap — when it runs out, the agent goes SILENT
//    mid-script. No overspend is possible.
//
// Live mode  (default): pays via x402; the cap is the agent's on-chain balance.
// Dev mode   (DEV_BYPASS_PAYMENT=true): proxy paywall off, budget simulated
//            locally so you can hear the whole loop without a funded chain.
//
//   npm run voice-agent

import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, type PaymentRequirements } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";
import Anthropic from "@anthropic-ai/sdk";

const { KeyAlgorithm } = casperSdk;

config();

const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const speakURL = `${baseURL}/v1/speak`;
const devBypass = process.env.DEV_BYPASS_PAYMENT === "true";
const topic = process.env.TOPIC || "why autonomous agents need their own money";
const costMotes = BigInt(process.env.PRICE_MOTES || "100000000");
let remaining = BigInt(process.env.AGENT_BUDGET_MOTES || "350000000"); // ~3.5 calls by default
const fmt = (m: bigint) => `${(Number(m) / 1e9).toFixed(2)} ${process.env.ASSET_SYMBOL || "X402"}`;

// ---- The brain: Claude writes the script (or a built-in fallback) -----------
async function writeScript(lineBudget: number): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("🧠 (no ANTHROPIC_API_KEY — using built-in script)");
    return [
      "I am an autonomous agent, and I hold my own money on Casper.",
      "Every sentence I speak, I pay for myself, per request.",
      "My budget is enforced on-chain. I literally cannot overspend.",
      "When my balance runs out, I stop. No surprise bills, ever.",
      "This is what machine-native payments look like.",
    ].slice(0, lineBudget);
  }
  console.log("🧠 Claude is writing the script...");
  const anthropic = new Anthropic({ apiKey: key });
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Write exactly ${lineBudget} short, punchy spoken lines (one sentence each, no numbering) for a voice agent demo about "${topic}". Each line stands alone. Return one line per row, nothing else.`,
      },
    ],
  });
  const text = msg.content.map(b => (b.type === "text" ? b.text : "")).join("\n");
  return text
    .split("\n")
    .map(l => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, lineBudget);
}

// ---- Pick the fetch: x402-paying (live) or plain (dev) ----------------------
async function makeFetch(): Promise<typeof fetch> {
  if (devBypass) return fetch;
  const pemPath = process.env.CLIENT_PRIVATE_KEY_PATH;
  if (!pemPath) {
    console.error("❌ CLIENT_PRIVATE_KEY_PATH required for live mode (or set DEV_BYPASS_PAYMENT=true)");
    process.exit(1);
  }
  const algo = process.env.CLIENT_KEY_ALGO === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(pemPath, algo);
  const selector = (_v: number, opts: PaymentRequirements[]) =>
    opts.find(o => o.network.startsWith("casper:")) || opts[0];
  const client = new x402Client(selector).register("casper:*", new ExactCasperScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}

async function main() {
  console.log(`\n🎙️  Voice agent starting — budget ${fmt(remaining)}, ${fmt(costMotes)}/line`);
  console.log(`    mode: ${devBypass ? "DEV (paywall bypassed)" : "LIVE (x402 on-chain)"}\n`);

  const maxLines = Number(remaining / costMotes);
  const script = await writeScript(Math.max(maxLines + 2, 5)); // ask for a couple extra to show the cut-off
  mkdirSync("out", { recursive: true });
  const pay = await makeFetch();

  let spoken = 0;
  for (let i = 0; i < script.length; i++) {
    const line = script[i];
    if (remaining < costMotes) {
      console.log(`\n🛑 Budget exhausted. The agent goes SILENT — ${script.length - i} line(s) left unspoken.`);
      console.log(`   "${line}" ...never voiced.`);
      break;
    }
    const res = await pay(speakURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`\n🛑 Payment/fulfillment failed (${res.status}) — agent stops. ${body.slice(0, 120)}`);
      break;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const file = `out/line-${String(i + 1).padStart(2, "0")}.mp3`;
    writeFileSync(file, audio);
    remaining -= costMotes;
    spoken++;
    console.log(`🔊 #${i + 1} paid ${fmt(costMotes)} → ${audio.length}B ${file}  | left: ${fmt(remaining)}`);
    console.log(`     "${line}"`);
  }

  console.log(`\n── Ledger ─────────────────────────────────`);
  console.log(`   lines voiced : ${spoken}`);
  console.log(`   spent        : ${fmt(costMotes * BigInt(spoken))}`);
  console.log(`   remaining    : ${fmt(remaining)}`);
  console.log(`   audio        : ./out/line-*.mp3`);
}

main().catch(err => {
  console.error(err?.response?.data?.error ?? err);
  process.exit(1);
});
