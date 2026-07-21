// The rail: an Express resource server that gates a Deepgram TTS endpoint
// behind an x402 paywall. On payment (CEP-18 settled on Casper testnet), it
// forwards the request to Deepgram using the operator's API key (free credits)
// and returns the audio. Adapted from make-software/casper-x402 examples/server.

import cors from "cors";
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { FacilitatorConfig, HTTPFacilitatorClient } from "@x402/core/server";
import { AssetAmount, Network } from "@x402/core/types";
import { x402Client, wrapFetchWithPayment, type PaymentRequirements } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as ExactCasperClientScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import dashboardApi from "../dashboard/api.js";
import { estimateForRoute, costMotes, maxOutputTokens, toX402 } from "./pricing.js";
import { chooseModel, models, PREMIUM, estTokens } from "./router.js";

config();

interface Env {
  port: number;
  payeeAddress: string;
  facilitatorURL: string;
  facilitatorAPIKey: string;
  chainID: string;
  assetPackage: string;
  assetName: string;
  assetSymbol: string;
  priceMotes: string;
  deepgramApiKey: string;
  deepgramModel: string;
  devBypass: boolean;
}

function parseEnv(): Env {
  // DEV-ONLY: skip the x402 paywall to test the Deepgram + agent loop without
  // a funded chain. Never enable in the real demo - it removes the on-chain part.
  const devBypass = process.env.DEV_BYPASS_PAYMENT === "true";
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      if (devBypass) return "dev-bypass";
      console.error(`❌ ${key} environment variable is required`);
      process.exit(1);
    }
    return v as string;
  };
  return {
    port: parseInt(process.env.PROXY_PORT || "4021", 10),
    payeeAddress: required("PAYEE_ADDRESS"),
    // The facilitator runs in the same container (see Dockerfile CMD), so default
    // to localhost instead of hard-requiring the var — avoids a crash-loop when
    // it isn't set as a platform secret.
    facilitatorURL: process.env.FACILITATOR_URL || "http://127.0.0.1:4022",
    facilitatorAPIKey: process.env.FACILITATOR_API_KEY || "",
    chainID: required("CAIP2_CHAIN_ID"),
    assetPackage: required("ASSET_PACKAGE"),
    assetName: process.env.ASSET_NAME || "Wrapped CSPR",
    assetSymbol: process.env.ASSET_SYMBOL || "WCSPR",
    priceMotes: process.env.PRICE_MOTES || "100000000",
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    deepgramModel: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
    devBypass,
  };
}

const cfg = parseEnv();
const assetPackage = cfg.assetPackage.replace(/^hash-/, "");
const chainID = cfg.chainID as Network;

// ---- Facilitator client -----------------------------------------------------
const facilitatorConfig: FacilitatorConfig = { url: cfg.facilitatorURL };
if (cfg.facilitatorAPIKey) {
  const auth = { Authorization: cfg.facilitatorAPIKey };
  facilitatorConfig.createAuthHeaders = async () => ({
    verify: auth,
    settle: auth,
    supported: auth,
    bazaar: auth,
  });
}
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

// ---- Casper "exact" scheme: charge a per-request price in our CEP-18 ---------
const assetAmount: AssetAmount = {
  asset: assetPackage,
  amount: cfg.priceMotes,
  extra: { name: cfg.assetName, symbol: cfg.assetSymbol, version: "1", decimals: "9" },
};

// The price is computed per request (see the pricing middleware below) and
// carried here through AsyncLocalStorage, so the money parser settles the
// amount that matches actual usage. Falls back to the flat PRICE_MOTES.
const priceStore = new AsyncLocalStorage<string>();

const casperScheme = new ExactCasperScheme()
  .registerAsset(chainID, assetPackage, 9)
  .registerMoneyParser(() =>
    Promise.resolve({ ...assetAmount, amount: priceStore.getStore() ?? cfg.priceMotes }),
  );

