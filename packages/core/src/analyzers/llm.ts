import { DEFAULT_CONFIG, estimateCostUsd, type EngineConfig, type LlmOperation, type ModelPrice } from '../config';
import type {
  AnalysisContext,
  Analyzer,
  CandidateInput,
  ClarificationDraft,
  ClarificationPurpose,
  LlmProvider,
  LlmRequest,
  RawCandidate,
  ResponseInterpretation,
  ScreenFlag,
  ScreenInput,
  SegmentAnalysis,
  UsageSink,
} from '../ports';
import type { Clarification, Discrepancy, Position, SessionState } from '../types';
import { contentTerms } from '../text';
import { analyzeSegmentHeuristic } from '../understanding';
import { interpretResponseHeuristic } from './heuristic';
import {
  CandidateSchema,
  ClarificationSchema,
  ExtractionSchema,
  PROMPTS,
  ResponseSchema,
  SYSTEM_BASE,
  renderDiscrepancy,
  renderEvidence,
  renderScreen,
  renderSlack,
  renderState,
  ScreenSchema,
} from './prompts';

export interface LlmAnalyzerOptions {
  provider: LlmProvider;
  sessionId: string;
  usage?: UsageSink;
  limits: EngineConfig['llm'];
  prices?: Record<string, ModelPrice>;
}

/**
 * Model-backed analyzer. Cheap heuristics still gate every call, so the model only sees
 * meaningful turns, compact state and the retrieved evidence — never the whole transcript or repository.
 */
export class LlmAnalyzer implements Analyzer {
  readonly name: string;
  constructor(private opts: LlmAnalyzerOptions) {
    this.name = `llm:${opts.provider.name}`;
  }

  private async call<T>(req: LlmRequest<T>): Promise<T> {
    const user = req.user.length > this.opts.limits.maxInputChars ? req.user.slice(-this.opts.limits.maxInputChars) : req.user;
    const effort = req.effort ?? this.opts.limits.effort?.[req.operation as LlmOperation];
    // One cache key per session: its calls share a system prompt and, often, the same code evidence.
    const res = await this.opts.provider.complete({ ...req, user, effort, cacheKey: req.cacheKey ?? this.opts.sessionId });
    const cached = res.usage.cachedInputTokens ?? 0;
    await this.opts.usage?.record({
      sessionId: this.opts.sessionId,
      model: res.usage.model,
      operation: req.operation,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cachedInputTokens: cached,
      estimatedCostUsd: estimateCostUsd(res.usage.model, res.usage.inputTokens, res.usage.outputTokens, this.opts.prices, cached),
    });
    return res.data;
  }

  async analyzeSegment(ctx: AnalysisContext): Promise<SegmentAnalysis> {
    const base = analyzeSegmentHeuristic(ctx);
    // Bare acknowledgements and empty chatter never need a model call.
    if (!base.meaningful || base.bareAgreement) return base;
    try {
      const out = await this.call({
        operation: 'extraction',
        tier: 'cheap',
        system: `${SYSTEM_BASE}\n\n${PROMPTS.extraction}`,
        user: `${renderState(ctx.state, 4)}\n\nNewest segment id: ${ctx.segment.id}`,
        schema: ExtractionSchema,
        schemaName: 'segment_extraction',
        maxOutputTokens: this.opts.limits.maxOutputTokens.extraction,
      });
      return {
        ...base,
        kinds: out.kinds,
        polarity: out.polarity,
        reuseTarget: out.reuseTarget ?? base.reuseTarget,
        reversalWord: out.reversal ? (base.reversalWord ?? 'undo') : base.reversalWord,
      };
    } catch {
      return base; // invalid model output: fall back to the cheap classification
    }
  }

  /** The tiered analyzer's cheap screen over a batch of turns (small model, minimal reasoning). */
  async screenTurns(input: ScreenInput): Promise<ScreenFlag[]> {
    try {
      const out = await this.call({
        operation: 'screen',
        tier: 'cheap',
        system: `${SYSTEM_BASE}\n\n${PROMPTS.screen}`,
        user: renderScreen(input),
        schema: ScreenSchema,
        schemaName: 'screen',
        maxOutputTokens: this.opts.limits.maxOutputTokens.screen,
      });
      return out.flags;
    } catch {
      return []; // a failed screen is a missed chance, never a reason to break the meeting
    }
  }

