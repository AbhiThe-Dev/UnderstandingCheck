import type { z } from 'zod';
import { DEFAULT_CONFIG, estimateCostUsd, type EngineConfig, type LlmOperation, type ModelPrice } from '../config';
import type {
  AnalysisContext,
  Analyzer,
  CandidateInput,
  ClarificationDraft,
  ClarificationPurpose,
  LlmProvider,
  LlmRequest,
  LlmUsage,
  ModelTier,
  RawCandidate,
  ResponseInterpretation,
  ScreenFlag,
  ScreenInput,
  SegmentAnalysis,
  UsageSink,
} from '../ports';
import type { Clarification, Discrepancy, Position, SessionState } from '../types';
import { renderFactSheet, type FactSheet } from '../facts';
import { LlmOutputError } from '../ports';
import { contentTerms } from '../text';
import { analyzeSegmentHeuristic } from '../understanding';
import { HeuristicAnalyzer, interpretResponseHeuristic } from './heuristic';
import {
  CandidateSchema,
  ClarificationSchema,
  ExtractionSchema,
  PROMPTS,
  ResponseSchema,
  SYSTEM_BASE,
  renderDiscrepancy,
  FactCandidateSchema,
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
  /** raw: the model works everything out from code and transcript. facts: code supplies a checked fact sheet too. */
  promptStyle?: 'raw' | 'facts';
  /** Model tier for candidate generation (default: reasoning). */
  candidatesTier?: ModelTier;
  /**
   * Also keep the rule-based findings for each turn (free, instant). The model sees them as already
   * flagged and reuses their key, so the two never raise the same concern twice. Off by default here;
   * the app and eval runner turn it on.
   */
  withRules?: boolean;
}

/**
 * Model-backed analyzer. Cheap heuristics still gate every call, so the model only sees
 * meaningful turns, compact state and the retrieved evidence — never the whole transcript or repository.
 */
export class LlmAnalyzer implements Analyzer {
  readonly name: string;
  private rules = new HeuristicAnalyzer();
  constructor(private opts: LlmAnalyzerOptions) {
    this.name = `llm:${opts.provider.name}`;
  }

