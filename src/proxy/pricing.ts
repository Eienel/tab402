// Per-route cost estimation for the rail.
//
// Instead of charging a flat price per call, each route prices the *actual cost
// driver* the provider bills on:
//   - Deepgram TTS bills per input character  -> base + perChar × chars.
//   - LLM completion bills per token (in+out) -> a bounded ceiling for the model
//     the router picked: inTokens × inRate + maxOutTokens × outRate.
//
// TTS output is fully determined by input, so its quote is exact. LLM output is
// unknown up front, so we quote the *ceiling* (Workaround A): the agent can't be
// charged more than this, and after the call we report reserved-vs-actual so the
// overage can be credited back to its Tab.
//
// Amounts are in token motes (the CEP-18 has 9 decimals). Tunable via env.

import { chooseModel, estTokens, models, PREMIUM } from "./router.js";

const DECIMALS = 9;
const SCALE = 10 ** DECIMALS;

export interface RouteQuote {
  /** The route this quote priced, e.g. "POST /v1/speak". */
  route: string;
  /** Amount to settle on-chain, in token motes. */
  motes: string;
  /** Same amount in whole tokens, e.g. "0.056". */
  x402: string;
  /** Human-readable breakdown (ASCII — also emitted as an HTTP header). */
  basis: string;
  /** Route-specific display fields (chars, model, savings, …). */
  meta: Record<string, string | number>;
}

function envInt(key: string, def: number): number {
  const raw = process.env[key];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const toX402 = (motes: bigint): string => (Number(motes) / SCALE).toFixed(3);

// ---- Deepgram TTS: priced per input character -------------------------------
export interface TtsEstimate {
  motes: bigint;
  chars: number;
  basis: string;
}

export function estimateTts(text: string): TtsEstimate {
  const chars = text.trim().length;
  const base = BigInt(envInt("PRICE_BASE_MOTES", 20_000_000)); //  0.020 X402 floor
  const perChar = BigInt(envInt("PRICE_PER_CHAR_MOTES", 600_000)); // 0.0006 / char
  const cap = BigInt(envInt("PRICE_MAX_MOTES", 1_000_000_000)); //  1.000 X402 ceiling
  const usage = perChar * BigInt(chars);
  let motes = base + usage;
  if (motes > cap) motes = cap;
  return { motes, chars, basis: `${chars} chars: base ${toX402(base)} + usage ${toX402(usage)}` };
}

// ---- LLM completion: bounded ceiling for the routed model -------------------
export interface CompletionEstimate {
  motes: bigint; // ceiling reserved
  model: string;
  modelLabel: string;
  reason: string;
  inTokEst: number;
  maxOutTok: number;
  premiumMotes: bigint; // what the premium model would have reserved
  basis: string;
}

export function maxOutputTokens(): number {
  return envInt("GEMINI_MAX_OUTPUT_TOKENS", 256);
}

/** Ceiling cost for a given model + token counts. */
export function costMotes(model: string, inTok: number, outTok: number): bigint {
  const spec = models()[model as keyof ReturnType<typeof models>];
  return BigInt(inTok) * BigInt(spec.inMotesPerTok) + BigInt(outTok) * BigInt(spec.outMotesPerTok);
}

export function estimateCompletion(prompt: string, hint?: string): CompletionEstimate {
  const { model, reason } = chooseModel(prompt, hint);
  const spec = models()[model];
  const inTok = estTokens(prompt);
  const maxOut = maxOutputTokens();
  const motes = costMotes(model, inTok, maxOut);
  const premiumMotes = costMotes(PREMIUM, inTok, maxOut);
  return {
    motes,
    model: spec.id,
    modelLabel: spec.label,
    reason,
    inTokEst: inTok,
    maxOutTok: maxOut,
    premiumMotes,
    basis: `${spec.label}: ~${inTok} in + <=${maxOut} out (ceiling ${toX402(motes)})`,
  };
}

/**
 * Registry mapping a route key to its quote. Adding an upstream API to the rail
 * = adding one case here; the paywall prices it automatically.
 */
export function estimateForRoute(routeKey: string, body: unknown): RouteQuote | null {
  const str = (k: string): string => {
    const v = (body as Record<string, unknown>)?.[k];
    return typeof v === "string" ? v : "";
  };
  switch (routeKey) {
    case "POST /v1/speak": {
      const e = estimateTts(str("text"));
      return {
        route: routeKey,
        motes: e.motes.toString(),
        x402: toX402(e.motes),
        basis: e.basis,
        meta: { chars: e.chars },
      };
    }
    case "POST /v1/complete": {
      const hintRaw = (body as Record<string, unknown>)?.model;
      const e = estimateCompletion(str("prompt"), typeof hintRaw === "string" ? hintRaw : undefined);
      const savings = e.premiumMotes - e.motes;
      return {
        route: routeKey,
        motes: e.motes.toString(),
        x402: toX402(e.motes),
        basis: e.basis,
        meta: {
          model: e.model,
          modelLabel: e.modelLabel,
          reason: e.reason,
          inTokEst: e.inTokEst,
          maxOutTok: e.maxOutTok,
          premiumX402: toX402(e.premiumMotes),
          savingsX402: toX402(savings > 0n ? savings : 0n),
        },
      };
    }
    default:
      return null;
  }
}

export { toX402 };
