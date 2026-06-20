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

config();

interface Env {
  port: number;
  payeeAddress: string;
  facilitatorURL: string;
  facilitatorAPIKey: string;
  chainID: string;
  assetPackage: string;
  assetName: string;
  priceMotes: string;
  deepgramApiKey: string;
  deepgramModel: string;
}

function parseEnv(): Env {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      console.error(`❌ ${key} environment variable is required`);
      process.exit(1);
    }
    return v;
  };
  return {
    port: parseInt(process.env.PROXY_PORT || "4021", 10),
    payeeAddress: required("PAYEE_ADDRESS"),
    facilitatorURL: required("FACILITATOR_URL"),
    facilitatorAPIKey: process.env.FACILITATOR_API_KEY || "",
    chainID: required("CAIP2_CHAIN_ID"),
    assetPackage: required("ASSET_PACKAGE"),
    assetName: process.env.ASSET_NAME || "Wrapped CSPR",
    priceMotes: process.env.PRICE_MOTES || "100000000",
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    deepgramModel: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
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

// ---- Casper "exact" scheme: charge PRICE_MOTES of WCSPR per call -------------
const assetAmount: AssetAmount = {
  asset: assetPackage,
  amount: cfg.priceMotes,
  extra: { name: cfg.assetName, symbol: "WCSPR", version: "1", decimals: "9" },
};

const casperScheme = new ExactCasperScheme()
  .registerAsset(chainID, assetPackage, 9)
  .registerMoneyParser(() => Promise.resolve(assetAmount));

// ---- App --------------------------------------------------------------------
const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Accept", "Authorization", "Content-Type", "Origin", "Payment-Signature"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    maxAge: 24 * 60 * 60,
  }),
);
app.use(express.json());

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
    },
    new x402ResourceServer(facilitatorClient).register(chainID, casperScheme),
  ),
);

// Protected: only runs after payment has settled on-chain.
app.post("/v1/speak", async (req, res) => {
  const text = (req.body?.text as string) || "";
  if (!text.trim()) {
    return res.status(400).json({ error: "Body must include non-empty 'text'." });
  }
  try {
    const dgRes = await fetch(`https://api.deepgram.com/v1/speak?model=${cfg.deepgramModel}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${cfg.deepgramApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
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

app.get("/health", (_req, res) => res.json({ status: "ok", service: "casper-agent-rail/proxy" }));

app.listen(cfg.port, () => {
  console.log(`🛤️  Proxy (rail) listening at http://localhost:${cfg.port}`);
  console.log(`    Pay-gated: POST /v1/speak  @ ${cfg.priceMotes} motes WCSPR per call`);
});
