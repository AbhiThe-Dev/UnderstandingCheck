import type {
  AnalysisContext,
  Analyzer,
  CandidateInput,
  ClarificationDraft,
  ClarificationPurpose,
  RawCandidate,
  ResponseInterpretation,
  ScreenFlag,
  ScreenInput,
  SegmentAnalysis,
} from '../ports';
import type { Clarification, Discrepancy, Position, SessionState } from '../types';
import { HeuristicAnalyzer } from './heuristic';
import type { LlmAnalyzer } from './llm';

/**
 * Three layers, cheapest first:
 * 1. rules on every turn (free, instant; their findings go straight to validation);
 * 2. a small-model screen over each batch of turns, run by the engine on a meeting-time timer;
 * 3. the large model, only for stretches the screen flagged.
 * Clarifications and reply interpretation use the model as in the LLM analyzer (they are rare).
 */
export class TieredAnalyzer implements Analyzer {
  readonly name: string;
  private rules = new HeuristicAnalyzer();

  /** `ruleCandidates: false` keeps the rules' turn classification but drops their findings (to measure the AI layers alone). */
  constructor(
    private llm: LlmAnalyzer,
    private opts: { ruleCandidates?: boolean } = {},
  ) {
    this.name = `tiered:${llm.name}`;
  }

  analyzeSegment(ctx: AnalysisContext): Promise<SegmentAnalysis> {
    return this.rules.analyzeSegment(ctx);
  }

  async generateCandidates(input: CandidateInput): Promise<RawCandidate[]> {
    return this.opts.ruleCandidates === false ? [] : this.rules.generateCandidates(input);
  }

  screen(input: ScreenInput): Promise<ScreenFlag[]> {
    return this.llm.screenTurns(input);
  }

  deepCandidates(input: CandidateInput): Promise<RawCandidate[]> {
    return this.llm.generateCandidates(input);
  }

  draftClarification(d: Discrepancy, purpose: ClarificationPurpose, state: SessionState, targetParticipantId: string | null): Promise<ClarificationDraft> {
    return this.llm.draftClarification(d, purpose, state, targetParticipantId);
  }

  interpretResponse(text: string, d: Discrepancy, opts: { clarification?: Clarification; latestOtherPosition?: Position }): Promise<ResponseInterpretation> {
    return this.llm.interpretResponse(text, d, opts);
  }
}
