// x402 facilitator: verifies payment authorizations and settles them on-chain
// by calling CEP-18 transfer_with_authorization. Adapted from
// make-software/casper-x402 examples/facilitator/index.ts.

import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/facilitator";
import { FacilitatorCasperSigner, toFacilitatorCasperSigner } from "@make-software/casper-x402";
import casperSdk from "casper-js-sdk";
import dotenv from "dotenv";
import express from "express";

import { NetworkKey, parseEnv } from "./config.js";
import { recordSettlement } from "../lib/ledger.js";

dotenv.config();

const cfg = parseEnv();

const app = express();
// Signed Casper transactions in settle payloads can exceed express's 100kb default
app.use(express.json({ limit: "5mb" }));
app.use((req, _res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

const facilitator = new x402Facilitator()
  .onAfterVerify(async () => console.log("✅ payment verified"))
  .onVerifyFailure(async ctx => console.log("❌ verify failure", ctx))
  .onAfterSettle(async (ctx: unknown) => {
    const c = ctx as { result?: { success?: boolean; payer?: string; transaction?: string; network?: string }; requirements?: { amount?: string; asset?: string } };
    const r = c?.result;
    if (r?.success && r?.transaction) {
      recordSettlement({
        payer: r.payer ?? "",
        transaction: r.transaction,
        amount: c?.requirements?.amount ?? "0",
        asset: c?.requirements?.asset ?? "",
        network: r.network ?? "casper:casper-test",
        ts: new Date().toISOString(),
      });
      console.log(`💸 settled on-chain ${r.transaction}`);
    }
  })
  .onSettleFailure(async ctx => console.log("❌ settle failure", ctx));

async function buildSigner(key: NetworkKey): Promise<FacilitatorCasperSigner> {
  const algorithm =
    key.algorithm === "secp256k1"
      ? casperSdk.KeyAlgorithm.SECP256K1
      : casperSdk.KeyAlgorithm.ED25519;
  const privateKey = casperSdk.PrivateKey.fromPem(key.pem, algorithm);
  const base = await toFacilitatorCasperSigner(privateKey, key.rpcUrl);

  // The default signer polls the settlement tx every 3s, so it can return up to
  // ~3s after the tx actually confirmed. Poll every 1s to shave that off - same
  // logic, tighter interval. (The bulk of the wait is Casper confirming the tx.)
  const rpcClient = new casperSdk.RpcClient(new casperSdk.HttpHandler(key.rpcUrl));
  base.waitForTransaction = async (_network, transactionHash: string) => {
    const start = Date.now();
    const timeoutMs = 60000;
    const pollIntervalMs = 1000;
    while (Date.now() - start < timeoutMs) {
      const info = (await rpcClient.getTransactionByTransactionHash(transactionHash)) as {
        executionInfo?: { blockHeight?: number; executionResult?: { errorMessage?: string } };
      };
      const execInfo = info.executionInfo;
      if (execInfo && execInfo.blockHeight !== 0 && execInfo.executionResult) {
        if (execInfo.executionResult.errorMessage) {
          throw new Error(`transaction execution failed: ${execInfo.executionResult.errorMessage}`);
        }
        return;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`Timed out waiting for transaction ${transactionHash}`);
  };
  return base;
}

for (const network of cfg.networks) {
  const key = cfg.keys[network];
  if (!key) throw new Error(`No signing material resolved for network ${network}`);
  const signer = await buildSigner(key);
  facilitator.register(
    network,
    new ExactCasperScheme(signer, { limitedPaymentMotes: cfg.transactionPaymentMotes }),
  );
  console.log(`network ${network} configured (algo=${key.algorithm}, rpc=${key.rpcUrl})`);
}

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }
    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );
    console.log("settle result:", JSON.stringify(response));
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/supported", async (_req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(cfg.port, () => {
  console.log(`🚀 Facilitator listening on http://localhost:${cfg.port}`);
});
