// Append-only settlement ledger. The facilitator records every on-chain x402
// settlement here; the dashboard reads it to show usage + payment history.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LEDGER = "data/ledger.jsonl";

export interface Settlement {
  payer: string; // "00" + account hash
  transaction: string;
  amount: string; // motes
  asset: string; // token package hash
  network: string;
  ts: string; // ISO
}

export function recordSettlement(s: Settlement): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(s) + "\n");
}

export function readSettlements(): Settlement[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as Settlement)
    .reverse(); // newest first
}
