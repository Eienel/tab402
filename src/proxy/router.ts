// Model router for the rail's LLM route.
//
// The agent sends one prompt to /v1/complete; the rail picks the cheapest model
// that should still do the job, prices the call to that model, and reports what
// it saved versus the premium model. This is the "cost-aware rail" idea: the
// agent doesn't pick a model or a price — it just asks, and pays the metered cost.
//
// Routing is heuristic-first (fast, free, deterministic). An optional LLM judge
// can be layered on later behind a flag; the heuristic is the demo default.

export type GeminiModel = "gemini-flash-lite" | "gemini-flash" | "gemini-pro";

export interface ModelSpec {
  id: GeminiModel;
  /** Actual model id sent to the Gemini API. */
  apiModel: string;
  /** Price of input, in token motes per token. */
  inMotesPerTok: number;
  /** Price of output, in token motes per token. */
  outMotesPerTok: number;
  /** Short display name. */
  label: string;
}

// Rates are in CEP-18 motes/token (9 decimals). They preserve the *relative*
// tiering of real Gemini pricing (lite < flash < pro, output ≫ input) scaled so
// a typical call lands in a visible fraction of an X402. Tunable via env.
function rate(key: string, def: number): number {
  const n = parseInt(process.env[key] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function models(): Record<GeminiModel, ModelSpec> {
  return {
    "gemini-flash-lite": {
      id: "gemini-flash-lite",
      apiModel: process.env.GEMINI_MODEL_LITE || "gemini-2.5-flash-lite",
      inMotesPerTok: rate("RATE_LITE_IN", 8_000),
      outMotesPerTok: rate("RATE_LITE_OUT", 40_000),
      label: "Flash-Lite",
    },
    "gemini-flash": {
      id: "gemini-flash",
      apiModel: process.env.GEMINI_MODEL_FLASH || "gemini-2.5-flash",
      inMotesPerTok: rate("RATE_FLASH_IN", 24_000),
      outMotesPerTok: rate("RATE_FLASH_OUT", 200_000),
      label: "Flash",
    },
    "gemini-pro": {
      id: "gemini-pro",
      apiModel: process.env.GEMINI_MODEL_PRO || "gemini-2.5-pro",
      inMotesPerTok: rate("RATE_PRO_IN", 120_000),
      outMotesPerTok: rate("RATE_PRO_OUT", 900_000),
      label: "Pro",
    },
  };
}

/** The model we compare savings against — the one a naive integration would use. */
export const PREMIUM: GeminiModel = "gemini-pro";

export interface RouteDecision {
  model: GeminiModel;
  reason: string;
}

// Signals that a prompt needs real reasoning → the premium model.
const HARD =
  /\b(analy[sz]e|reason|prove|derive|explain\s+why|step[-\s]by[-\s]step|architect|strategy|complex|trade[-\s]?offs?|legal|theorem|optimi[sz]e|plan\b)/i;
// Signals a structured/code task → at least the mid model.
const STRUCT = /\b(code|function|regex|sql|json|schema|typescript|javascript|python|refactor|debug|api|table)\b/i;

/**
 * Pick a model from prompt features. `hint` lets the caller force a tier
 * (e.g. body.model = "gemini-pro"); otherwise it's inferred.
 */
export function chooseModel(prompt: string, hint?: string): RouteDecision {
  const p = (prompt || "").trim();
  const len = p.length;

  if (hint && hint in models()) {
    return { model: hint as GeminiModel, reason: `caller requested ${models()[hint as GeminiModel].label}` };
  }
  if (HARD.test(p) || len > 1200) {
    return { model: "gemini-pro", reason: len > 1200 ? "long / complex prompt" : "reasoning-heavy request" };
  }
  if (STRUCT.test(p) || len > 300) {
    return { model: "gemini-flash", reason: STRUCT.test(p) ? "structured / code task" : "medium prompt" };
  }
  return { model: "gemini-flash-lite", reason: "short, simple prompt" };
}

/** Rough token count for a-priori quoting. Actuals come from Gemini usage. */
export function estTokens(text: string): number {
  return Math.max(1, Math.ceil((text || "").trim().length / 4));
}
