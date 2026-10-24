import type { z } from 'zod';
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

export interface LlmRequest<T> {
  operation: string;
  tier: ModelTier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

// ---------- Usage / cost ----------

export interface UsageRecord {
  sessionId: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
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
}