  async generateCandidates({ ctx, analysis, evidence, slack = [], hint }: CandidateInput): Promise<RawCandidate[]> {
    // Slack only arrives when it shares terms with this segment (the engine filters it), so it can justify a call.
    const interesting =
      !!hint || evidence.length > 0 || slack.length > 0 || analysis.kinds.includes('disagreement') || analysis.kinds.includes('agreement') || analysis.reuseTarget;
    if (!interesting) return [];
    let out;
    try {
      out = await this.call({
        operation: 'candidates',
        tier: 'reasoning',
        system: `${SYSTEM_BASE}\n\n${PROMPTS.candidates}`,
        // Least-changing first (code, then Slack, then the conversation) so consecutive calls share a cacheable prefix.
        user: `Retrieved code:\n${renderEvidence(evidence, this.opts.limits.maxInputChars / 2)}${
          slack.length > 0 ? `\n\nSlack messages (earlier discussion):\n${renderSlack(slack, DEFAULT_CONFIG.retrieval.slackBudgetTokens * 4)}` : ''
        }\n\n${renderState(ctx.state)}\n\nNewest segment id: ${ctx.segment.id}${hint ? `\nA screening pass flagged this stretch: ${hint}` : ''}`,
        schema: CandidateSchema,
        schemaName: 'discrepancy_candidates',
        maxOutputTokens: this.opts.limits.maxOutputTokens.candidates,
      });
    } catch {
      return [];
    }
    return out.candidates.map((c) => ({
      key: c.key,
      category: c.category,
      title: c.title,
      description: c.description,
      quotes: c.quotes,
      codeRefs: c.codeRefs,
      slackRefs: c.slackRefs,
      interpretations: c.interpretations.map((i) => ({ ...i, keywords: [] })),
      consequence: c.consequence,
      impactExplanation: c.impactExplanation,
      confidence: c.confidence,
      relevantParticipantIds: c.relevantParticipantIds.filter((id) => ctx.state.participants.some((p) => p.id === id)),
      positions: c.statedPositions
        .filter((p) => ctx.state.participants.some((x) => x.id === p.participantId))
        .map(
          (p): Position => ({
            participantId: p.participantId,
            interpretationId: p.interpretationId,
            provenance: p.explicit ? 'explicit' : 'inferred',
            segmentId: p.segmentId,
            // Slack positions show the pointer, never the message.
            text: slack.find((s) => s.claim.participantId === p.participantId)?.pointer ?? ctx.state.claims.find((cl) => cl.segmentId === p.segmentId)?.text ?? '',
          }),
        ),
      meta: { kind: 'llm', linkTerms: contentTerms(`${c.title} ${c.interpretations.map((i) => i.label).join(' ')}`).join(' ') },
    }));
  }

  async draftClarification(
    d: Discrepancy,
    purpose: ClarificationPurpose,
    state: SessionState,
    targetParticipantId: string | null,
  ): Promise<ClarificationDraft> {
    const target = state.participants.find((p) => p.id === targetParticipantId);
    try {
      const out = await this.call({
        operation: 'clarification',
        tier: 'cheap',
        system: `${SYSTEM_BASE}\n\n${PROMPTS.clarification}`,
        user: `purpose=${purpose}${target ? ` (asked privately of ${target.displayName}, ${target.role})` : ''}\nConcern: ${renderDiscrepancy(d)}`,
        schema: ClarificationSchema,
        schemaName: 'clarification',
        maxOutputTokens: this.opts.limits.maxOutputTokens.clarification,
      });
      return {
        format: out.format ?? (out.scenario ? 'scenario' : 'verbal'),
        question: out.question,
        scenario: out.scenario,
        beforeAfter: null,
        decisionTable: out.decisionTable,
        answerKey: { ...(out.yesMeans ? { yes: out.yesMeans } : {}), ...(out.noMeans ? { no: out.noMeans } : {}) },
      };
    } catch {
      return { format: 'verbal', question: d.title, scenario: null, beforeAfter: null, decisionTable: null, answerKey: {} };
    }
  }

  async interpretResponse(
    text: string,
    d: Discrepancy,
    opts: { clarification?: Clarification; latestOtherPosition?: Position },
  ): Promise<ResponseInterpretation> {
    const cheap = interpretResponseHeuristic(text, d, opts);
    if (cheap.interpretationId && cheap.confidence >= 0.7) return cheap;
    try {
      const out = await this.call({
        operation: 'response',
        tier: 'cheap',
        system: `${SYSTEM_BASE}\n\n${PROMPTS.response}`,
        user: `Concern: ${renderDiscrepancy(d)}\nQuestion asked: ${opts.clarification?.question ?? '(none — reply came up in conversation)'}\n<untrusted_transcript>${text}</untrusted_transcript>`,
        schema: ResponseSchema,
        schemaName: 'response_interpretation',
        maxOutputTokens: this.opts.limits.maxOutputTokens.response,
      });
      if (out.interpretationId && !d.interpretations.some((i) => i.id === out.interpretationId)) {
        return { interpretationId: null, confidence: 0, reason: 'model picked a non-existent interpretation' };
      }
      return out;
    } catch {
      return cheap;
    }
  }
}
