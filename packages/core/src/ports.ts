import type { z } from 'zod';
import type { FactSheet } from './facts';
import type {
  Claim,
  ClaimKind,
  Clarification,
  ClarificationFormat,
  CodeEvidence,
  CodeSymbol,
  Discrepancy,
  DiscrepancyCategory,
  EffectCategory,
  Interpretation,
  Participant,
  Position,
  Segment,
  SessionState,
  SlackRef,
} from './types';

// ---------- Code search (implemented by @uc/indexer in memory and @uc/db with Postgres FTS) ----------

export interface SymbolHit {
  symbol: CodeSymbol;
  score: number;
  matchedTerms: string[];
  nameMatch: boolean;
}

export interface SymbolSearch {
  readonly commitSha: string;
  /** Lexical search. `terms` are stemmed; `words` are the raw surface words they came from. */
  lexical(query: { terms: string[]; words: string[] }, limit: number): Promise<SymbolHit[]>;
  byNames(names: string[]): Promise<CodeSymbol[]>;
  /** Non-test symbols in these files; a path may be a suffix (`approve.ts` matches `src/applications/approve.ts`). */
  inFiles?(paths: string[], limit: number): Promise<CodeSymbol[]>;
  /** Test symbols that reference `symbolName`. */
  testsFor(symbolName: string, limit: number): Promise<CodeSymbol[]>;
}

// ---------- LLM provider (implemented by @uc/providers) ----------

export type ModelTier = 'cheap' | 'reasoning';
/** How much hidden reasoning a reasoning model may spend (billed as output tokens). */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface LlmRequest<T> {
  operation: string;
  tier: ModelTier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  effort?: ReasoningEffort;
  /** Groups requests that share a prompt prefix so the provider can reuse its cache (e.g. the session id). */
  cacheKey?: string;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` served from the provider's prompt cache (billed at a discount). */
  cachedInputTokens?: number;
  /** Part of `outputTokens` spent on hidden reasoning. */
  reasoningTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** The model answered (and was billed) but the answer was unusable: cut off, not JSON, or off-schema. */
export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly usage: LlmUsage,
    readonly finishReason?: string,
  ) {
    super(message);
  }
}

// ---------- Usage / cost ----------

export interface UsageRecord {
  sessionId: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  estimatedCostUsd: number;
  /** The call was billed but its answer was unusable. */
  failed?: boolean;
}

export interface UsageSink {
  record(u: UsageRecord): void | Promise<void>;
  /** Total spend for the workspace in the current budget period. */
  spentUsd(): number | Promise<number>;
}

// ---------- Analyzer (heuristic or LLM-backed) ----------

export interface AnalysisContext {
  state: SessionState;
  segment: Segment;
  participant: Participant;
  /** The most recent segments, oldest first, including `segment`. */
  recent: Segment[];
}

export interface SegmentAnalysis {
  kinds: ClaimKind[];
  polarity: 'positive' | 'negative' | 'neutral';
  terms: string[];
  words: string[];
  reversalWord: string | null;
  reuseTarget: string | null;
  purpose: string | null;
  /** Cheap gate: false means skip retrieval and candidate generation for this segment. */
  meaningful: boolean;
  bareAgreement: boolean;
}

export interface RawCandidate {
  key: string;
  category: DiscrepancyCategory;
  title: string;
  description: string;
  quotes: { segmentId: string; quote: string }[];
  codeRefs: { evidenceId: string; startLine: number; endLine: number; note: string }[];
  /** Slack messages the candidate rests on, by ref id (S1…) from `CandidateInput.slack`. */
  slackRefs?: { refId: string; note: string }[];
  interpretations: Interpretation[];
  consequence: EffectCategory | 'business_rule';
  impactExplanation: string;
  confidence: number;
  relevantParticipantIds: string[];
  positions: Position[];
  meta: Record<string, string>;
}

export interface CandidateInput {
  ctx: AnalysisContext;
  analysis: SegmentAnalysis;
  claim: Claim;
  evidence: CodeEvidence[];
  /** Slack messages relevant to this segment. Their text is for analysis only and must not be copied into output. */
  slack?: SlackContextItem[];
  /** Why a screening pass flagged this stretch (tiered analyzer); the call is made even if nothing else looks interesting. */
  hint?: string;
  /** Facts computed by code for the model to check and interpret (fact-sheet prompt style). */
  facts?: FactSheet;
  /** Called when the model disputes a fact; the engine logs it so the rules can be improved. */
  reportDispute?: (d: { factId: string; fact: string; reason: string }) => void;
}

/** A stretch of conversation for the tiered analyzer's cheap screen. */
export interface ScreenInput {
  state: SessionState;
  /** Turns to read, oldest first: the new ones plus a little earlier context. */
  segments: Segment[];
  /** Index of the first new turn; earlier ones are context and may not be flagged. */
  firstNewIndex: number;
  slack: SlackContextItem[];
}

/** A stretch the screen thinks deserves the large model's attention. */
export interface ScreenFlag {
  segmentIds: string[];
  concern: string;
  category: DiscrepancyCategory;
}

/**
 * One Slack message as the analyzer sees it. `claim.participantId` is a `prior:slack:*` pseudo
 * participant, so Slack decisions behave like earlier recorded decisions. `pointer` is what output
 * may show in place of the text ("Slack #approvals (Dana, Oct 12)").
 */
export interface SlackContextItem {
  ref: SlackRef;
  claim: Claim;
  text: string;
  pointer: string;
}

export interface ClarificationDraft {
  format: ClarificationFormat;
  question: string;
  scenario: string | null;
  beforeAfter: { before: string; after: Record<string, string> } | null;
  decisionTable: { columns: string[]; rows: string[][] } | null;
  answerKey: { yes?: string; no?: string };
}

export type ClarificationPurpose = Clarification['purpose'];

export interface ResponseInterpretation {
  interpretationId: string | null;
  confidence: number;
  reason: string;
}

export interface Analyzer {
  readonly name: string;
  analyzeSegment(ctx: AnalysisContext): Promise<SegmentAnalysis>;
  generateCandidates(input: CandidateInput): Promise<RawCandidate[]>;
  draftClarification(
    d: Discrepancy,
    purpose: ClarificationPurpose,
    state: SessionState,
    targetParticipantId: string | null,
  ): Promise<ClarificationDraft>;
  interpretResponse(
    text: string,
    d: Discrepancy,
    opts: { clarification?: Clarification; latestOtherPosition?: Position },
  ): Promise<ResponseInterpretation>;
  /**
   * Tiered analyzers only: read a batch of recent turns cheaply and flag stretches worth a closer
   * look. The engine calls it on a timer (meeting time) instead of per turn.
   */
  screen?(input: ScreenInput): Promise<ScreenFlag[]>;
  /** Tiered analyzers only: full candidate generation for a flagged stretch. */
  deepCandidates?(input: CandidateInput): Promise<RawCandidate[]>;
}
