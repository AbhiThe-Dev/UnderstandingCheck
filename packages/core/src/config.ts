import type { ReasoningEffort } from './ports';
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
  /**
   * When someone has already stated a position on a concern, hold it back while the team discusses
   * it, for at most this many turns after it was last mentioned. Unlimited by default.
   */
  discussionHoldSegments: number;
  /** Segments to wait before surfacing, so later turns can resolve or sharpen a candidate. */
  settleWindow: Record<DiscrepancyCategory, number>;
  rateLimit: {
    maxLivePerSession: number;
    maxOpenLive: number;
  };
  retrieval: {
    maxSymbols: number;
    contextBudgetTokens: number;
    /** Cap on Slack message text sent to the model per call. */
    slackBudgetTokens: number;
    minScore: number;
    maxTestsPerSymbol: number;
  };
  /** Live capture: the model analyses a turn only if fewer than `fullTurns` newer turns are waiting; older ones get rules. */
  liveAnalysis: { fullTurns: number };
  /** Tiered analyzer: when the small-model screen reads the latest turns. */
  screening: {
    /** Meeting time between screens. */
    intervalMs: number;
    /** Screen sooner once this many meaningful turns are waiting. */
    maxTurns: number;
    /** Earlier turns included as context (never flagged). */
    overlap: number;
    /** Flags acted on per screen (each costs one large-model call). */
    maxFlags: number;
  };
  /** Implementation preview: when to hint, and how much the on-demand analysis may read. */
  preview: {
    /** Detector score (0–1) at which a turn earns the "worth reviewing" hint. */
    hintThreshold: number;
    /** Code the analysis may read: more than a turn gets, since call paths and tests decide the answer. */
    maxSymbols: number;
    contextBudgetTokens: number;
    maxTestsPerSymbol: number;
    /** Conversation the analysis reads. */
    maxDiscussionTurns: number;
    maxDiscussionChars: number;
    /** A later turn belongs to a decision when this share of its terms overlaps (or it touches the same code). */
    minOverlap: number;
    /** Meaningful turns right after a decision's last turn that count as its follow-up even without shared terms. */
    followUpTurns: number;
  };
  /**
   * Technical decision evaluation: detection is free (rules, every turn); each adopted decision gets at
   * most one bounded model call, and only what validation keeps and the policy below allows is shown.
   */
  decisions: {
    /** Detector score (0–1) at which a turn counts as a proposed technical decision. */
    detectThreshold: number;
    /** A proposal nobody objects to for this many turns counts as adopted (agreement adopts it at once). */
    adoptAfterTurns: number;
    /** Model evaluations per meeting (re-evaluations included); later decisions get rule findings only. */
    maxEvaluationsPerSession: number;
    /** Findings shown live per meeting; the rest are noted for the decision log. */
    maxLivePerSession: number;
    /** Below this a finding is dropped; medium-severity findings need `liveConfidence` to be shown live. */
    minConfidence: number;
    liveConfidence: number;
    /** What the evaluation reads: code, its callers and tests, documentation, conversation. */
    maxSymbols: number;
    contextBudgetTokens: number;
    maxTestsPerSymbol: number;
    maxCallers: number;
    maxDocSections: number;
    docsBudgetTokens: number;
    maxDiscussionTurns: number;
    maxDiscussionChars: number;
  };
  /** How many recent segments count as "right after" a proposal, for agreement detection. */
  agreementWindow: number;
  recentWindow: number;
  budget: {
    /** Stop model calls when the workspace has spent this much in the period. */
    workspaceLimitUsd: number;
  };
  llm: {
    /** Reasoning tokens count against these caps, so they leave room beyond the visible answer. */
    maxOutputTokens: Record<LlmOperation, number>;
    /** The fact-sheet answer writes out its reading of the conversation before the candidates, so it needs more room. */
    factSheetOutputTokens: number;
    maxInputChars: number;
    effort: Record<LlmOperation, ReasoningEffort>;
  };
}

