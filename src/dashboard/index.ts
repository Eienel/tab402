// Developer dashboard for Tab. Provision an agent key, (optionally) fund it,
// and watch real on-chain settlements roll in.

import { config } from "dotenv";
import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { readSettlements } from "../lib/ledger.js";
import { newAgentKeypair, fundAccount } from "../lib/casper.js";

config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.DASHBOARD_PORT || "4023", 10);
const TOKEN = {
  name: process.env.ASSET_NAME || "Casper X402 Token",
  symbol: process.env.ASSET_SYMBOL || "X402",
  package: process.env.ASSET_PACKAGE || "",
  decimals: 9,
};
const DEFAULT_FUND = process.env.AGENT_FUND_AMOUNT || "500000000";

app.get("/", (_req, res) => res.type("html").send(readFileSync("web/dashboard.html", "utf8")));

app.get("/api/stats", (_req, res) => {
  const s = readSettlements();
  const vol = s.reduce((a, x) => a + Number(x.amount), 0);
  res.json({ token: TOKEN, totalCalls: s.length, volumeMotes: String(vol) });
});

// Provision a fresh agent key (instant; funding is a separate step).
app.post("/api/provision", (_req, res) => {
  try {
    const kp = newAgentKeypair();
    res.json({ ...kp, ceiling: DEFAULT_FUND });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "provision failed" });
  }
});

// Fund an agent key with X402 from the treasury (real on-chain transfer).
app.post("/api/fund", async (req, res) => {
  try {
    const { account, amount } = req.body as { account: string; amount?: string };
    if (!account) return res.status(400).json({ error: "account required" });
    const tx = await fundAccount(account, amount || DEFAULT_FUND);
    res.json({ ok: true, transaction: tx });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "fund failed" });
  }
});

// Usage + payment history for one account.
app.get("/api/usage/:account", (req, res) => {
  const acct = req.params.account.replace(/^(00|account-hash-)/, "").toLowerCase();
  const mine = readSettlements().filter(s => s.payer.replace(/^00/, "").toLowerCase() === acct);
  const spent = mine.reduce((a, x) => a + Number(x.amount), 0);
  res.json({ account: acct, settlements: mine, count: mine.length, spentMotes: String(spent) });
});

app.listen(PORT, () => console.log(`📊 Tab dashboard at http://localhost:${PORT}`));
