// Per-route cost estimation for the rail.
//
// Instead of charging a flat price per call, each upstream route prices the
// *actual cost driver* the provider bills on. Deepgram TTS bills per character
// of input, so we mirror that: price = base + perChar × chars (capped). The
// agent knows the input before it calls, so this is a deterministic a-priori
// quote — not a guess — and the x402 settlement tracks real usage.
//
// Amounts are in token motes (the CEP-18 has 9 decimals). Tunable via env so
// the operator can reprice without a redeploy.

const DECIMALS = 9;
const SCALE = 10 ** DECIMALS;

export interface PriceEstimate {
  /** Amount to settle on-chain, in token motes. */
  motes: string;
  /** Same amount rendered in whole tokens, e.g. "0.098". */
  x402: string;
  /** The cost driver measured for this request. */
  chars: number;
  /** Human-readable breakdown for logs / UI. */
  basis: string;
}

export interface RouteQuote extends PriceEstimate {
  /** The route this quote priced, e.g. "POST /v1/speak". */
  route: string;
}

function envInt(key: string, def: number): number {
  const raw = process.env[key];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const toX402 = (motes: bigint): string => (Number(motes) / SCALE).toFixed(3);

/** Price a Deepgram TTS request from its character count. */
export function estimateTtsMotes(text: string): PriceEstimate {
  const chars = text.trim().length;
  const base = BigInt(envInt("PRICE_BASE_MOTES", 20_000_000)); //  0.020 X402 floor per call
  const perChar = BigInt(envInt("PRICE_PER_CHAR_MOTES", 600_000)); // 0.0006 X402 / char
  const cap = BigInt(envInt("PRICE_MAX_MOTES", 1_000_000_000)); //  1.000 X402 ceiling

  const usage = perChar * BigInt(chars);
  let motes = base + usage;
  if (motes > cap) motes = cap;

  return {
    motes: motes.toString(),
    x402: toX402(motes),
    chars,
    // ASCII-only: this string is also emitted as an HTTP header value.
    basis: `${chars} chars: base ${toX402(base)} + usage ${toX402(usage)}`,
  };
}

/**
 * Registry mapping a route key to its cost estimator. Adding a new upstream API
 * to the rail = adding one entry here; the paywall prices it automatically.
 */
export function estimateForRoute(routeKey: string, body: unknown): RouteQuote | null {
  switch (routeKey) {
    case "POST /v1/speak": {
      const text =
        body && typeof (body as { text?: unknown }).text === "string"
          ? (body as { text: string }).text
          : "";
      return { route: routeKey, ...estimateTtsMotes(text) };
    }
    default:
      return null;
  }
}