export type LlmOperation = 'extraction' | 'candidates' | 'screen' | 'clarification' | 'response' | 'preview' | 'decision';

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
  discussionHoldSegments: Number.POSITIVE_INFINITY,
  settleWindow: {
    false_alignment: 0,
    direct_disagreement: 0,
    codebase_conflict: 1,
    hidden_assumption: 1,
    missing_specification: 2,
  },
  rateLimit: { maxLivePerSession: 6, maxOpenLive: 3 },
  retrieval: { maxSymbols: 6, contextBudgetTokens: 2500, slackBudgetTokens: 800, minScore: 1.2, maxTestsPerSymbol: 1 },
  liveAnalysis: { fullTurns: 2 },
  preview: {
    hintThreshold: 0.6,
    maxSymbols: 8,
    contextBudgetTokens: 4000,
    maxTestsPerSymbol: 2,
    maxDiscussionTurns: 16,
    maxDiscussionChars: 6000,
    minOverlap: 0.4,
    followUpTurns: 3,
  },
  decisions: {
    detectThreshold: 0.55,
    adoptAfterTurns: 2,
    maxEvaluationsPerSession: 8,
    maxLivePerSession: 3,
    minConfidence: 0.6,
    liveConfidence: 0.8,
    maxSymbols: 8,
    contextBudgetTokens: 3500,
    maxTestsPerSymbol: 1,
    maxCallers: 4,
    maxDocSections: 3,
    docsBudgetTokens: 900,
    maxDiscussionTurns: 12,
    maxDiscussionChars: 5000,
  },
  screening: { intervalMs: 60_000, maxTurns: 8, overlap: 3, maxFlags: 2 },
  agreementWindow: 3,
  recentWindow: 12,
  budget: { workspaceLimitUsd: 5 },
  llm: {
    // Candidates were cut off at 2000 (15% of answers in a live run): hidden reasoning uses ~1000 of it.
    // A preview writes several short sections; it is requested by a person, so it runs at most a few times per meeting.
    // A decision evaluation is usually an empty list; the cap leaves room for hidden reasoning and up to three findings.
    maxOutputTokens: { extraction: 400, candidates: 4000, screen: 600, clarification: 800, response: 300, preview: 3500, decision: 2000 },
    factSheetOutputTokens: 5000,
    maxInputChars: 24_000,
    // Spotting a conflict in cited code needs little reasoning; screening and classifying need almost none.
    effort: { extraction: 'minimal', candidates: 'low', screen: 'minimal', clarification: 'low', response: 'minimal', preview: 'low', decision: 'low' },
  },
};

/**
 * Surfacing for the AI analyzers, tuned to miss less at the cost of more suggestions: lower score
 * thresholds and more room in the panel. The rule-only analyzer keeps the defaults.
 */
export const RECALL_PROFILE: DeepPartial<EngineConfig> = {
  scoring: { liveThreshold: 0.45, suppressThreshold: 0.25 },
  rateLimit: { maxLivePerSession: 12, maxOpenLive: 5 },
  // A concern someone took a position on but nobody settled must not stay hidden for the whole meeting.
  discussionHoldSegments: 1,
};

/** Options the app and eval runner apply to the AI analyzers, from the environment. */
export function aiAnalyzerEnv(env: Record<string, string | undefined>): { withRules: boolean; config: DeepPartial<EngineConfig> } {
  return {
    withRules: env.UC_LLM_WITH_RULES !== 'off',
    config: env.UC_SURFACING === 'balanced' ? {} : RECALL_PROFILE,
  };
}

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
  /** Price of input tokens served from the prompt cache; defaults to the full input price. */
  cachedInputPerMTok?: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'heuristic-v1': { inputPerMTok: 0, outputPerMTok: 0 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2.0, cachedInputPerMTok: 0.025 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10.0, cachedInputPerMTok: 0.125 },
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
  cachedInputTokens = 0,
): number {
  const p = prices[model];
  if (!p) return 0;
  const cached = Math.min(cachedInputTokens, inputTokens);
  return ((inputTokens - cached) * p.inputPerMTok + cached * (p.cachedInputPerMTok ?? p.inputPerMTok) + outputTokens * p.outputPerMTok) / 1_000_000;
}

/**
 * Fact-sheet prompt and model tiers from `UC_PROMPT_STYLE` (raw | facts), `UC_CANDIDATES_TIER`,
 * `UC_PREVIEW_TIER` and `UC_DECISION_TIER` (cheap | reasoning).
 */
export function promptOptionsFrom(env: Record<string, string | undefined>): {
  promptStyle: 'raw' | 'facts';
  candidatesTier?: 'cheap' | 'reasoning';
  previewTier?: 'cheap' | 'reasoning';
  decisionTier?: 'cheap' | 'reasoning';
} {
  const tier = (v: string | undefined) => (v === 'cheap' || v === 'reasoning' ? v : undefined);
  return {
    promptStyle: env.UC_PROMPT_STYLE === 'facts' ? 'facts' : 'raw',
    ...(tier(env.UC_CANDIDATES_TIER) ? { candidatesTier: tier(env.UC_CANDIDATES_TIER) } : {}),
    ...(tier(env.UC_PREVIEW_TIER) ? { previewTier: tier(env.UC_PREVIEW_TIER) } : {}),
    ...(tier(env.UC_DECISION_TIER) ? { decisionTier: tier(env.UC_DECISION_TIER) } : {}),
  };
}

/** Merge `UC_LLM_EFFORT_JSON` (e.g. `{"candidates":"medium"}`) over the default reasoning effort per operation. */
export function effortFrom(json: string | undefined, base: Record<LlmOperation, ReasoningEffort> = DEFAULT_CONFIG.llm.effort): Record<LlmOperation, ReasoningEffort> {
  if (!json) return base;
  const allowed = new Set(['minimal', 'low', 'medium', 'high']);
  try {
    const parsed = JSON.parse(json) as Record<string, string>;
    return { ...base, ...Object.fromEntries(Object.entries(parsed).filter(([k, v]) => k in base && allowed.has(v))) };
  } catch {
    return base;
  }
}