// ---- App --------------------------------------------------------------------
const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Accept", "Authorization", "Content-Type", "Origin", "Payment-Signature"],
    exposedHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-PAYMENT-RESPONSE",
      "X-DEMO-MODE",
      "X-Tab-Price-Motes",
      "X-Tab-Price-X402",
      "X-Tab-Price-Basis",
      "X-Tab-Model",
      "X-Tab-Reason",
      "X-Tab-Savings-X402",
      "X-Tab-Reserved-X402",
      "X-Tab-Actual-X402",
      "X-Tab-Credit-X402",
    ],
    maxAge: 24 * 60 * 60,
  }),
);
app.use(express.json());

// ---- Mount dashboard API routes before payment middleware ----
// These are public, developer-facing endpoints (no payment required)
app.use("/api", dashboardApi);

// ---- Frontend pages (served from web/, no payment required) ----
const WEB_DIR = resolve(process.cwd(), "web");
const page = (file: string) => (_req: express.Request, res: express.Response) => {
  try {
    res.type("html").send(readFileSync(resolve(WEB_DIR, file), "utf8"));
  } catch (e) {
    console.error(`Failed to serve ${file}:`, e);
    res.status(500).send("Page unavailable");
  }
};
app.get("/", page("index.html"));
app.get("/dashboard", page("dashboard.html"));
app.get("/demo", page("demo.html"));
// Static assets (logo/favicon) from web/, public. After the page routes so it
// only serves extra files; before the paywall so it's not payment-gated.
app.use(express.static(WEB_DIR));

// ---- House-paid demo: visitor types a sentence, the treasury key pays the
// x402 invoice on-chain, and the MP3 comes back for download. This is the
// "try it without a wallet" path; API users hit /v1/speak with their own key.
const DEMO_KEY_PATH = process.env.DEMO_AGENT_KEY_PATH || "./facilitator.pem";
const DEMO_MAX_CHARS = parseInt(process.env.DEMO_MAX_CHARS || "300", 10);

// Build a fresh payment client per request - reusing one across calls can
// carry stale scheme state into the next payment authorization.
async function getDemoFetch(): Promise<typeof fetch> {
  const selector = (_v: number, options: PaymentRequirements[]): PaymentRequirements =>
    options.find(o => o.network.startsWith("casper:")) || options[0];
  const algo =
    (process.env.DEMO_AGENT_KEY_ALGO || "ed25519") === "secp256k1"
      ? casperSdk.KeyAlgorithm.SECP256K1
      : casperSdk.KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(DEMO_KEY_PATH, algo);
  const client = new x402Client(selector).register("casper:*", new ExactCasperClientScheme(signer));
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}

