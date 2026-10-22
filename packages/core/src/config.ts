import type { DiscrepancyCategory } from './types';

export interface ScoringWeights {
  consequence: number;
  codeEvidence: number;
  conversationEvidence: number;
  divergence: number;
  relevance: number;
}

export interface EngineConfig {
  scoring: {
    weights: ScoringWeights;
    categoryMultiplier: Record<DiscrepancyCategory, number>;
    /** Minimum score for a candidate to appear live in the side panel. */
    liveThreshold: number;
    /** Below this a candidate is suppressed entirely (kept only for metrics). */
    suppressThreshold: number;
    ambiguousSpeakerPenalty: number;
  };
  /** Segments to wait before surfacing, so later turns can resolve or sharpen a candidate. */
  settleWindow: Record<DiscrepancyCategory, number>;
  rateLimit: {
    maxLivePerSession: number;
    maxOpenLive: number;
  };
  retrieval: {
    maxSymbols: number;
    contextBudgetTokens: number;
    minScore: number;
    maxTestsPerSymbol: number;
  };
  /** How many recent segments count as "right after" a proposal, for agreement detection. */
  agreementWindow: number;
  recentWindow: number;
  budget: {
    /** Stop model calls when the workspace has spent this much in the period. */
    workspaceLimitUsd: number;
  };
  llm: {
    maxOutputTokens: Record<'extraction' | 'candidates' | 'clarification' | 'response', number>;
    maxInputChars: number;
  };
}

export const DEFAULT_CONFIG: EngineConfig = {
  scoring: {
    weights: { consequence: 0.35, codeEvidence: 0.2, conversationEvidence: 0.15, divergence: 0.15, relevance: 0.15 },
    categoryMultiplier: {
      false_alignment: 1.0,
      direct_disagreement: 0.95,
      codebase_conflict: 0.9,
      hidden_assumption: 0.9,
      missing_specification: 0.85,
    },
    liveThreshold: 0.55,
    suppressThreshold: 0.35,
    ambiguousSpeakerPenalty: 0.7,
  },
  settleWindow: {
    false_alignment: 0,
    direct_disagreement: 0,
    codebase_conflict: 1,
    hidden_assumption: 1,
    missing_specification: 2,
  },
  rateLimit: { maxLivePerSession: 6, maxOpenLive: 3 },
  retrieval: { maxSymbols: 6, contextBudgetTokens: 2500, minScore: 1.2, maxTestsPerSymbol: 1 },
  agreementWindow: 3,
  recentWindow: 12,
  budget: { workspaceLimitUsd: 5 },
  llm: {
    maxOutputTokens: { extraction: 400, candidates: 1200, clarification: 500, response: 150 },
    maxInputChars: 24_000,
  },
};

export function mergeConfig(partial?: DeepPartial<EngineConfig>): EngineConfig {
  return deepMerge(DEFAULT_CONFIG, partial ?? {}) as EngineConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge(base: unknown, over: unknown): unknown {
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) {
    return over === undefined ? base : over;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out;
}

/**
 * Per-million-token prices used for *estimates* only. Prices change; override via
 * `UC_MODEL_PRICES_JSON` (see README) rather than trusting these numbers.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'heuristic-v1': { inputPerMTok: 0, outputPerMTok: 0 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2.0 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10.0 },
};

/** Merge `UC_MODEL_PRICES_JSON` (e.g. `{"gpt-5-mini":{"inputPerMTok":0.25,"outputPerMTok":2}}`) over the defaults. */
export function pricesFrom(json: string | undefined): Record<string, ModelPrice> {
  if (!json) return DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(json) as Record<string, ModelPrice>;
    const valid = Object.entries(parsed).filter(([, p]) => Number.isFinite(p?.inputPerMTok) && Number.isFinite(p?.outputPerMTok));
    return { ...DEFAULT_PRICES, ...Object.fromEntries(valid) };
  } catch {
    return DEFAULT_PRICES;
  }
}

/**
 * Per-minute prices for streaming transcription, for *estimates*. The gpt-live-transcribe figure
 * comes from press reports at launch, not OpenAI's price page; override with
 * `UC_TRANSCRIPTION_PRICES_JSON` (e.g. `{"gpt-live-transcribe":0.017}`).
 */
export const DEFAULT_TRANSCRIPTION_PRICES_PER_MINUTE: Record<string, number> = {
  'gpt-live-transcribe': 0.017,
};

export function transcriptionPricesFrom(json: string | undefined): Record<string, number> {
  if (!json) return DEFAULT_TRANSCRIPTION_PRICES_PER_MINUTE;
  try {
    const parsed = JSON.parse(json) as Record<string, number>;
    return { ...DEFAULT_TRANSCRIPTION_PRICES_PER_MINUTE, ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => Number.isFinite(v))) };
  } catch {
    return DEFAULT_TRANSCRIPTION_PRICES_PER_MINUTE;
  }
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  prices: Record<string, ModelPrice> = DEFAULT_PRICES,
): number {
  const p = prices[model];
  if (!p) return 0;
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}
