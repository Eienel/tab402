// Dashboard API endpoints for key provisioning, funding, and usage tracking
// Integrates with the facilitator and ledger to provide developer-facing APIs

import { Router, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readSettlements, type Settlement } from "../lib/ledger.js";
import { newAgentKeypair, fundAccount } from "../lib/casper.js";

const router = Router();

// One-time token (re)deploy, triggerable from a browser since there's no
// terminal. Guarded by ADMIN_DEPLOY_SECRET. Runs `npm run deploy-token` in
// the background and streams its output to stdout (visible in fly logs).
let deployRunning = false;
router.get("/admin/deploy-token", (req: Request, res: Response) => {
  const secret = process.env.ADMIN_DEPLOY_SECRET;
  if (!secret) return res.status(500).json({ error: "ADMIN_DEPLOY_SECRET not set" });
  if (req.query.secret !== secret) return res.status(403).json({ error: "forbidden" });
  if (deployRunning) return res.status(409).json({ error: "deploy already running - watch fly logs" });

  deployRunning = true;
  console.log("🚀 admin-triggered token deploy starting...");
  const child = spawn("npm", ["run", "deploy-token"], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", code => {
    deployRunning = false;
    console.log(`token deploy process exited with code ${code}`);
  });
  child.on("error", err => {
    deployRunning = false;
    console.error("token deploy failed to start:", err);
  });
  res.json({
    ok: true,
    message:
      "Token deploy started. Watch fly logs for a 'NEW ASSET_PACKAGE=...' line (takes 1-3 min).",
  });
});

// In-memory store for provisioned keys (in production: use database)
interface ProvisionedKey {
  publicKeyHex: string;
  accountHash: string;
  pem: string;
  ceiling: string; // motes
  createdAt: Date;
}

const provisionedKeys = new Map<string, ProvisionedKey>();

/**
 * GET /api/stats
 * Returns global platform statistics
 */
router.get("/stats", (_req: Request, res: Response) => {
  try {
    const settlements = readSettlements();
    const totalCalls = settlements.length;
    const volumeMotes = settlements
      .reduce((sum, s) => sum + BigInt(s.amount || "0"), BigInt(0))
      .toString();

    res.json({
      token: {
        symbol: process.env.ASSET_SYMBOL || "X402",
        name: process.env.ASSET_NAME || "Casper X402 Token",
        decimals: 9,
        package: process.env.ASSET_PACKAGE || "unknown",
      },
      totalCalls,
      volumeMotes,
      settlementsRecorded: settlements.length,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/**
 * POST /api/provision
 * Generates a new agent key pair and returns provisioning details
 * The agent uses this key to sign x402 payment authorizations
 */
router.post("/provision", (_req: Request, res: Response) => {
  try {
    const kp = newAgentKeypair();
    const { publicKeyHex, accountHash, pem } = kp;

    // Generate random API key for this provisioning
    const apiKey = randomBytes(32).toString("hex");

    // Set spending ceiling: 0.5 X402 = 500000000 motes (9 decimals)
    const ceiling = "500000000"; // 0.5 X402

    // Store key
    const provision: ProvisionedKey = {
      publicKeyHex,
      accountHash,
      pem,
      ceiling,
      createdAt: new Date(),
    };
    provisionedKeys.set(apiKey, provision);

    // Return to dashboard for display
    res.json({
      apiKey, // Store this securely
      publicKeyHex,
      accountHash, // Fund this account on testnet
      payTo: `00${accountHash}`, // Full account ID for pay-to field
      pem, // Download as agent.pem
      ceiling, // Spending limit in motes
      network: process.env.CAIP2_CHAIN_ID || "casper:casper-test",
      faucetUrl: "https://testnet.cspr.live/tools/faucet",
      instructions:
        "1. Fund this account with CSPR from the faucet\n2. Wrap CSPR -> WCSPR using the Casper wallet\n3. Click 'Fund 0.5 X402' to transfer X402 tokens\n4. Download the PEM and use as CLIENT_PRIVATE_KEY_PATH",
    });
  } catch (error) {
    console.error("Provision error:", error);
    res.status(500).json({ error: "Failed to provision key" });
  }
});

/**
 * POST /api/fund
 * Funds an agent account with X402 tokens from the treasury
 * Requires the facilitator to have available balance
 */
router.post("/fund", async (req: Request, res: Response) => {
  try {
    const { account, amount } = req.body;

    if (!account || !amount) {
      return res.status(400).json({ error: "Missing account or amount" });
    }

    console.log(
      `💰 Fund request: ${amount} motes to ${account.slice(0, 20)}...`
    );

    const transaction = await fundAccount(account, amount);

    res.json({
      ok: true,
      transaction,
      amount,
      account: account.slice(0, 20) + "...",
      network: process.env.CAIP2_CHAIN_ID || "casper:casper-test",
      explorerUrl: `https://testnet.cspr.live/transaction/${transaction}`,
    });
  } catch (error) {
    console.error("Fund error:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Fund failed",
    });
  }
});

/**
 * GET /api/usage/:accountHash
 * Returns spending and settlement history for an account
 */
router.get("/usage/:accountHash", (req: Request, res: Response) => {
  try {
    const { accountHash } = req.params;

    // Read all settlements from ledger
    const settlements = readSettlements();

    // Filter settlements for this account
    const accountSettlements = settlements.filter(
      (s: Settlement) =>
        s.payer === accountHash || s.payer === `00${accountHash}`
    );

    // Sum total spent
    const spentMotes = accountSettlements
      .reduce((sum, s) => sum + BigInt(s.amount || "0"), BigInt(0))
      .toString();

    res.json({
      accountHash,
      count: accountSettlements.length,
      spentMotes,
      settlements: accountSettlements.slice(0, 50).map((s: Settlement) => ({
        transaction: s.transaction,
        amount: s.amount,
        asset: s.asset.slice(0, 16) + "...",
        ts: s.ts,
        explorerUrl: `https://testnet.cspr.live/transaction/${s.transaction}`,
      })),
    });
  } catch (error) {
    console.error("Usage error:", error);
    res.status(500).json({ error: "Failed to fetch usage" });
  }
});

/**
 * GET /api/feed
 * Global live transaction feed — latest settlements across all accounts
 */
router.get("/feed", (_req: Request, res: Response) => {
  try {
    const settlements = readSettlements();
    res.json({
      count: settlements.length,
      settlements: settlements.slice(0, 25).map((s: Settlement) => ({
        payer: s.payer,
        transaction: s.transaction,
        amount: s.amount,
        ts: s.ts,
        explorerUrl: `https://testnet.cspr.live/transaction/${s.transaction}`,
      })),
    });
  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

/**
 * GET /api/health
 * Health check for dashboard API
 */
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "tab-dashboard-api",
    timestamp: new Date().toISOString(),
  });
});

export default router;