let demoInFlight = 0;
app.post("/api/demo/speak", async (req, res) => {
  const text = ((req.body?.text as string) || "").trim();
  if (!text) return res.status(400).json({ error: "Body must include non-empty 'text'." });
  if (text.length > DEMO_MAX_CHARS)
    return res.status(400).json({ error: `Demo text is capped at ${DEMO_MAX_CHARS} characters.` });
  if (demoInFlight >= 3)
    return res.status(429).json({ error: "Demo is busy - try again in a few seconds." });

  demoInFlight++;
  try {
    let audioRes: Response;
    if (cfg.devBypass) {
      res.set("X-DEMO-MODE", "payment-bypassed");
      audioRes = await deepgramSpeak(text);
    } else {
      const pay = await getDemoFetch();
      audioRes = await pay(`http://127.0.0.1:${cfg.port}/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    }
    if (!audioRes.ok) {
      const detail = await audioRes.text();
      const hdrs: Record<string, string> = {};
      audioRes.headers.forEach((v, k) => (hdrs[k] = v));
      console.error("Demo speak failed", audioRes.status, detail, JSON.stringify(hdrs));
      const hint =
        audioRes.status === 402
          ? "payment rejected - check treasury X402/CSPR balance and facilitator logs"
          : undefined;
      return res
        .status(502)
        .json({ error: "demo_speak_failed", status: audioRes.status, detail, hint });
    }
    const settle =
      audioRes.headers.get("PAYMENT-RESPONSE") || audioRes.headers.get("X-PAYMENT-RESPONSE");
    if (settle) res.set("PAYMENT-RESPONSE", settle);
    const audio = Buffer.from(await audioRes.arrayBuffer());
    res.set("Content-Type", audioRes.headers.get("content-type") || "audio/mpeg");
    res.set("Content-Disposition", 'attachment; filename="tab402.mp3"');
    res.send(audio);
    console.log(`🎁 demo TTS fulfilled (${audio.length} bytes): "${text.slice(0, 60)}"`);
  } catch (err) {
    console.error("Demo speak error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  } finally {
    demoInFlight--;
  }
});

// ---- Dynamic pricing --------------------------------------------------------
// Public quote endpoint: what would this call cost? Lets the agent (or the demo
// UI) show the price before paying. No payment required.
app.get("/v1/quote", (req, res) => {
  const quote =
    req.query.prompt !== undefined
      ? estimateForRoute("POST /v1/complete", {
          prompt: String(req.query.prompt),
          model: req.query.model ? String(req.query.model) : undefined,
        })
      : estimateForRoute("POST /v1/speak", { text: String(req.query.text ?? "") });
  res.json({ asset: cfg.assetSymbol, decimals: 9, ...quote });
});

// Price each paid call from its actual cost driver and hand the amount to the
// money parser via AsyncLocalStorage, so the on-chain settlement matches.
const PRICED_ROUTES = new Set(["/v1/speak", "/v1/complete"]);
app.use((req, res, next) => {
  if (req.method === "POST" && PRICED_ROUTES.has(req.path)) {
    const quote = estimateForRoute(`POST ${req.path}`, req.body);
    if (quote) {
      res.set("X-Tab-Price-Motes", quote.motes);
      res.set("X-Tab-Price-X402", quote.x402);
      res.set("X-Tab-Price-Basis", quote.basis);
      if (quote.meta.model) {
        res.set("X-Tab-Model", String(quote.meta.model));
        res.set("X-Tab-Reason", String(quote.meta.reason));
        res.set("X-Tab-Savings-X402", String(quote.meta.savingsX402));
      }
      return priceStore.run(quote.motes, () => next());
    }
  }
  next();
});

if (cfg.devBypass) {
  console.warn("⚠️  DEV_BYPASS_PAYMENT=true - x402 paywall DISABLED. Dev only; no on-chain payment.");
} else {
  app.use(
    paymentMiddleware(
      {
        "POST /v1/speak": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.001",
              network: chainID,
              payTo: cfg.payeeAddress,
            },
          ],
          description: "Text-to-speech via Deepgram, paid per call over x402",
          mimeType: "audio/mpeg",
        },
        "POST /v1/complete": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.001",
              network: chainID,
              payTo: cfg.payeeAddress,
            },
          ],
          description: "LLM completion via a cost-routed Gemini model, paid per call over x402",
          mimeType: "application/json",
        },
      },
      new x402ResourceServer(facilitatorClient).register(chainID, casperScheme),
    ),
  );
}

// Call Deepgram with retries - this network is flaky and Node's hard 10s
// connect timeout can turn a slow connect into a failure. Retry punches through.
async function deepgramSpeak(text: string, attempts = 5): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(`https://api.deepgram.com/v1/speak?model=${cfg.deepgramModel}`, {
        method: "POST",
        headers: { Authorization: `Token ${cfg.deepgramApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      lastErr = e;
      const code = (e as { cause?: { code?: string } })?.cause?.code || (e as Error)?.message;
      console.warn(`  deepgram attempt ${i + 1}/${attempts} failed (${code}) - retrying`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// Protected: only runs after payment has settled on-chain.
app.post("/v1/speak", async (req, res) => {
  const text = (req.body?.text as string) || "";
  if (!text.trim()) {
    return res.status(400).json({ error: "Body must include non-empty 'text'." });
  }
  try {
    const dgRes = await deepgramSpeak(text);
    if (!dgRes.ok) {
      const detail = await dgRes.text();
      console.error("Deepgram error", dgRes.status, detail);
      return res.status(502).json({ error: "deepgram_failed", status: dgRes.status, detail });
    }
    const audio = Buffer.from(await dgRes.arrayBuffer());
    res.set("Content-Type", dgRes.headers.get("content-type") || "audio/mpeg");
    res.send(audio);
    console.log(`🔊 fulfilled TTS (${audio.length} bytes) for: "${text.slice(0, 60)}"`);
  } catch (err) {
    console.error("Fulfillment error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// ---- LLM completion: the rail routes to the cheapest capable Gemini model,
// prices the reserved ceiling (Workaround A), calls it, and reports the actual
// cost so the overage can be credited back to the agent's Tab. Works without a
// key in stub mode; set GEMINI_API_KEY for live output.
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_STUB = process.env.GEMINI_DEV_STUB === "true" || !GEMINI_KEY;

interface GeminiUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
}
interface GeminiCompletion {
  text: string;
  usage: GeminiUsage;
  stub: boolean;
}

async function geminiComplete(
  apiModel: string,
  prompt: string,
  maxOut: number,
): Promise<GeminiCompletion> {
  if (GEMINI_STUB) {
    const text = `[stub] "${apiModel}" would answer here. Set GEMINI_API_KEY on the rail for live output.`;
    return {
      text,
      usage: { promptTokenCount: estTokens(prompt), candidatesTokenCount: estTokens(text) },
      stub: true,
    };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxOut },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: Partial<GeminiUsage>;
  };
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  return {
    text,
    usage: {
      promptTokenCount: j.usageMetadata?.promptTokenCount ?? estTokens(prompt),
      candidatesTokenCount: j.usageMetadata?.candidatesTokenCount ?? estTokens(text),
    },
    stub: false,
  };
}

// Protected: only runs after payment (the reserved ceiling) has settled.
app.post("/v1/complete", async (req, res) => {
  const prompt = (req.body?.prompt as string) || "";
  if (!prompt.trim()) {
    return res.status(400).json({ error: "Body must include non-empty 'prompt'." });
  }
  const hint = typeof req.body?.model === "string" ? (req.body.model as string) : undefined;
  const { model, reason } = chooseModel(prompt, hint);
  const spec = models()[model];
  const maxOut = maxOutputTokens();
  // The reserved amount is what the paywall settled (ceiling); fall back to a
  // recompute if the store isn't set (e.g. dev bypass).
  const reserved = BigInt(priceStore.getStore() ?? costMotes(model, estTokens(prompt), maxOut).toString());
  try {
    const out = await geminiComplete(spec.apiModel, prompt, maxOut);
    const actual = costMotes(model, out.usage.promptTokenCount, out.usage.candidatesTokenCount);
    const credit = reserved > actual ? reserved - actual : 0n;
    const premium = costMotes(PREMIUM, out.usage.promptTokenCount, out.usage.candidatesTokenCount);
    const receipt = {
      model: spec.id,
      modelLabel: spec.label,
      reason,
      reservedX402: toX402(reserved),
      actualX402: toX402(actual),
      creditX402: toX402(credit),
      savedVsProX402: toX402(premium > actual ? premium - actual : 0n),
      tokens: { in: out.usage.promptTokenCount, out: out.usage.candidatesTokenCount },
      mode: out.stub ? "stub" : "live",
    };
    res.set("X-Tab-Reserved-X402", receipt.reservedX402);
    res.set("X-Tab-Actual-X402", receipt.actualX402);
    res.set("X-Tab-Credit-X402", receipt.creditX402);
    res.json({ text: out.text, _tab: receipt });
    console.log(
      `🧠 ${spec.label} (${reason}) reserved ${receipt.reservedX402}, actual ${receipt.actualX402}, credit ${receipt.creditX402} X402 [${receipt.mode}]`,
    );
  } catch (err) {
    console.error("Completion error:", err);
    res.status(502).json({ error: "gemini_failed", detail: err instanceof Error ? err.message : "unknown" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "casper-agent-rail/proxy" }));

app.listen(cfg.port, "0.0.0.0", () => {
  console.log(`🛤️  Proxy (rail) listening at http://0.0.0.0:${cfg.port}`);
  console.log(`    Pay-gated: POST /v1/speak (per-char) · POST /v1/complete (routed Gemini)`);
  console.log(`    Quote: GET /v1/quote?text=… | ?prompt=…   ${GEMINI_STUB ? "· LLM: STUB (set GEMINI_API_KEY)" : "· LLM: live"}`);
  console.log(`    Dashboard API: GET/POST /api/*`);
});