  private async call<T>(req: LlmRequest<T>): Promise<T> {
    const user = req.user.length > this.opts.limits.maxInputChars ? req.user.slice(-this.opts.limits.maxInputChars) : req.user;
    const effort = req.effort ?? this.opts.limits.effort?.[req.operation as LlmOperation];
    const record = (u: LlmUsage, failure: string | null) => {
      const cached = u.cachedInputTokens ?? 0;
      return this.opts.usage?.record({
        sessionId: this.opts.sessionId,
        model: u.model,
        operation: req.operation,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: cached,
        reasoningTokens: u.reasoningTokens,
        estimatedCostUsd: estimateCostUsd(u.model, u.inputTokens, u.outputTokens, this.opts.prices, cached),
        ...(failure ? { failed: true, failure } : {}),
      });
    };
    let res;
    try {
      // One cache key per session: its calls share a system prompt and, often, the same code evidence.
      res = await this.opts.provider.complete({ ...req, user, effort, cacheKey: req.cacheKey ?? this.opts.sessionId });
    } catch (err) {
      // An unusable answer is still billed: record it so cost and failure rates stay honest.
      if (err instanceof LlmOutputError) {
        await record(err.usage, err.finishReason === 'length' ? `cut off at ${req.maxOutputTokens} tokens` : err.message.replace(/^Model (returned|output) /, '').slice(0, 160));
      }
      throw err;
    }
    await record(res.usage, null);
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
      // With rules alongside, keep every kind either side saw, so the rules still find their patterns.
      const kinds = this.opts.withRules ? [...new Set([...base.kinds, ...out.kinds])].filter((k, _, all) => k !== 'statement' || all.length === 1) : out.kinds;
      return {
        ...base,
        kinds,
        polarity: this.opts.withRules && out.polarity === 'neutral' ? base.polarity : out.polarity,
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

  async generateCandidates(input: CandidateInput): Promise<RawCandidate[]> {
    const { ctx, analysis, evidence, slack = [], hint, facts, reportDispute } = input;
    const fromRules = this.opts.withRules ? await this.rules.generateCandidates(input) : [];
    // Slack only arrives when it shares terms with this segment (the engine filters it), so it can justify a call.
    const interesting =
      !!hint || evidence.length > 0 || slack.length > 0 || analysis.kinds.includes('disagreement') || analysis.kinds.includes('agreement') || analysis.reuseTarget;
    if (!interesting) return fromRules;
    const flagged = fromRules.length
      ? `\n\nAlready flagged by rules for this segment (reuse the key if you describe the same concern; add only what they miss):\n${fromRules.map((c) => `- key=${c.key} [${c.category}] ${c.title}`).join('\n')}`
      : '';
    const sheet = this.opts.promptStyle === 'facts' ? facts : undefined;
    // Least-changing first (code, then Slack, then the conversation, then the facts) so consecutive calls share a cacheable prefix.
    const user = `Retrieved code:\n${renderEvidence(evidence, this.opts.limits.maxInputChars / 2)}${
      slack.length > 0 ? `\n\nSlack messages (earlier discussion):\n${renderSlack(slack, DEFAULT_CONFIG.retrieval.slackBudgetTokens * 4)}` : ''
    }\n\n${renderState(ctx.state)}${
      sheet ? `\n\nFact sheet (machine-extracted; check before relying on it):\n${renderFactSheet(sheet)}` : ''
    }${flagged}\n\nNewest segment id: ${ctx.segment.id}${hint ? `\nA screening pass flagged this stretch: ${hint}` : ''}`;
    const base = { operation: 'candidates', tier: this.opts.candidatesTier ?? ('reasoning' as const), user, maxOutputTokens: this.opts.limits.maxOutputTokens.candidates };
    let candidates: (z.infer<typeof CandidateSchema>['candidates'][number] & { factIds?: string[] })[];
    try {
      if (sheet) {
        const out = await this.call({
          ...base,
          system: `${SYSTEM_BASE}\n\n${PROMPTS.candidatesFacts}`,
          schema: FactCandidateSchema,
          schemaName: 'fact_checked_candidates',
          maxOutputTokens: this.opts.limits.factSheetOutputTokens ?? DEFAULT_CONFIG.llm.factSheetOutputTokens,
        });
        for (const fc of out.factChecks) {
          if (fc.status !== 'disputed') continue;
          const fact = factText(sheet, fc.factId);
          if (fact) reportDispute?.({ factId: fc.factId, fact, reason: fc.reason });
        }
        candidates = out.candidates;
      } else {
        candidates = (await this.call({ ...base, system: `${SYSTEM_BASE}\n\n${PROMPTS.candidates}`, schema: CandidateSchema, schemaName: 'discrepancy_candidates' })).candidates;
      }
    } catch {
      return fromRules;
    }
    return [...fromRules, ...candidates.map((c) => ({
      key: c.key,
      category: c.category,
      title: c.title,
      description: c.description,
      quotes: c.quotes,
      codeRefs: [...c.codeRefs, ...(sheet ? factRefs(sheet, c.factIds ?? []) : [])].filter(
        (r, i, all) => all.findIndex((x) => x.evidenceId === r.evidenceId && x.startLine === r.startLine) === i,
      ),
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
    }))];
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

/** Code citations for effect facts the model relied on: the exact line the fact names. */
function factRefs(sheet: FactSheet, ids: string[]): RawCandidate['codeRefs'] {
  return ids.flatMap((id) => {
    const f = sheet.effects.find((e) => e.id === id);
    return f ? [{ evidenceId: f.evidenceId, startLine: f.line, endLine: f.line, note: `${f.symbolName}: ${f.code}` }] : [];
  });
}

function factText(sheet: FactSheet, id: string): string | null {
  const e = sheet.effects.find((f) => f.id === id);
  if (e) return `${e.filePath}:${e.line} ${e.code}; matching turns: ${e.matchingTurns.map((m) => m.segmentId).join(', ') || 'none'}`;
  const a = sheet.agreements.find((f) => f.id === id);
  if (a) return `${a.segmentId} ${a.speaker} agreed to ${a.agreedTo?.segmentId ?? 'nothing found'}`;
  const p = sheet.statements.find((f) => f.id === id) ?? sheet.priors.find((f) => f.id === id);
  return p ? JSON.stringify(p) : null;
}
