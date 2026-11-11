import { mergeConfig, type DeepPartial, type EngineConfig } from './config';
import { CONSEQUENCE_WEIGHT, describeEffect } from './lexicon';
import { DecisionError, PreviewError, type Analyzer, type DecisionInput, type DecisionResult, type RawDecisionFinding, type ClarificationPurpose, type PreviewInput, type PreviewResult, type RawCandidate, type SegmentAnalysis, type SlackContextItem, type SymbolSearch, type UsageSink } from './ports';
import { decide, hasLiveCapacity, scoreDiscrepancy } from './prioritizer';
import { RetrievalCache, retrieveContext, toEvidence } from './retrieval';
import { HeuristicAnalyzer } from './analyzers/heuristic';
import { buildFactSheet } from './facts';
import { slackPointer } from './slack';
import { decisionSignal, dependentsFinding, objectsTo, pickLiveFinding, validateDecision } from './decisions';
import { EMPTY_PREVIEW_USAGE, discussionWindow, isSensitivePath, onlyAgrees, previewInputHash, previewSignal, proposesChange, rulePreview, sameDecision, validatePreview } from './preview';
import { contentTerms, estimateTokens, leadingYesNo, truncate as truncateText, words } from './text';
import { addPosition, consensus, firmPositions, isOpen, isPriorRecord, needsIndependentAnswer, setStatus } from './tracker';
import type {
  Claim,
  Clarification,
  CodeEvidence,
  CodeSymbol,
  Discrepancy,
  DiscrepancyCategory,
  EngineEvent,
  ImplementationPreview,
  Participant,
  ParticipantRole,
  Position,
  PriorDecision,
  Requirement,
  Segment,
  SessionState,
  TechnicalDecision,
  TranscriptSegmentInput,
} from './types';
import { analyzeSegmentHeuristic, updateFocus } from './understanding';
import { validateCandidate } from './validate';

export interface EngineDeps {
  analyzer: Analyzer;
  /** Null when no repository is connected; the engine then reports context as insufficient. */
  search: SymbolSearch | null;
  config?: DeepPartial<EngineConfig>;
  usage?: UsageSink;
  cache?: RetrievalCache;
}

export interface SessionInit {
  sessionId: string;
  featureDescription?: string;
  priorDecisions?: PriorDecision[];
}

/** A preview analysis ready to run outside the session's queue (see `beginPreview`). */
export interface PreviewJob {
  previewId: string;
  input: PreviewInput;
  inputHash: string;
  /** Last turn the analysis reads. */
  through: number;
}

export type PreviewOutcome = { result: PreviewResult } | { error: string; usage: PreviewResult['usage'] };

/** A decision evaluation ready to run outside the session's queue (see `beginDecision`). */
export interface DecisionJob {
  decisionId: string;
  input: DecisionInput;
  inputHash: string;
  /** Last turn the evaluation reads. */
  through: number;
}

export type DecisionOutcome = { result: DecisionResult } | { error: string; usage: DecisionResult['usage'] };

export type FindingAction = 'dismiss' | 'restore' | 'mark_useful' | 'mark_not_useful';

export type DiscrepancyAction = 'ask_now' | 'dismiss' | 'save_for_later' | 'restore' | 'mark_useful' | 'mark_not_useful';

/** How many recent ingest latencies to keep for percentile reporting. */
const LATENCY_SAMPLES = 500;

/** More specific categories win when two rules describe the same underlying ambiguity. */
const CATEGORY_RANK: Record<DiscrepancyCategory, number> = {
  missing_specification: 1,
  hidden_assumption: 2,
  codebase_conflict: 3,
  direct_disagreement: 4,
  false_alignment: 5,
};

/** How long code seen on the shared screen keeps counting as context (meeting time). */
export const SCREEN_WINDOW_MS = 10 * 60_000;

/** How long Slack search results keep counting as context (meeting time). */
export const SLACK_WINDOW_MS = 15 * 60_000;
/** Slack messages kept in the window, and handed to the analyzer per segment. */
const SLACK_WINDOW_ITEMS = 8;
const SLACK_PER_SEGMENT = 4;

/** A Slack search result handed to the engine. Its text lives only in memory. */
export interface SlackObservation {
  permalink: string;
  channelName: string;
  channelKind: 'public' | 'private' | 'dm';
  authorName: string;
  ts: string;
  text: string;
}

// "Others" is several remote people sharing one audio stream (see the API's Recall capture).
const AMBIGUOUS_SPEAKER = /^(unknown|unidentified|speaker\s*\d*|participant\s*\d+|guest|others|\?+|unattributed)$/i;

export function emptyState(sessionId: string, commitSha: string): SessionState {
  return {
    sessionId,
    commitSha,
    feature: { description: '', provenance: 'unknown' },
    participants: [],
    claims: [],
    focus: null,
    evidence: [],
    contextStatus: 'none',
    existingBehavior: [],
    assumptions: [],
    openQuestions: [],
    priorDecisions: [],
    discrepancies: [],
    clarifications: [],
    requirements: [],
    metrics: {
      segmentsSeen: 0,
      analysesRun: 0,
      analysesSkipped: 0,
      retrievals: 0,
      retrievalCacheHits: 0,
      candidatesGenerated: 0,
      candidatesRejected: 0,
      rejectionReasons: {},
      suggestionsSurfaced: 0,
      duplicatesSuppressed: 0,
    },
    budgetExhausted: false,
    ended: false,
    counters: {},
  };
}

/**
 * Orchestrates the clarification engine for one discussion session:
 * Module 1 (understanding) → 2 (retrieval) → 3 (candidates, via the analyzer) → validation →
 * 5 (prioritizer) → 4 (scenario drafting, via the analyzer) → 6 (resolution tracking).
 * State is plain JSON so it can be persisted after each step and restored later.
 */
export class SessionEngine {
  readonly state: SessionState;
  readonly segments: Segment[];
  private segMap: Map<string, Segment>;
  private cfg: EngineConfig;
  private cache: RetrievalCache;
  /** Rule-based analysis for turns the model fell behind on. */
  private rules = new HeuristicAnalyzer();
  private turnAnalyzer: Analyzer | null = null;
  /** Slack message text by ref id. Deliberately not in `state`, so it is never persisted. */
  private slackItems = new Map<string, SlackContextItem>();

  private constructor(
    private deps: EngineDeps,
    state: SessionState,
    segments: Segment[],
  ) {
    this.state = state;
    this.segments = segments;
    this.segMap = new Map(segments.map((s) => [s.id, s]));
    this.cfg = mergeConfig(deps.config);
    this.cache = deps.cache ?? new RetrievalCache();
  }

  static async create(init: SessionInit, deps: EngineDeps): Promise<{ engine: SessionEngine; events: EngineEvent[] }> {
    const state = emptyState(init.sessionId, deps.search?.commitSha ?? 'none');
    const engine = new SessionEngine(deps, state, []);
    const events = await engine.start(init);
    return { engine, events };
  }

  static restore(state: SessionState, segments: Segment[], deps: EngineDeps): SessionEngine {
    return new SessionEngine(deps, state, segments);
  }

  get config(): EngineConfig {
    return this.cfg;
  }

  // ------------------------------------------------------------------ lifecycle

  private async start(init: SessionInit): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for (const pd of init.priorDecisions ?? []) {
      this.state.priorDecisions.push(pd);
      const p: Participant = { id: `prior:${pd.id}`, displayName: `Earlier decision (${pd.source})`, role: 'stakeholder', ambiguous: false };
      this.state.participants.push(p);
      const a = analyzeSegmentHeuristic({ state: this.state, segment: { id: `prior:${pd.id}`, index: -1, participantId: p.id, timestamp: 0, text: pd.description }, participant: p, recent: [] });
      this.state.claims.push({
        id: this.nextId('c'),
        segmentId: `prior:${pd.id}`,
        participantId: p.id,
        kinds: a.kinds.includes('statement') ? ['requirement'] : a.kinds,
        text: pd.description,
        terms: a.terms,
        polarity: a.polarity === 'neutral' ? 'positive' : a.polarity,
        provenance: 'explicit',
        ambiguousSpeaker: false,
      });
    }
    if (init.featureDescription?.trim()) {
      const text = init.featureDescription.trim();
      this.state.feature = { description: text, provenance: 'explicit' };
      const pseudo: Participant = { id: 'session', displayName: 'Session setup', role: 'stakeholder', ambiguous: false };
      const analysis = analyzeSegmentHeuristic({
        state: this.state,
        segment: { id: 'feature', index: -1, participantId: pseudo.id, timestamp: 0, text },
        participant: pseudo,
        recent: [],
      });
      const evidence = await this.retrieve(analysis, events);
      this.state.focus = updateFocus(this.state, text, { ...analysis, kinds: [...analysis.kinds, 'requirement'] }, evidence, null, null);
      this.noteExistingBehavior();
    }
    return events;
  }

  /** Record a turn and analyse it right away (manual input, replays, tests). */
  async ingest(input: TranscriptSegmentInput): Promise<EngineEvent[]> {
    const events = this.record(input);
    const added = events.find((e): e is Extract<EngineEvent, { type: 'segment_added' }> => e.type === 'segment_added');
    if (!added) return events;
    events.push(...(await this.analyzeTurn(added.segment, this.deps.analyzer)));
    return events;
  }

  /**
   * Live capture, step 1: store the turn so it shows in the transcript at once. No model calls.
   * `analyzePending` analyses it afterwards.
   */
  record(input: TranscriptSegmentInput): EngineEvent[] {
    if (input.externalId) {
      const seen = (this.state.externalIds ??= []);
      if (seen.includes(input.externalId)) {
        this.state.metrics.duplicateSegments = (this.state.metrics.duplicateSegments ?? 0) + 1;
        return [{ type: 'duplicate_segment', externalId: input.externalId }];
      }
      seen.push(input.externalId);
    }
    // Sessions saved before turns were recorded and analysed separately: everything so far was analysed.
    this.state.analyzedThrough ??= this.segments.length - 1;
    const events: EngineEvent[] = [];
    const participant = this.resolveParticipant(input.speaker, input.role, events);
    const last = this.segments.at(-1);
    const segment: Segment = {
      id: this.nextId('s'),
      index: this.segments.length,
      participantId: participant.id,
      timestamp: input.timestamp ?? (last ? last.timestamp + 4000 : 0),
      text: input.text.trim(),
    };
    this.segments.push(segment);
    this.segMap.set(segment.id, segment);
    this.state.metrics.segmentsSeen++;
    events.push({ type: 'segment_added', segment });
    return events;
  }

  /** Turns recorded but not yet analysed. */
  get pendingTurns(): number {
    return this.segments.length - 1 - (this.state.analyzedThrough ?? this.segments.length - 1);
  }

  /**
   * Live capture, step 2: analyse recorded turns in order. When newer turns are already waiting
   * (the model fell behind), an older turn gets the free rule-based analysis instead of a model call:
   * it still counts as context, but the newest turns get the model's attention.
   */
  async analyzePending(): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    while (this.pendingTurns > 0) {
      const next = this.segments[(this.state.analyzedThrough ?? -1) + 1]!;
      const newer = this.segments.length - 1 - next.index;
      const stale = newer >= this.cfg.liveAnalysis.fullTurns;
      if (stale) this.state.metrics.staleTurns = (this.state.metrics.staleTurns ?? 0) + 1;
      events.push(...(await this.analyzeTurn(next, stale ? this.rules : this.deps.analyzer)));
    }
    return events;
  }

  private async analyzeTurn(segment: Segment, analyzer: Analyzer): Promise<EngineEvent[]> {
    const started = performance.now();
    this.turnAnalyzer = analyzer;
    try {
      return await this.analyzeSegment(segment);
    } finally {
      this.turnAnalyzer = null;
      this.state.analyzedThrough = Math.max(this.state.analyzedThrough ?? -1, segment.index);
      const samples = (this.state.metrics.latencyMs ??= []);
      samples.push(Math.round((performance.now() - started) * 100) / 100);
      if (samples.length > LATENCY_SAMPLES) samples.splice(0, samples.length - LATENCY_SAMPLES);
    }
  }

  /** The analyzer for the turn being analysed (rules for stale turns), else the session's. */
  private get analyzer(): Analyzer {
    return this.turnAnalyzer ?? this.deps.analyzer;
  }

  private async analyzeSegment(segment: Segment): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    const participant = this.state.participants.find((p) => p.id === segment.participantId)!;
    if (this.state.ended) return events;

    // Context as of this turn: later turns may already be recorded while it is analysed.
    const recent = this.segments.slice(Math.max(0, segment.index - this.cfg.recentWindow + 1), segment.index + 1);
    const ctx = { state: this.state, segment, participant, recent };
    const analysis = await this.analyzer.analyzeSegment(ctx);
    const claim: Claim = {
      id: this.nextId('c'),
      segmentId: segment.id,
      participantId: participant.id,
      kinds: analysis.kinds,
      text: segment.text,
      terms: analysis.terms,
      polarity: analysis.polarity,
      provenance: 'explicit',
      ambiguousSpeaker: participant.ambiguous,
    };
    this.state.claims.push(claim);
    if (!this.state.feature.description && claim.kinds.includes('requirement') && !participant.ambiguous) {
      this.state.feature = { description: segment.text, provenance: 'inferred' };
    }

    // Module 6 first: does this turn answer or revisit something already open?
    await this.trackResponses(segment, analysis, participant, events);

    if (!analysis.meaningful) {
      this.state.metrics.analysesSkipped++;
      events.push({ type: 'analysis_skipped', segmentId: segment.id, reason: 'no requirement, proposal, agreement or code reference' });
      // An imperative request ("remove their premium access") can still be a change worth previewing, and a
      // short answer ("immediately, even if they're signed in") can still settle an open preview question.
      // So can a terse technical decision ("we'll cache it in Redis").
      const changeLike = proposesChange(segment.text, analysis) || decisionSignal({ text: segment.text, analysis, evidence: [] }) !== null;
      const evidence = changeLike ? await this.retrieve(analysis, events) : [];
      this.notePreview(segment, analysis, evidence, [], events);
      this.noteDecision(segment, analysis, evidence, events);
      await this.settle(segment.index, events);
      return events;
    }
    if (await this.overBudget(events)) return events;
    this.state.metrics.analysesRun++;

    const evidence = await this.retrieve(analysis, events);
    const prevFocus = this.state.focus?.symbolId;
    this.state.focus = updateFocus(this.state, segment.text, analysis, evidence, participant.id, segment.id);
    if (this.state.focus?.symbolId !== prevFocus) this.noteExistingBehavior();
    const focusEv = this.state.focus ? this.state.evidence.find((e) => e.id === this.state.focus!.evidenceId) : undefined;
    const candidateEvidence = focusEv && !evidence.some((e) => e.id === focusEv.id) ? [...evidence, focusEv] : evidence;

    const slack = this.slackContext(analysis);
    const facts = buildFactSheet({ state: this.state, segments: this.segments, evidence: candidateEvidence, slack, recentWindow: this.cfg.recentWindow });
    const raw = await this.analyzer.generateCandidates({ ctx, analysis, claim, evidence: candidateEvidence, slack, facts, reportDispute: this.disputeSink(events) });
    const touched: Discrepancy[] = [];
    for (const c of raw) {
      const d = await this.acceptCandidate(c, segment, events, slack);
      if (d) touched.push(d);
    }
    // This turn's own retrieval: the long-lived focus would make every later turn look like the same decision.
    this.notePreview(segment, analysis, evidence, touched, events);
    this.noteDecision(segment, analysis, evidence, events);
    await this.settle(segment.index, events);
    this.recordVerbalAgreement(claim, touched, events);
    return events;
  }

  /** A participant's answer entered in the UI (private scenario check, or a group question). */
  async respond(
    clarificationId: string,
    participantId: string,
    input: { interpretationId?: string | null; text: string },
  ): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    const clar = this.state.clarifications.find((c) => c.id === clarificationId);
    if (!clar) throw new Error(`Unknown clarification ${clarificationId}`);
    const d = this.discrepancy(clar.discrepancyId);
    if (!this.state.participants.some((p) => p.id === participantId)) throw new Error(`Unknown participant ${participantId}`);
    let interpretationId = input.interpretationId ?? null;
    if (interpretationId && !d.interpretations.some((i) => i.id === interpretationId)) {
      throw new Error(`Unknown interpretation ${interpretationId}`);
    }
    if (!interpretationId && input.text.trim()) {
      const r = await this.deps.analyzer.interpretResponse(input.text, d, {
        clarification: clar,
        latestOtherPosition: this.latestOtherPosition(d, participantId),
      });
      interpretationId = r.interpretationId;
    }
    const at = this.segments.length;
    clar.responses.push({ participantId, text: input.text, interpretationId, source: 'ui', at });
    if (!interpretationId) {
      clar.confirmationStatus = 'ambiguous';
      d.notes.push(`Response from ${this.name(participantId)} did not clearly match an interpretation; left unresolved.`);
      events.push({ type: 'clarification_updated', clarification: clar }, { type: 'discrepancy_updated', discrepancy: d, note: 'ambiguous response' });
      return events;
    }
    clar.confirmationStatus = 'answered';
    addPosition(d, {
      participantId,
      interpretationId,
      provenance: clar.purpose === 'private_check' ? 'scenario_answer' : 'explicit',
      clarificationId: clar.id,
      text: input.text || (d.interpretations.find((i) => i.id === interpretationId)?.label ?? interpretationId),
    });
    events.push({ type: 'clarification_updated', clarification: clar });
    await this.evaluate(d, at, events);
    return events;
  }

  async act(discrepancyId: string, action: DiscrepancyAction): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    const d = this.discrepancy(discrepancyId);
    const at = this.segments.length;
    switch (action) {
      case 'ask_now':
        if (d.status === 'potential' || d.status === 'suggested') setStatus(d, 'awaiting_response', at, 'Question asked in the meeting');
        if (d.visibility !== 'live') {
          d.visibility = 'live';
          d.surfacedAtSegmentIndex ??= at;
          await this.prepareClarifications(d, events);
        }
        break;
      case 'dismiss':
        setStatus(d, 'dismissed', at, 'Dismissed by user');
        d.visibility = 'hidden';
        break;
      case 'save_for_later':
        d.visibility = 'queued';
        d.notes.push('Saved for later');
        break;
      case 'restore':
        d.visibility = 'live';
        d.surfacedAtSegmentIndex ??= at;
        await this.prepareClarifications(d, events);
        break;
      case 'mark_useful':
        d.feedback = 'useful';
        break;
      case 'mark_not_useful':
        d.feedback = 'not_useful';
        break;
    }
    events.push({ type: 'discrepancy_updated', discrepancy: d, note: action });
    return events;
  }

  /** End of meeting: anything still open becomes an explicit open question rather than a silent decision. */
  async finalize(): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    if (this.state.ended) return events;
    const at = this.segments.length;
    // Proposals nobody turned down count as decided; `Services.endSession` evaluates them for the summary.
    this.adoptAtEnd(events);
    for (const d of this.state.discrepancies) {
      if (!isOpen(d)) continue;
      if (d.decision === 'suppress' && d.visibility === 'hidden') continue;
      setStatus(d, 'unresolved', at, 'Meeting ended without a confirmed resolution');
      let q = this.state.clarifications.find((c) => c.discrepancyId === d.id && c.confirmationStatus !== 'superseded');
      if (!q) {
        await this.addClarification(d, 'group_question', null, events);
        q = this.state.clarifications.at(-1);
      }
      this.state.openQuestions.push({ id: this.nextId('oq'), text: q?.question ?? d.title, discrepancyId: d.id });
      events.push({ type: 'discrepancy_updated', discrepancy: d, note: 'unresolved at end of meeting' });
    }
    this.state.ended = true;
    return events;
  }

  // ------------------------------------------------------------------ participants

  private resolveParticipant(label: string, role: ParticipantRole | undefined, events: EngineEvent[]): Participant {
    const name = label.trim();
    const existing = this.state.participants.find((p) => p.displayName.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (role && existing.role === 'unknown') existing.role = role;
      return existing;
    }
    const ambiguous = AMBIGUOUS_SPEAKER.test(name);
    const p: Participant = { id: this.nextId('p'), displayName: name, role: role ?? 'unknown', ambiguous };
    this.state.participants.push(p);
    events.push({ type: 'participant_added', participant: p });
    return p;
  }

  // ------------------------------------------------------------------ screen

  /**
   * Code visible on the shared screen: names and file paths read on the user's computer (the
   * desktop app never sends screen images or prose). Matching symbols join the evidence pool, so
   * "undo this" can refer to the function on screen. What people say still decides the focus; the
   * screen only sets it when there is none or the current one has gone stale.
   */
  async observeScreen(input: { identifiers: string[]; files: { path: string; line?: number }[] }): Promise<EngineEvent[]> {
    const search = this.deps.search;
    if (!search || this.state.ended) return [];
    const names = [...new Set(input.identifiers)].slice(0, 200);
    const files = input.files.slice(0, 50);
    const paths = [...new Set(files.map((f) => f.path.replace(/^\/+/, '')))];
    const [named, inFiles] = await Promise.all([search.byNames(names), paths.length > 0 && search.inFiles ? search.inFiles(paths, 200) : []]);

    const inPath = (sym: CodeSymbol, p: string) => sym.filePath === p || sym.filePath.endsWith(`/${p}`);
    const nameSet = new Set(names);
    // Named on screen counts most, then a visible line inside it, then being in a visible file.
    const score = (sym: CodeSymbol) =>
      (nameSet.has(sym.symbolName) ? 2 : 0) +
      (files.some((f) => f.line !== undefined && inPath(sym, f.path) && f.line >= sym.startLine && f.line <= sym.endLine) ? 1.5 : 0) +
      (paths.some((p) => inPath(sym, p)) ? 1 : 0);
    const unique = new Map([...named, ...inFiles].map((s) => [s.id, s]));
    const ranked = [...unique.values()]
      .filter((s) => !s.isTest && s.symbolType !== 'doc')
      .sort((a, b) => score(b) - score(a) || b.effects.length - a.effects.length)
      .slice(0, this.cfg.retrieval.maxSymbols);

    if (ranked.length === 0) {
      this.state.screen = null;
      return [{ type: 'screen_observed', evidenceIds: [], files: [] }];
    }
    const pooled = ranked.map((s) => this.poolEvidence(toEvidence(s, 'on screen')));
    const now = this.segments.at(-1)?.timestamp ?? 0;
    this.state.screen = { at: now, evidenceIds: pooled.map((e) => e.id), files: paths };

    const focusAt = this.state.focus?.segmentId ? this.segMap.get(this.state.focus.segmentId)?.timestamp : undefined;
    const focusStale = !this.state.focus || (focusAt !== undefined && now - focusAt > SCREEN_WINDOW_MS);
    const lead = pooled.find((e) => e.effects.length > 0);
    if (focusStale && lead && this.state.focus?.symbolId !== lead.symbolId) {
      this.state.focus = {
        symbolId: lead.symbolId,
        evidenceId: lead.id,
        symbolName: lead.symbolName,
        reversal: false,
        operationWords: [],
        reversalWord: null,
        actor: null,
        introducedBy: null,
        segmentId: null,
      };
      this.noteExistingBehavior();
    }
    if (this.state.contextStatus !== 'sufficient') this.state.contextStatus = 'sufficient';
    return [{ type: 'screen_observed', evidenceIds: pooled.map((e) => e.id), files: paths }];
  }

  // ------------------------------------------------------------------ slack

  /**
   * Slack messages found for this discussion (searched by the API with the user's token). Each
   * becomes an earlier-decision pseudo participant (`prior:slack:S1`), so a statement that
   * contradicts what was decided in Slack is raised like a conflict with a requirement record.
   * Only references are kept in `state`; message text stays in this engine instance.
   */
  observeSlack(messages: SlackObservation[]): EngineEvent[] {
    if (this.state.ended) return [];
    const refs = (this.state.slackRefs ??= []);
    const ids: string[] = [];
    for (const m of messages.slice(0, SLACK_WINDOW_ITEMS)) {
      if (!m.text.trim() || !m.permalink) continue;
      let ref = refs.find((r) => r.permalink === m.permalink);
      if (!ref) {
        const isPrivate = m.channelKind !== 'public';
        ref = {
          id: `S${refs.length + 1}`,
          permalink: m.permalink,
          channelLabel: isPrivate ? 'private conversation' : `#${m.channelName.replace(/^#/, '')}`,
          authorName: isPrivate ? null : m.authorName,
          ts: m.ts,
          private: isPrivate,
        };
        refs.push(ref);
      }
      const pointer = slackPointer(ref);
      const participantId = `prior:slack:${ref.id}`;
      let p = this.state.participants.find((x) => x.id === participantId);
      if (!p) {
        p = { id: participantId, displayName: pointer, role: 'stakeholder', ambiguous: false };
        this.state.participants.push(p);
      }
      const text = m.text.trim().slice(0, 2000);
      const segment = { id: `slack:${ref.id}`, index: -1, participantId, timestamp: 0, text };
      const a = analyzeSegmentHeuristic({ state: this.state, segment, participant: p, recent: [] });
      const claim: Claim = {
        id: `c-slack-${ref.id}`,
        segmentId: segment.id,
        participantId,
        kinds: a.kinds,
        text,
        terms: a.terms,
        polarity: a.polarity,
        provenance: 'explicit',
        ambiguousSpeaker: false,
      };
      this.slackItems.set(ref.id, { ref, claim, text, pointer });
      if (!ids.includes(ref.id)) ids.push(ref.id);
    }
    const now = this.segments.at(-1)?.timestamp ?? 0;
    const prev = this.state.slack && now - this.state.slack.at <= SLACK_WINDOW_MS ? this.state.slack.refIds : [];
    const refIds = [...ids, ...prev.filter((id) => !ids.includes(id))].slice(0, SLACK_WINDOW_ITEMS);
    this.state.slack = { at: now, refIds };
    return [{ type: 'slack_observed', refIds: ids }];
  }

  /** Slack messages still in the window whose topic overlaps this segment, most overlap first. */
  private slackContext(analysis: Pick<SegmentAnalysis, 'terms'>): SlackContextItem[] {
    const sl = this.state.slack;
    if (!sl) return [];
    const now = this.segments.at(-1)?.timestamp ?? 0;
    if (now - sl.at > SLACK_WINDOW_MS) return [];
    const terms = new Set(analysis.terms);
    return sl.refIds
      .flatMap((id) => {
        const item = this.slackItems.get(id);
        const overlap = item ? item.claim.terms.filter((t) => terms.has(t)).length : 0;
        return item && overlap > 0 ? [{ item, overlap }] : [];
      })
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, SLACK_PER_SEGMENT)
      .map((x) => x.item);
  }

  // ------------------------------------------------------------------ implementation preview

  /**
   * Free, on every analysed turn: a turn that continues a decision already previewed joins it (so an
   * open preview knows the discussion moved on); a new proposed change with code consequences gets a
   * "worth reviewing" hint. No model call happens until someone opens or requests the preview.
   */
  private notePreview(segment: Segment, analysis: SegmentAnalysis, evidence: CodeEvidence[], touched: Discrepancy[], events: EngineEvent[]) {
    const previews = (this.state.previews ??= []);
    const cfg = this.cfg.preview;
    // Code the turn names, not code that merely stays on screen while the topic changes.
    const primary = evidence.filter((e) => !e.isTest && e.reason.startsWith('matches')).map((e) => e.symbolId);
    // Dismissed decisions still absorb their turns, so a dismissed topic never comes back as a new hint.
    const same = [...previews].reverse().find((p) => sameDecision(p, analysis.terms, primary, cfg.minOverlap));
    if (same) return this.linkPreview(same, segment, analysis.terms, events);

    const signal = previewSignal({ text: segment.text, analysis, evidence, touched });
    const latest = previews.at(-1);
    const lastTurn = latest ? this.segMap.get(latest.segmentIds.at(-1)!) : undefined;
    const near = !!lastTurn && segment.index - lastTurn.index <= cfg.followUpTurns;
    if (signal && signal.score >= cfg.hintThreshold) {
      // A refinement right after a decision ("…and revoke their access as part of the undo") stays with it:
      // a direct reply from someone else, or a nearby turn that shares a word with it.
      const reply = !!lastTurn && segment.index - lastTurn.index === 1 && segment.participantId !== lastTurn.participantId;
      if (latest && near && (reply || analysis.terms.some((t) => latest.terms.includes(t)))) {
        latest.symbolIds = [...new Set([...latest.symbolIds, ...signal.symbolIds])];
        return this.linkPreview(latest, segment, analysis.terms, events);
      }
      const p: ImplementationPreview = {
        id: this.nextId('ip'),
        trigger: 'auto',
        status: 'suggested',
        terms: signal.terms,
        // The whole call path the turn reached: a later turn naming a callee is about the same decision.
        symbolIds: [...new Set([...signal.symbolIds, ...evidence.filter((e) => !e.isTest).map((e) => e.symbolId)])],
        reasons: signal.reasons,
        score: signal.score,
        segmentIds: [segment.id],
        createdAtSegmentIndex: segment.index,
        generatedThroughSegmentIndex: null,
        newSegmentIds: [],
        content: null,
        evidenceIds: evidence.map((e) => e.id),
        inputHash: null,
        removed: [],
        usage: { ...EMPTY_PREVIEW_USAGE },
        generations: 0,
        cacheHits: 0,
        error: null,
      };
      previews.push(p);
      this.state.metrics.previewsSuggested = (this.state.metrics.previewsSuggested ?? 0) + 1;
      events.push({ type: 'preview_updated', preview: p, note: 'suggested' });
      return;
    }
    // Questions, answers and clarifications right after a decision; unrelated remarks stay out of it.
    const responds =
      leadingYesNo(segment.text) !== null ||
      analysis.kinds.some((k) => k !== 'statement' && k !== 'agreement') ||
      analysis.terms.some((t) => latest?.terms.includes(t));
    if (latest && near && !onlyAgrees(analysis) && responds) this.linkPreview(latest, segment, analysis.terms, events);
  }

  private linkPreview(p: ImplementationPreview, segment: Segment, terms: string[], events: EngineEvent[]) {
    if (p.segmentIds.includes(segment.id)) return;
    p.segmentIds.push(segment.id);
    if (terms.length) p.terms = [...new Set([...p.terms, ...terms])].slice(0, 40);
    if (p.generatedThroughSegmentIndex !== null && segment.index > p.generatedThroughSegmentIndex) p.newSegmentIds.push(segment.id);
    if (p.status !== 'dismissed') events.push({ type: 'preview_updated', preview: p, note: 'linked' });
  }

  preview(id: string): ImplementationPreview {
    const p = this.state.previews?.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown preview ${id}`);
    return p;
  }

  dismissPreview(id: string): EngineEvent[] {
    const p = this.preview(id);
    p.status = 'dismissed';
    return [{ type: 'preview_updated', preview: p, note: 'dismissed' }];
  }

  /**
   * Step 1 of a preview, inside the session's queue: pick the decision (`previewId`, or for a manual
   * request the decision the latest turns belong to, else a new one), retrieve its code within the
   * preview budget, and hash what the analysis would read. Unchanged input reuses the earlier answer
   * (`job` null, no model call). Otherwise the preview is marked generating and `job` is returned for
   * `analyzePreview`, which runs outside the queue so the meeting keeps flowing.
   */
  async beginPreview(opts: { previewId?: string } = {}): Promise<{ preview: ImplementationPreview; job: PreviewJob | null; events: EngineEvent[] }> {
    const events: EngineEvent[] = [];
    const previews = (this.state.previews ??= []);
    const cfg = this.cfg.preview;
    let p: ImplementationPreview;
    if (opts.previewId) {
      p = this.preview(opts.previewId);
    } else {
      if (this.segments.length === 0) throw new Error('Nothing has been said yet');
      // "Preview what we're discussing now": the last few turns, joined to their decision if there is one.
      const recent = this.segments.slice(-4);
      const joined = analyzeSegmentHeuristic({ state: this.state, segment: { ...recent.at(-1)!, text: recent.map((s) => s.text).join(' ') }, participant: this.state.participants[0]!, recent: [] });
      const evidence = await this.retrieve(joined, events).catch(() => [] as CodeEvidence[]);
      const primary = evidence.filter((e) => !e.isTest && e.reason.startsWith('matches')).map((e) => e.symbolId);
      const same = [...previews].reverse().find((x) => x.status !== 'dismissed' && sameDecision(x, joined.terms, primary, cfg.minOverlap));
      if (same) {
        p = same;
        for (const s of recent) if (!p.segmentIds.includes(s.id) && s.index > (this.segMap.get(p.segmentIds[0]!)?.index ?? -1)) this.linkPreview(p, s, [], events);
      } else {
        p = {
          id: this.nextId('ip'),
          trigger: 'manual',
          status: 'suggested',
          terms: joined.terms,
          symbolIds: evidence.filter((e) => !e.isTest).map((e) => e.symbolId),
          reasons: [],
          score: 0,
          segmentIds: recent.map((s) => s.id),
          createdAtSegmentIndex: recent.at(-1)!.index,
          generatedThroughSegmentIndex: null,
          newSegmentIds: [],
          content: null,
          evidenceIds: evidence.map((e) => e.id),
          inputHash: null,
          removed: [],
          usage: { ...EMPTY_PREVIEW_USAGE },
          generations: 0,
          cacheHits: 0,
          error: null,
        };
        previews.push(p);
      }
    }
    if (p.status === 'dismissed') p.status = p.content ? 'ready' : 'suggested'; // opened again on purpose

    const discussion = discussionWindow(this.segments, p.segmentIds, cfg);
    let evidence: CodeEvidence[];
    try {
      evidence = await this.previewEvidence(p, discussion);
    } catch (err) {
      return this.failPreview(p, `Could not search the repository: ${(err as Error).message}`, events);
    }
    const slack = this.slackContext({ terms: p.terms });
    const requirementIds = this.state.requirements.filter((r) => r.status === 'confirmed').map((r) => r.id);
    const inputHash = previewInputHash({
      commitSha: this.state.commitSha,
      segmentIds: discussion.map((s) => s.id),
      evidenceIds: evidence.map((e) => e.id),
      requirementIds,
      slackIds: slack.map((x) => x.ref.id),
      priorIds: this.state.priorDecisions.map((d) => d.id),
    });
    // Same input as last time (or as another decision's answer): reuse it, no model call.
    const twin = p.status === 'ready' && p.inputHash === inputHash ? p : previews.find((x) => x !== p && x.status === 'ready' && x.inputHash === inputHash);
    if (twin) {
      if (twin !== p) Object.assign(p, { content: twin.content, slackRefs: twin.slackRefs, removed: twin.removed, evidenceIds: twin.evidenceIds, inputHash, generatedThroughSegmentIndex: twin.generatedThroughSegmentIndex });
      p.status = 'ready';
      p.newSegmentIds = [];
      p.cacheHits++;
      this.state.metrics.previewCacheHits = (this.state.metrics.previewCacheHits ?? 0) + 1;
      events.push({ type: 'preview_updated', preview: p, note: 'reused' });
      return { preview: p, job: null, events };
    }
    if (await this.overBudget(events)) return this.failPreview(p, 'The AI budget for this month is used up.', events);

    p.status = 'generating';
    p.error = null;
    events.push({ type: 'preview_updated', preview: p, note: 'generating' });
    const input: PreviewInput = { state: this.state, discussion, focusSegmentIds: p.segmentIds, evidence, slack, previous: p.content };
    return { preview: p, job: { previewId: p.id, input, inputHash, through: discussion.at(-1)?.index ?? -1 }, events };
  }

  /** Step 2, outside the queue: the analysis. Reads only the job; changes no state; never throws. */
  async analyzePreview(job: PreviewJob): Promise<PreviewOutcome> {
    const a = this.deps.analyzer;
    try {
      return { result: a.previewImplementation ? await a.previewImplementation(job.input) : { raw: rulePreview(job.input), usage: EMPTY_PREVIEW_USAGE } };
    } catch (err) {
      return { error: err instanceof PreviewError ? err.message : 'The analysis failed.', usage: err instanceof PreviewError ? err.usage : EMPTY_PREVIEW_USAGE };
    }
  }

  /** Step 3, back in the queue: validate the answer against the evidence and transcript, then store it. */
  finishPreview(job: PreviewJob, outcome: PreviewOutcome): EngineEvent[] {
    const p = this.preview(job.previewId);
    const u = 'result' in outcome ? outcome.result.usage : outcome.usage;
    p.usage = {
      calls: p.usage.calls + u.calls,
      inputTokens: p.usage.inputTokens + u.inputTokens,
      cachedInputTokens: p.usage.cachedInputTokens + u.cachedInputTokens,
      outputTokens: p.usage.outputTokens + u.outputTokens,
      costUsd: p.usage.costUsd + u.costUsd,
      model: u.model ?? p.usage.model,
    };
    if ('error' in outcome) return this.failPreview(p, outcome.error, []).events;
    const v = validatePreview(outcome.result.raw, { evidence: job.input.evidence, segments: this.segMap, commitSha: this.state.commitSha, slack: job.input.slack, requirements: this.state.requirements });
    p.content = v.content;
    p.slackRefs = v.slackRefs;
    p.removed = v.removed;
    p.evidenceIds = job.input.evidence.map((e) => e.id);
    p.inputHash = job.inputHash;
    p.generatedThroughSegmentIndex = job.through;
    p.newSegmentIds = p.newSegmentIds.filter((id) => (this.segMap.get(id)?.index ?? -1) > job.through);
    p.generations++;
    p.error = null;
    if (p.status !== 'dismissed') p.status = 'ready';
    this.state.metrics.previewsGenerated = (this.state.metrics.previewsGenerated ?? 0) + 1;
    return [{ type: 'preview_updated', preview: p, note: 'ready' }];
  }

  /** Begin, analyse and finish in one go (manual input, replays and tests). */
  async runPreview(opts: { previewId?: string } = {}): Promise<{ preview: ImplementationPreview; events: EngineEvent[] }> {
    const { preview, job, events } = await this.beginPreview(opts);
    if (job) events.push(...this.finishPreview(job, await this.analyzePreview(job)));
    return { preview, events };
  }

  private failPreview(p: ImplementationPreview, error: string, events: EngineEvent[]) {
    // An earlier answer stays visible with the error; the user can retry.
    p.status = p.status === 'dismissed' ? 'dismissed' : 'failed';
    p.error = error;
    events.push({ type: 'preview_updated', preview: p, note: 'failed' });
    return { preview: p, job: null, events };
  }

  /**
   * Code for a preview, within the preview budget: a fresh retrieval from the decision's own words
   * (implementations, their tests, one hop of calls), then code the decision already touched (cited by
   * concerns, on screen, in focus). Never secrets-like paths; nothing outside the session's repository.
   */
  private async previewEvidence(p: ImplementationPreview, discussion: Segment[]): Promise<CodeEvidence[]> {
    const search = this.deps.search;
    if (!search) return [];
    const own = discussion.filter((s) => p.segmentIds.includes(s.id));
    const text = own.map((s) => s.text).join(' ');
    const terms = [...new Set([...contentTerms(text), ...p.terms])];
    const cfg = this.cfg.preview;
    const r = await retrieveContext({ terms, words: words(text) }, search, { ...this.cfg.retrieval, maxSymbols: cfg.maxSymbols, contextBudgetTokens: cfg.contextBudgetTokens, maxTestsPerSymbol: cfg.maxTestsPerSymbol }, this.cache);
    this.state.metrics.retrievals++;
    if (r.cacheHit) this.state.metrics.retrievalCacheHits++;
    const out: CodeEvidence[] = r.evidence.map((e) => ({ ...this.poolEvidence(e), reason: e.reason }));
    const concerns = this.state.discrepancies.filter((d) => d.status !== 'dismissed' && d.codeRefs.some((ref) => p.symbolIds.includes(this.state.evidence.find((e) => e.id === ref.evidenceId)?.symbolId ?? '')));
    const touched = [
      ...concerns.flatMap((d) => d.codeRefs.map((ref) => ref.evidenceId)),
      ...p.evidenceIds,
      ...(this.state.focus && p.symbolIds.includes(this.state.focus.symbolId) ? [this.state.focus.evidenceId] : []),
    ];
    for (const id of touched) {
      const e = this.state.evidence.find((x) => x.id === id);
      if (e && !out.some((x) => x.id === e.id)) out.push(e);
    }
    for (const e of this.screenEvidence()) if (!out.some((x) => x.id === e.id)) out.push(e);
    let tokens = 0;
    return out.filter((e) => {
      if (isSensitivePath(e.filePath)) return false;
      tokens += estimateTokens(e.snippet);
      return tokens <= cfg.contextBudgetTokens * 1.5;
    });
  }

  // ------------------------------------------------------------------ technical decisions

  /**
   * Free, on every analysed turn: track technical decisions (architecture, technology, implementation
   * approach). A turn about an open decision joins it, and agreement adopts it, an objection before
   * adoption rejects it. A new decision starts as proposed and is adopted once someone agrees or
   * `adoptAfterTurns` turns pass without objection. Only adopted decisions are evaluated, so ideas the
   * team drops cost nothing.
   */
  private noteDecision(segment: Segment, analysis: SegmentAnalysis, evidence: CodeEvidence[], events: EngineEvent[]) {
    const decisions = (this.state.decisions ??= []);
    const cfg = this.cfg.decisions;
    const primary = evidence.filter((e) => !e.isTest && e.reason.startsWith('matches')).map((e) => e.symbolId);
    const signal = decisionSignal({ text: segment.text, analysis, evidence });
    const agrees = analysis.kinds.includes('agreement') || leadingYesNo(segment.text) === 'yes';

    const linked = [...decisions].reverse().find((d) => {
      if (d.status === 'dismissed') return false;
      if (sameDecision(d, analysis.terms, primary, this.cfg.preview.minOverlap)) return true;
      // A short reply right after the decision ("sounds good", "no, that won't scale") belongs to it.
      const last = this.segMap.get(d.segmentIds.at(-1)!);
      if (!last || segment.index - last.index > this.cfg.preview.followUpTurns) return false;
      return segment.index - last.index === 1 && segment.participantId !== last.participantId && (agrees || objectsTo(analysis) || leadingYesNo(segment.text) !== null);
    });

    // "No, let's use Postgres instead": turns the open proposal down and is a decision of its own.
    const counter = !!linked && linked.status === 'proposed' && objectsTo(analysis) && !!signal?.decisive && signal.score >= cfg.detectThreshold;
    if (counter) {
      linked.status = 'rejected';
      linked.segmentIds.push(segment.id);
      events.push({ type: 'decision_updated', decision: linked, note: 'rejected' });
    }
    if (linked && !counter && !linked.segmentIds.includes(segment.id)) {
      const d = linked;
      d.segmentIds.push(segment.id);
      if (analysis.terms.length) d.terms = [...new Set([...d.terms, ...analysis.terms])].slice(0, 40);
      if (signal) {
        d.symbolIds = [...new Set([...d.symbolIds, ...signal.symbolIds])];
        d.topics = [...new Set([...d.topics, ...signal.topics])];
        d.dimensions = [...new Set([...d.dimensions, ...signal.dimensions])];
      }
      let note = 'linked';
      if (d.status === 'proposed') {
        if (objectsTo(analysis)) {
          d.status = 'rejected';
          note = 'rejected';
        } else if (agrees && segment.participantId !== d.proposedBy) {
          this.adoptDecision(d, 'agreed', segment.index);
          note = 'adopted';
        }
      } else if (d.status === 'rejected' && signal?.decisive && !objectsTo(analysis)) {
        d.status = 'proposed'; // brought back ("actually, let's go with Redis after all")
        d.summary = truncateText(segment.text, 240);
        d.proposedBy = segment.participantId;
        note = 'proposed again';
      } else if (d.evaluatedThroughSegmentIndex !== null && segment.index > d.evaluatedThroughSegmentIndex) {
        d.newSegmentIds.push(segment.id);
      }
      events.push({ type: 'decision_updated', decision: d, note });
    } else if ((!linked || counter) && signal && signal.score >= cfg.detectThreshold) {
      const d: TechnicalDecision = {
        id: this.nextId('td'),
        status: 'proposed',
        topics: signal.topics,
        dimensions: signal.dimensions,
        terms: signal.terms,
        symbolIds: signal.symbolIds,
        segmentIds: [segment.id],
        proposedBy: segment.participantId,
        createdAtSegmentIndex: segment.index,
        adoptedAtSegmentIndex: null,
        adoption: null,
        score: signal.score,
        summary: truncateText(segment.text, 240),
        verdict: null,
        findings: [],
        evidenceIds: evidence.map((e) => e.id),
        evaluatedThroughSegmentIndex: null,
        newSegmentIds: [],
        inputHash: null,
        removed: [],
        usage: { ...EMPTY_PREVIEW_USAGE },
        evaluations: 0,
        cacheHits: 0,
        error: null,
      };
      decisions.push(d);
      this.state.metrics.decisionsDetected = (this.state.metrics.decisionsDetected ?? 0) + 1;
      events.push({ type: 'decision_updated', decision: d, note: 'proposed' });
    }

    // Unopposed for long enough: decided.
    for (const d of decisions) {
      if (d.status !== 'proposed') continue;
      const last = this.segMap.get(d.segmentIds.at(-1)!);
      if (last && segment.index - last.index >= cfg.adoptAfterTurns) {
        this.adoptDecision(d, 'unopposed', segment.index);
        events.push({ type: 'decision_updated', decision: d, note: 'adopted' });
      }
    }
  }

  private adoptDecision(d: TechnicalDecision, how: NonNullable<TechnicalDecision['adoption']>, at: number) {
    d.status = 'adopted';
    d.adoption = how;
    d.adoptedAtSegmentIndex = at;
  }

  private adoptAtEnd(events: EngineEvent[]) {
    for (const d of this.state.decisions ?? []) {
      if (d.status !== 'proposed') continue;
      this.adoptDecision(d, 'meeting_end', this.segments.length - 1);
      events.push({ type: 'decision_updated', decision: d, note: 'adopted' });
    }
  }

  /** Adopted decisions waiting for evaluation (cheap; lets callers skip scheduling a no-op). */
  decisionsDue(): TechnicalDecision[] {
    return (this.state.decisions ?? []).filter((d) => d.status === 'adopted');
  }

  decision(id: string): TechnicalDecision {
    const d = this.state.decisions?.find((x) => x.id === id);
    if (!d) throw new Error(`Unknown decision ${id}`);
    return d;
  }

  dismissDecision(id: string): EngineEvent[] {
    const d = this.decision(id);
    d.status = 'dismissed';
    for (const f of d.findings) if (f.visibility === 'live') f.visibility = 'noted';
    return [{ type: 'decision_updated', decision: d, note: 'dismissed' }];
  }

  /** Evaluate a decision again on request (e.g. after the discussion moved on), or one that was skipped or failed. */
  requestDecisionEvaluation(id: string): EngineEvent[] {
    const d = this.decision(id);
    if (d.status === 'evaluating') return [];
    if (d.status === 'rejected') throw new Error('The team turned this decision down');
    this.adoptDecision(d, d.adoption ?? 'agreed', this.segments.length - 1);
    d.inputHash = null; // asked for on purpose: read the latest discussion even if nothing else changed
    return [{ type: 'decision_updated', decision: d, note: 'requested' }];
  }

  actOnFinding(decisionId: string, findingId: string, action: FindingAction): EngineEvent[] {
    const d = this.decision(decisionId);
    const f = d.findings.find((x) => x.id === findingId);
    if (!f) throw new Error(`Unknown finding ${findingId}`);
    if (action === 'dismiss') f.visibility = 'hidden';
    else if (action === 'restore') {
      f.visibility = 'live';
      f.surfacedAtSegmentIndex ??= this.segments.length - 1;
    } else f.feedback = action === 'mark_useful' ? 'useful' : 'not_useful';
    return [{ type: 'decision_updated', decision: d, note: action }];
  }

  /**
   * Step 1 of an evaluation, inside the session's queue: gather the decision's code (what it names, who
   * calls it, its tests), documentation and Slack within the decision budget, and compute the free rule
   * findings. With nothing to judge it by, the decision is skipped (no model call); with an unchanged
   * input another decision's answer is reused; without an AI analyzer, past the meeting's evaluation
   * cap or over budget, rule findings alone are stored. Otherwise `job` is returned for `analyzeDecision`.
   */
  async beginDecision(id: string): Promise<{ decision: TechnicalDecision; job: DecisionJob | null; events: EngineEvent[] }> {
    const events: EngineEvent[] = [];
    const d = this.decision(id);
    const cfg = this.cfg.decisions;
    if (d.status !== 'adopted') return { decision: d, job: null, events };
    const discussion = discussionWindow(this.segments, d.segmentIds, { ...this.cfg.preview, maxDiscussionTurns: cfg.maxDiscussionTurns, maxDiscussionChars: cfg.maxDiscussionChars });
    let evidence: CodeEvidence[];
    try {
      evidence = await this.decisionEvidence(d, discussion);
    } catch (err) {
      d.status = 'failed';
      d.error = `Could not search the repository: ${(err as Error).message}`;
      events.push({ type: 'decision_updated', decision: d, note: 'failed' });
      return { decision: d, job: null, events };
    }
    const slack = this.slackContext({ terms: d.terms });
    if (evidence.length === 0 && slack.length === 0) {
      d.status = 'skipped';
      d.verdict = 'Nothing in the indexed repository, its documentation or Slack to check this decision against.';
      events.push({ type: 'decision_updated', decision: d, note: 'skipped' });
      return { decision: d, job: null, events };
    }
    const changed = evidence.filter((e) => !e.isTest && e.reason.startsWith('matches'));
    const callers = evidence.filter((e) => e.reason.startsWith('calls '));
    const rule = dependentsFinding({ discussion, focusSegmentIds: d.segmentIds, changed, callers });
    const ruleFindings: RawDecisionFinding[] = rule ? [rule] : [];
    const input: DecisionInput = { state: this.state, decision: { id: d.id, topics: d.topics, dimensions: d.dimensions, segmentIds: d.segmentIds }, discussion, evidence, slack, ruleFindings };
    const inputHash = previewInputHash({
      commitSha: this.state.commitSha,
      segmentIds: discussion.map((s) => s.id),
      evidenceIds: evidence.map((e) => e.id),
      requirementIds: [],
      slackIds: slack.map((x) => x.ref.id),
      priorIds: this.state.priorDecisions.map((p) => p.id),
    });
    const job: DecisionJob = { decisionId: d.id, input, inputHash, through: discussion.at(-1)?.index ?? -1 };

    // Same input as another evaluated decision (a decision restated later): reuse it, no model call.
    const twin = (this.state.decisions ?? []).find((x) => x !== d && x.status === 'evaluated' && x.inputHash === inputHash);
    if (twin) {
      d.cacheHits++;
      this.state.metrics.decisionCacheHits = (this.state.metrics.decisionCacheHits ?? 0) + 1;
      return { decision: d, job: null, events: [...events, ...this.storeEvaluation(d, job, { isDecision: true, decision: twin.summary, findings: [], verdict: twin.verdict }, [], { reuse: twin })] };
    }
    const spent = (this.state.decisions ?? []).reduce((n, x) => n + x.evaluations, 0);
    const rulesOnly = !this.deps.analyzer.evaluateDecision
      ? 'Checked by rule-based checks only (AI evaluation is off).'
      : spent >= cfg.maxEvaluationsPerSession
        ? "Checked by rule-based checks only: this meeting's AI evaluations are used up."
        : (await this.overBudget(events))
          ? 'Checked by rule-based checks only: the AI budget for this month is used up.'
          : null;
    if (rulesOnly) {
      return { decision: d, job: null, events: [...events, ...this.storeEvaluation(d, job, { isDecision: true, decision: d.summary, findings: [], verdict: rulesOnly }, ruleFindings)] };
    }
    d.status = 'evaluating';
    d.error = null;
    events.push({ type: 'decision_updated', decision: d, note: 'evaluating' });
    return { decision: d, job, events };
  }

  /** Step 2, outside the queue: the model call. Reads only the job; changes no state; never throws. */
  async analyzeDecision(job: DecisionJob): Promise<DecisionOutcome> {
    const a = this.deps.analyzer;
    if (!a.evaluateDecision) return { error: 'No AI analyzer', usage: EMPTY_PREVIEW_USAGE };
    try {
      return { result: await a.evaluateDecision(job.input) };
    } catch (err) {
      return { error: err instanceof DecisionError ? err.message : 'The evaluation failed.', usage: err instanceof DecisionError ? err.usage : EMPTY_PREVIEW_USAGE };
    }
  }

  /** Step 3, back in the queue: validate, store, and decide whether one finding interrupts the meeting. */
  finishDecision(job: DecisionJob, outcome: DecisionOutcome): EngineEvent[] {
    const d = this.decision(job.decisionId);
    const u = 'result' in outcome ? outcome.result.usage : outcome.usage;
    d.usage = {
      calls: d.usage.calls + u.calls,
      inputTokens: d.usage.inputTokens + u.inputTokens,
      cachedInputTokens: d.usage.cachedInputTokens + u.cachedInputTokens,
      outputTokens: d.usage.outputTokens + u.outputTokens,
      costUsd: d.usage.costUsd + u.costUsd,
      model: u.model ?? d.usage.model,
    };
    d.evaluations++;
    this.state.metrics.decisionsEvaluated = (this.state.metrics.decisionsEvaluated ?? 0) + 1;
    if ('error' in outcome) {
      // The free rule findings still stand; the model's part is reported as failed.
      const events = this.storeEvaluation(d, job, { isDecision: true, decision: d.summary, findings: [], verdict: null }, job.input.ruleFindings);
      d.error = `AI evaluation failed (${outcome.error}); showing rule-based checks only.`;
      if (d.findings.length === 0) d.status = 'failed';
      return events;
    }
    return this.storeEvaluation(d, job, outcome.result.raw, job.input.ruleFindings);
  }

  /** Begin, analyse and finish every due decision (manual input, replays and tests). */
  async evaluateDueDecisions(): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for (let d = this.decisionsDue()[0]; d; d = this.decisionsDue()[0]) {
      const r = await this.beginDecision(d.id);
      events.push(...r.events);
      if (r.job) events.push(...this.finishDecision(r.job, await this.analyzeDecision(r.job)));
    }
    return events;
  }

  private storeEvaluation(d: TechnicalDecision, job: DecisionJob, raw: Parameters<typeof validateDecision>[0], ruleFindings: RawDecisionFinding[], opts: { reuse?: TechnicalDecision } = {}): EngineEvent[] {
    const cfg = this.cfg.decisions;
    const v = opts.reuse
      ? { summary: opts.reuse.summary, verdict: opts.reuse.verdict, findings: opts.reuse.findings.map(({ id: _id, visibility: _v, surfacedAtSegmentIndex: _s, feedback: _f, ...f }) => f), removed: opts.reuse.removed }
      : validateDecision(raw, { evidence: job.input.evidence, commitSha: this.state.commitSha, slack: job.input.slack, cfg, ruleFindings });
    const previous = new Map(d.findings.map((f) => [f.key, f]));
    // A consequence already raised for another decision is not raised twice.
    const elsewhere = new Set((this.state.decisions ?? []).filter((x) => x !== d).flatMap((x) => x.findings.filter((f) => f.visibility !== 'hidden').map((f) => f.key)));
    const removed = [...v.removed];
    d.findings = v.findings.flatMap((f) => {
      if (elsewhere.has(f.key)) {
        removed.push({ reason: 'duplicate', detail: `${f.title} (raised for an earlier decision)` });
        return [];
      }
      const prev = previous.get(f.key);
      return [{ ...f, id: prev?.id ?? this.nextId('df'), visibility: prev?.visibility ?? 'noted', surfacedAtSegmentIndex: prev?.surfacedAtSegmentIndex ?? null, feedback: prev?.feedback ?? null }];
    });
    d.summary = v.summary ?? d.summary;
    d.verdict = d.findings.length === 0 ? (v.verdict ?? 'No consequential issues found.') : null;
    d.removed = removed;
    d.evidenceIds = job.input.evidence.map((e) => e.id);
    d.inputHash = job.inputHash;
    d.evaluatedThroughSegmentIndex = job.through;
    d.newSegmentIds = d.newSegmentIds.filter((id) => (this.segMap.get(id)?.index ?? -1) > job.through);
    d.error = null;
    if (d.status !== 'dismissed') d.status = 'evaluated';
    const events: EngineEvent[] = [{ type: 'decision_updated', decision: d, note: 'evaluated' }];

    // At most one finding per decision interrupts, and never one about a decision only settled as the meeting ended.
    if (d.adoption !== 'meeting_end' && !this.state.ended) {
      const openConcerns = this.state.discrepancies.filter((x) => x.visibility === 'live' && !['resolved', 'dismissed', 'unresolved', 'confirmed'].includes(x.status)).length;
      const live = d.findings.some((f) => f.visibility === 'live') ? null : pickLiveFinding(d, this.state, cfg, openConcerns, this.cfg.rateLimit.maxOpenLive);
      if (live) {
        live.visibility = 'live';
        live.surfacedAtSegmentIndex = this.segments.length - 1;
        this.state.metrics.decisionFindingsSurfaced = (this.state.metrics.decisionFindingsSurfaced ?? 0) + 1;
        events.push({ type: 'decision_updated', decision: d, note: 'surfaced' });
      }
    }
    return events;
  }

  /**
   * What a decision evaluation reads, within the decision budget: the code its words name (with its
   * tests and one hop of calls), the code that calls it (the dependents a change would affect), code on
   * screen or in focus when it is the same code, and matching documentation sections. Never
   * secrets-like paths; nothing outside the session's repository.
   */
  private async decisionEvidence(d: TechnicalDecision, discussion: Segment[]): Promise<CodeEvidence[]> {
    const search = this.deps.search;
    if (!search) return [];
    const cfg = this.cfg.decisions;
    const own = discussion.filter((s) => d.segmentIds.includes(s.id));
    const text = own.map((s) => s.text).join(' ');
    const terms = [...new Set([...contentTerms(text), ...d.terms])];
    const base = { ...this.cfg.retrieval, maxSymbols: cfg.maxSymbols, contextBudgetTokens: cfg.contextBudgetTokens, maxTestsPerSymbol: cfg.maxTestsPerSymbol };
    const [code, docs] = await Promise.all([
      retrieveContext({ terms, words: words(text) }, search, base, this.cache),
      retrieveContext({ terms, words: words(text) }, search, { ...base, docs: 'only', maxSymbols: cfg.maxDocSections, contextBudgetTokens: cfg.docsBudgetTokens }, this.cache),
    ]);
    this.state.metrics.retrievals += 2;
    this.state.metrics.retrievalCacheHits += Number(code.cacheHit) + Number(docs.cacheHit);
    const out: CodeEvidence[] = code.evidence.map((e) => ({ ...this.poolEvidence(e), reason: e.reason }));
    const add = (e: CodeEvidence) => {
      if (!out.some((x) => x.id === e.id)) out.push(e);
    };
    for (const id of d.evidenceIds) {
      const e = this.state.evidence.find((x) => x.id === id);
      if (e && d.symbolIds.includes(e.symbolId)) add(e);
    }
    for (const e of this.screenEvidence()) if (d.symbolIds.includes(e.symbolId)) add(e);
    const changed = out.filter((e) => !e.isTest && e.reason.startsWith('matches')).map((e) => e.symbolName);
    if (changed.length > 0 && search.callersOf) {
      for (const sym of await search.callersOf(changed, cfg.maxCallers)) {
        const target = changed.find((n) => sym.calls.includes(n)) ?? changed[0];
        add({ ...this.poolEvidence(toEvidence(sym, `calls ${target}`)), reason: `calls ${target}` });
      }
    }
    for (const e of docs.evidence) add({ ...this.poolEvidence(e), reason: e.reason });
    let tokens = 0;
    const budget = (cfg.contextBudgetTokens + cfg.docsBudgetTokens) * 1.5;
    return out.filter((e) => {
      if (isSensitivePath(e.filePath)) return false;
      tokens += estimateTokens(e.snippet);
      return tokens <= budget;
    });
  }

  // ------------------------------------------------------------------ screening (tiered analyzer)

  /**
   * Run the analyzer's cheap screen over turns since the last screen, if one is due: at least one
   * meaningful new turn, and either a minute of meeting time or `maxTurns` meaningful turns have
   * passed (`force` at the end of a meeting). Each flag gets one large-model call, whose candidates
   * pass through the same validation, de-duplication and scoring as any other. Callers run this
   * outside `ingest`, so a slow model never delays the next turn.
   */
  async screenIfDue(opts: { force?: boolean } = {}): Promise<EngineEvent[]> {
    const a = this.deps.analyzer;
    if (!a.screen || !a.deepCandidates || !this.screenDue(opts)) return [];
    const sc = (this.state.screening ??= { lastSegmentIndex: -1, lastAt: this.segments[0]!.timestamp });
    const fresh = this.segments.slice(sc.lastSegmentIndex + 1);
    const now = this.segments.at(-1)!.timestamp;
    const cfg = this.cfg.screening;
    const events: EngineEvent[] = [];
    if (await this.overBudget(events)) return events;

    const firstNewIndex = sc.lastSegmentIndex + 1;
    const segments = this.segments.slice(Math.max(0, firstNewIndex - cfg.overlap));
    const joined = analyzeSegmentHeuristic({
      state: this.state,
      segment: { ...this.segments.at(-1)!, text: fresh.map((s) => s.text).join(' ') },
      participant: this.state.participants[0]!,
      recent: [],
    });
    sc.lastSegmentIndex = this.segments.length - 1;
    sc.lastAt = now;
    this.state.metrics.screens = (this.state.metrics.screens ?? 0) + 1;

    const flags = (await a.screen({ state: this.state, segments, firstNewIndex, slack: this.slackContext(joined) }))
      .map((f) => ({ ...f, segs: f.segmentIds.map((id) => this.segMap.get(id)).filter((s): s is Segment => !!s) }))
      // Only turns the screen was shown, and at least one new one.
      .filter((f) => f.segs.length > 0 && f.segs.every((s) => s.index >= segments[0]!.index) && f.segs.some((s) => s.index >= firstNewIndex))
      .slice(0, cfg.maxFlags);
    this.state.metrics.screenFlags = (this.state.metrics.screenFlags ?? 0) + flags.length;
    events.push({ type: 'screened', segments: fresh.length, flags: flags.length });

    for (const f of flags) {
      const last = f.segs.reduce((x, y) => (y.index > x.index ? y : x));
      const participant = this.state.participants.find((p) => p.id === last.participantId)!;
      const recent = this.segments.slice(Math.max(0, last.index - this.cfg.recentWindow + 1), last.index + 1);
      const ctx = { state: this.state, segment: last, participant, recent };
      const stretch = f.segs.map((s) => s.text).join(' ');
      const analysis = analyzeSegmentHeuristic({ ...ctx, segment: { ...last, text: stretch } });
      const evidence = await this.retrieve(analysis, events);
      const focusEv = this.state.focus ? this.state.evidence.find((e) => e.id === this.state.focus!.evidenceId) : undefined;
      if (focusEv && !evidence.some((e) => e.id === focusEv.id)) evidence.push(focusEv);
      const slack = this.slackContext(analysis);
      const claim = this.state.claims.find((c) => c.segmentId === last.id);
      if (!claim) continue;
      this.state.metrics.deepCalls = (this.state.metrics.deepCalls ?? 0) + 1;
      const facts = buildFactSheet({ state: this.state, segments: this.segments.slice(0, last.index + 1), evidence, slack, recentWindow: this.cfg.recentWindow });
      const raw = await a.deepCandidates({ ctx, analysis, claim, evidence, slack, hint: f.concern, facts, reportDispute: this.disputeSink(events) });
      for (const c of raw) await this.acceptCandidate(c, last, events, slack);
    }
    await this.settle(this.segments.length - 1, events);
    return events;
  }

  /** Records facts the model disputed, so rule mistakes are visible (events and a metric). */
  private disputeSink(events: EngineEvent[]) {
    return (d: { factId: string; fact: string; reason: string }) => {
      this.state.metrics.factsDisputed = (this.state.metrics.factsDisputed ?? 0) + 1;
      events.push({ type: 'fact_disputed', ...d });
    };
  }

  /** Whether `screenIfDue` would screen now (cheap; lets callers skip scheduling a no-op). */
  screenDue(opts: { force?: boolean } = {}): boolean {
    if (!this.deps.analyzer.screen || this.segments.length === 0) return false;
    if (this.state.ended && !opts.force) return false;
    const sc = this.state.screening ?? { lastSegmentIndex: -1, lastAt: this.segments[0]!.timestamp };
    const fresh = this.segments.slice(sc.lastSegmentIndex + 1);
    const meaningful = fresh.filter((s) => this.isMeaningful(s)).length;
    if (meaningful === 0) return false;
    if (opts.force) return true;
    return meaningful >= this.cfg.screening.maxTurns || this.segments.at(-1)!.timestamp - sc.lastAt >= this.cfg.screening.intervalMs;
  }

  /** The same cheap gate `ingest` uses: requirement, proposal, agreement, disagreement, reversal… */
  private isMeaningful(s: Segment): boolean {
    const participant = this.state.participants.find((p) => p.id === s.participantId);
    if (!participant) return false;
    return analyzeSegmentHeuristic({ state: this.state, segment: s, participant, recent: [] }).meaningful;
  }

  /** Text of the Slack messages this engine holds in memory (for the live panel; never persisted). */
  slackExcerpts(): { id: string; text: string }[] {
    return [...this.slackItems.values()].map((i) => ({ id: i.ref.id, text: i.text.slice(0, 280) }));
  }

  /** On-screen evidence that is still recent enough to count. */
  private screenEvidence(): CodeEvidence[] {
    const sc = this.state.screen;
    if (!sc) return [];
    const now = this.segments.at(-1)?.timestamp ?? 0;
    if (now - sc.at > SCREEN_WINDOW_MS) return [];
    return sc.evidenceIds.flatMap((id) => {
      const e = this.state.evidence.find((x) => x.id === id);
      return e ? [{ ...e, reason: 'on screen' }] : [];
    });
  }

  private poolEvidence(e: Omit<CodeEvidence, 'id'>): CodeEvidence {
    let pooled = this.state.evidence.find((x) => x.symbolId === e.symbolId);
    if (!pooled) {
      pooled = { ...e, id: `E${this.state.evidence.length + 1}` };
      this.state.evidence.push(pooled);
    }
    return pooled;
  }

  // ------------------------------------------------------------------ retrieval

  private async retrieve(analysis: SegmentAnalysis, events: EngineEvent[]): Promise<CodeEvidence[]> {
    if (!this.deps.search) {
      this.state.contextStatus = 'insufficient';
      return [];
    }
    const onScreen = this.screenEvidence();
    const terms = contentTerms(analysis.words.join(' '));
    if (terms.length === 0) return onScreen;
    const r = await retrieveContext({ terms, words: analysis.words }, this.deps.search, this.cfg.retrieval, this.cache);
    this.state.metrics.retrievals++;
    if (r.cacheHit) this.state.metrics.retrievalCacheHits++;
    const out: CodeEvidence[] = [];
    for (const e of r.evidence) {
      // The reason reflects *this* retrieval (primary match vs. followed call), the id stays stable.
      out.push({ ...this.poolEvidence(e), reason: e.reason });
    }
    // Code people are looking at counts even when nobody names it.
    for (const e of onScreen) if (!out.some((x) => x.id === e.id)) out.push(e);
    if (r.sufficient) this.state.contextStatus = 'sufficient';
    else if (this.state.contextStatus === 'none') this.state.contextStatus = 'insufficient';
    events.push({ type: 'context_retrieved', evidenceIds: out.map((e) => e.id), sufficient: r.sufficient });
    return out;
  }

  private noteExistingBehavior() {
    const f = this.state.focus;
    if (!f) return;
    const ev = this.state.evidence.find((e) => e.id === f.evidenceId);
    if (!ev) return;
    for (const eff of ev.effects) {
      const description = `${ev.symbolName} ${describeEffect(eff)}${eff.condition ? ` when ${eff.condition}` : ''} (${ev.filePath}:${eff.line})`;
      if (!this.state.existingBehavior.some((b) => b.description === description)) {
        this.state.existingBehavior.push({ evidenceId: ev.id, description });
      }
    }
  }

  // ------------------------------------------------------------------ candidates

  private async acceptCandidate(c: RawCandidate, segment: Segment, events: EngineEvent[], slack: SlackContextItem[] = []): Promise<Discrepancy | null> {
    this.state.metrics.candidatesGenerated++;
    const v = validateCandidate(c, this.state.evidence, this.segMap, this.state.commitSha, slack);
    if (!v.ok) {
      this.state.metrics.candidatesRejected++;
      this.state.metrics.rejectionReasons[v.reason] = (this.state.metrics.rejectionReasons[v.reason] ?? 0) + 1;
      events.push({ type: 'candidate_rejected', reason: v.reason, detail: v.detail });
      return null;
    }
    const at = segment.index;
    const existing = this.state.discrepancies.find((d) => d.key === c.key);
    if (existing) {
      this.state.metrics.duplicatesSuppressed++;
      if (!isOpen(existing)) return null; // never resurrect a resolved or dismissed concern
      existing.lastLinkedSegmentIndex = at;
      for (const q of v.quotes) if (!existing.statements.some((s) => s.segmentId === q.segmentId)) existing.statements.push(q);
      for (const r of v.codeRefs) if (!existing.codeRefs.some((x) => x.evidenceId === r.evidenceId && x.startLine === r.startLine)) existing.codeRefs.push(r);
      if (v.slackRefs.length > 0) {
        const cited = (existing.slackRefs ??= []);
        for (const r of v.slackRefs) if (!cited.some((x) => x.id === r.id)) cited.push(r);
      }
      for (const id of c.relevantParticipantIds) if (!existing.relevantParticipantIds.includes(id)) existing.relevantParticipantIds.push(id);
      for (const p of c.positions) {
        if (!existing.positions.some((x) => x.participantId === p.participantId && x.interpretationId === p.interpretationId && x.segmentId === p.segmentId)) existing.positions.push(p);
      }
      let note = 'additional evidence';
      if (CATEGORY_RANK[c.category] > CATEGORY_RANK[existing.category]) {
        note = `reclassified from ${existing.category} to ${c.category}`;
        existing.history.push({ at, status: existing.status, note });
        existing.category = c.category;
        existing.title = c.title;
        existing.description = c.description;
        existing.confidence = Math.max(existing.confidence, c.confidence);
        existing.meta = { ...existing.meta, ...c.meta };
        // Same interpretation ids, sharper wording (e.g. now that a concrete proposal exists).
        existing.interpretations = existing.interpretations.map((i) => {
          const next = c.interpretations.find((n) => n.id === i.id);
          return next ? { ...i, label: next.label, behavior: next.behavior } : i;
        });
        existing.surfaceAfterSegmentIndex = Math.min(existing.surfaceAfterSegmentIndex ?? at, at + this.cfg.settleWindow[c.category]);
        if (existing.visibility === 'live') await this.prepareClarifications(existing, events);
      }
      this.rescore(existing, at);
      events.push({ type: 'discrepancy_updated', discrepancy: existing, note });
      if (existing.decision === 'surface' && existing.visibility === 'hidden') await this.surface(existing, at, events);
      return existing;
    }

    const d: Discrepancy = {
      id: this.nextId('d'),
      key: c.key,
      category: c.category,
      title: c.title,
      description: c.description,
      statements: v.quotes,
      codeRefs: v.codeRefs,
      ...(v.slackRefs.length > 0 ? { slackRefs: v.slackRefs } : {}),
      interpretations: c.interpretations,
      impact: { consequence: c.consequence, explanation: c.impactExplanation },
      impactScore: 0,
      confidence: c.confidence,
      decision: 'defer',
      visibility: 'hidden',
      status: 'potential',
      relevantParticipantIds: c.relevantParticipantIds,
      positions: c.positions,
      clarificationIds: [],
      surfaceAfterSegmentIndex: at + this.cfg.settleWindow[c.category],
      surfacedAtSegmentIndex: null,
      createdAtSegmentId: segment.id,
      lastLinkedSegmentIndex: at,
      resolution: null,
      history: [{ at, status: 'potential', note: `Detected by ${this.analyzer.name}` }],
      notes: [],
      meta: c.meta,
    };
    // One live concern per operation: a lower-consequence follow-up about the same code waits for the summary.
    const sibling = d.meta.fn && this.state.discrepancies.find((x) => x.meta.fn === d.meta.fn && x.status !== 'dismissed');
    if (sibling && CONSEQUENCE_WEIGHT[d.impact.consequence] < CONSEQUENCE_WEIGHT[sibling.impact.consequence]) {
      d.meta.secondary = 'true';
      d.notes.push(`Follow-up to "${sibling.title}"; kept for the summary instead of interrupting.`);
    }
    if (segment.participantId && this.state.participants.find((p) => p.id === segment.participantId)?.ambiguous) {
      d.notes.push('Speaker attribution for the triggering statement is uncertain.');
    }
    this.state.discrepancies.push(d);
    events.push({ type: 'discrepancy_created', discrepancy: d });

    // Explicit, conflicting statements are already a confirmed difference; everything else stays suspected.
    if (consensus(d, this.minDeciders()).state === 'differ') {
      setStatus(d, 'different_expectations_confirmed', at, 'Participants explicitly stated different behavior');
    }
    this.rescore(d, at);
    if (d.decision === 'surface') await this.surface(d, at, events);
    return d;
  }

  private rescore(d: Discrepancy, at: number) {
    const s = scoreDiscrepancy(d, this.state, at, this.cfg.scoring, this.cfg.recentWindow);
    d.impactScore = s.score;
    if (d.decision === 'surface' && d.visibility !== 'hidden') return;
    d.decision = decide(s.score, this.cfg.scoring, at >= (d.surfaceAfterSegmentIndex ?? 0));
    if (d.meta.secondary === 'true' && d.decision === 'surface') d.decision = 'defer';
  }

  /** Surface deferred candidates whose settle window has elapsed. */
  private async settle(at: number, events: EngineEvent[]) {
    for (const d of this.state.discrepancies) {
      if (!isOpen(d) || d.visibility !== 'hidden') continue;
      if ((d.surfaceAfterSegmentIndex ?? 0) > at) continue;
      // Someone already took an explicit position: the team is discussing it, so let them finish
      // (for at most `discussionHoldSegments` turns after it was last mentioned).
      if (d.status === 'potential' && firmPositions(d).size > 0 && at - d.lastLinkedSegmentIndex <= this.cfg.discussionHoldSegments) continue;
      this.rescore(d, at);
      if (d.decision === 'surface') await this.surface(d, at, events);
    }
  }

  private async surface(d: Discrepancy, at: number, events: EngineEvent[], force = false) {
    if (!force && !hasLiveCapacity(this.state, this.cfg.rateLimit)) {
      d.visibility = 'queued';
      d.notes.push('Queued: too many live suggestions at once.');
      events.push({ type: 'discrepancy_updated', discrepancy: d, note: 'rate limited' });
      return;
    }
    d.visibility = 'live';
    d.surfacedAtSegmentIndex ??= at;
    if (d.status === 'potential') setStatus(d, 'suggested', at, 'Suggested privately to the user');
    this.state.metrics.suggestionsSurfaced++;
    await this.prepareClarifications(d, events);
    events.push({ type: 'discrepancy_updated', discrepancy: d, note: 'surfaced' });
  }

  /** Module 4 — make sure the right clarifications exist for the discrepancy's current state. */
  private async prepareClarifications(d: Discrepancy, events: EngineEvent[]) {
    const active = this.state.clarifications.filter((c) => c.discrepancyId === d.id && c.confirmationStatus !== 'superseded');
    const supersede = (purpose: ClarificationPurpose) => {
      for (const c of active.filter((x) => x.purpose === purpose && x.confirmationStatus === 'pending')) {
        c.confirmationStatus = 'superseded';
        events.push({ type: 'clarification_updated', clarification: c });
      }
    };

    if (d.status === 'different_expectations_confirmed') {
      supersede('group_question');
      if (!active.some((c) => c.purpose === 'surface_difference')) await this.addClarification(d, 'surface_difference', null, events);
      return;
    }
    if (d.category === 'false_alignment' && ['potential', 'suggested', 'awaiting_response'].includes(d.status)) {
      supersede('group_question');
      for (const pid of needsIndependentAnswer(d)) {
        if (!active.some((c) => c.purpose === 'private_check' && c.targetedParticipantId === pid)) {
          await this.addClarification(d, 'private_check', pid, events);
        }
      }
      return;
    }
    if (isOpen(d) && !active.some((c) => c.purpose === 'group_question')) await this.addClarification(d, 'group_question', null, events);
  }

  private async addClarification(d: Discrepancy, purpose: ClarificationPurpose, target: string | null, events: EngineEvent[]) {
    const draft = await this.deps.analyzer.draftClarification(d, purpose, this.state, target);
    const c: Clarification = {
      id: this.nextId('q'),
      discrepancyId: d.id,
      purpose,
      format: draft.format,
      question: draft.question,
      scenario: draft.scenario,
      beforeAfter: draft.beforeAfter,
      decisionTable: draft.decisionTable,
      targetedParticipantId: target,
      private: purpose === 'private_check',
      answerKey: draft.answerKey,
      responses: [],
      confirmationStatus: 'pending',
    };
    this.state.clarifications.push(c);
    d.clarificationIds.push(c.id);
    events.push({ type: 'clarification_created', clarification: c });
  }

  // ------------------------------------------------------------------ resolution tracking

  private latestOtherPosition(d: Discrepancy, participantId: string): Position | undefined {
    return [...d.positions].reverse().find((p) => p.participantId !== participantId && p.provenance !== 'inferred');
  }

  /**
   * Is this turn about discrepancy `d`? Topical when it uses the concern's own terms; otherwise only
   * a short reply right after the topic was last discussed, or an answer to a question that was asked.
   */
  private link(d: Discrepancy, segment: Segment, analysis: SegmentAnalysis, participant: Participant): { linked: boolean; topical: boolean } {
    const linkTerms = new Set([...(d.meta.linkTerms ?? '').split(' '), ...(d.meta.topicTerms ?? '').split(' ')].filter(Boolean));
    const topical = analysis.terms.some((t) => linkTerms.has(t)) && !analysis.kinds.includes('question');
    if (d.status === 'resolved') return { linked: topical, topical };
    const near = segment.index - d.lastLinkedSegmentIndex <= 2;
    const yn = leadingYesNo(segment.text) !== null;
    const answering = d.status === 'awaiting_response' && d.relevantParticipantIds.includes(participant.id) && yn;
    return { linked: topical || (near && (analysis.bareAgreement || yn)) || answering, topical };
  }

  /**
   * Minimum number of people who must hold a position before it counts as a decision. Always two:
   * early in a meeting only one person may have spoken, and one person's view is not shared understanding.
   */
  private minDeciders(): number {
    return 2;
  }

  private async trackResponses(segment: Segment, analysis: SegmentAnalysis, participant: Participant, events: EngineEvent[]) {
    if (participant.ambiguous) return; // positions require knowing who holds them
    for (const d of this.state.discrepancies) {
      if (d.status === 'dismissed' || d.status === 'unresolved') continue;
      const { linked, topical } = this.link(d, segment, analysis, participant);
      if (!linked) continue;
      // A spoken yes/no only answers our question if the question was asked aloud. Private checks are
      // answered in the UI, so a "yes" in the meeting is never mapped through their answer key.
      const clar = [...this.state.clarifications]
        .reverse()
        .find(
          (c) =>
            c.discrepancyId === d.id &&
            c.confirmationStatus !== 'superseded' &&
            c.purpose !== 'private_check' &&
            d.status === 'awaiting_response',
        );
      const r = await this.analyzer.interpretResponse(segment.text, d, {
        clarification: clar,
        latestOtherPosition: this.latestOtherPosition(d, participant.id),
      });
      if (topical || r.interpretationId) d.lastLinkedSegmentIndex = segment.index;
      if (!r.interpretationId) continue;
      const realRelevant = d.relevantParticipantIds.filter((id) => !isPriorRecord(id));
      if (realRelevant.length < 2 && !d.relevantParticipantIds.includes(participant.id)) {
        d.relevantParticipantIds.push(participant.id);
      }
      const prev = firmPositions(d).get(participant.id);
      if (prev?.interpretationId === r.interpretationId && d.status !== 'resolved') continue;
      addPosition(d, { participantId: participant.id, interpretationId: r.interpretationId, provenance: 'explicit', segmentId: segment.id, text: segment.text });
      // Record the answer on the asked question, or on this person's pending private check (now moot).
      const answered =
        clar ??
        this.state.clarifications.find(
          (c) => c.discrepancyId === d.id && c.purpose === 'private_check' && c.targetedParticipantId === participant.id && c.confirmationStatus === 'pending',
        );
      if (answered) {
        answered.responses.push({ participantId: participant.id, text: segment.text, interpretationId: r.interpretationId, source: 'transcript', segmentId: segment.id, at: segment.index });
        answered.confirmationStatus = 'answered';
        events.push({ type: 'clarification_updated', clarification: answered });
      }
      if (!d.statements.some((s) => s.segmentId === segment.id)) {
        d.statements.push({ segmentId: segment.id, participantId: participant.id, quote: segment.text });
      }
      await this.evaluate(d, segment.index, events);
    }
  }

  private async evaluate(d: Discrepancy, at: number, events: EngineEvent[]) {
    const c = consensus(d, this.minDeciders());
    const before = d.status;
    const wasSurfaced = d.surfacedAtSegmentIndex !== null;

    if (d.status === 'resolved') {
      if (c.state === 'agree' && c.interpretationId === d.resolution?.interpretationId) return;
      if (c.state === 'agree') {
        this.recordResolution(d, c.interpretationId, at, 'Participants changed the decision', events);
      } else {
        setStatus(d, 'resolution_proposed', at, 'A participant changed position; the earlier decision needs reconfirmation');
        d.resolution = null;
      }
    } else if (c.state === 'agree') {
      if (d.category === 'false_alignment' && !d.history.some((h) => h.status === 'different_expectations_confirmed')) {
        d.notes.push('Independent answers matched for this scenario. This shows agreement on the scenario, not on every detail of the feature.');
      }
      if (!wasSurfaced) d.notes.push('Resolved in the conversation before it needed to be raised.');
      setStatus(d, 'confirmed', at, 'Confirmed by all relevant participants');
      this.recordResolution(d, c.interpretationId, at, 'Resolved', events);
    } else if (c.state === 'differ') {
      if (d.status !== 'different_expectations_confirmed') {
        setStatus(d, 'different_expectations_confirmed', at, `Expectations differ: ${Object.entries(c.byInterpretation).map(([i, ps]) => `${ps.map((p) => this.name(p)).join(', ')} → ${i}`).join('; ')}`);
        if (d.visibility !== 'live') await this.surface(d, at, events, true);
        else await this.prepareClarifications(d, events);
      }
    } else if (
      c.leaning &&
      (d.status === 'different_expectations_confirmed' ||
        // While a false alignment is only suspected, answers are independent checks, not proposals.
        (d.category !== 'false_alignment' && ['awaiting_response', 'suggested'].includes(d.status)))
    ) {
      setStatus(d, 'resolution_proposed', at, `${this.name(firmPositions(d).values().next().value?.participantId ?? '')} proposed a resolution`);
    }
    if (d.status !== before) events.push({ type: 'discrepancy_updated', discrepancy: d, note: `${before} → ${d.status}` });
  }

  private recordResolution(d: Discrepancy, interpretationId: string, at: number, note: string, events: EngineEvent[]) {
    const interp = d.interpretations.find((i) => i.id === interpretationId)!;
    const lineage = this.state.requirements.filter((r) => r.discrepancyId === d.id && r.status !== 'superseded');
    const prev = lineage.at(-1);
    // Only people in the room confirm a decision; an earlier record's position is context, not a vote.
    const firm = [...firmPositions(d).values()].filter((p) => d.relevantParticipantIds.includes(p.participantId) && !isPriorRecord(p.participantId));
    const scenario = this.state.clarifications.find((c) => c.discrepancyId === d.id && c.scenario && c.purpose !== 'surface_difference')?.scenario;
    // An earlier record's position is fixed; the team either kept it or replaced it.
    // Slack messages are earlier decisions too, but not requirement records that can get a new version.
    const prior = [...d.positions].reverse().find((p) => isPriorRecord(p.participantId) && !p.participantId.startsWith('prior:slack:'));
    const req: Requirement = {
      id: this.nextId('r'),
      lineageId: prev?.lineageId ?? `L${d.id}`,
      description: interp.behavior,
      status: 'confirmed',
      confirmation: d.surfacedAtSegmentIndex !== null ? 'clarified' : 'verbal',
      evidence: firm.map((p) => ({ segmentId: p.segmentId, clarificationId: p.clarificationId, participantId: p.participantId, text: p.text })),
      confirmedBy: firm.map((p) => p.participantId),
      version: (prev?.version ?? 0) + 1,
      supersedes: prev?.id ?? null,
      discrepancyId: d.id,
      acceptanceCriteria: [scenario ? `Given: ${scenario} Expected: ${interp.behavior}` : `Expected: ${interp.behavior}`],
      codeRefs: d.codeRefs,
      ...(d.slackRefs?.length ? { slackRefs: d.slackRefs } : {}),
      priorRecord: prior
        ? { id: prior.participantId.slice('prior:'.length), outcome: prior.interpretationId === interpretationId ? 'reaffirms' : 'supersedes' }
        : null,
    };
    if (prev) prev.status = 'superseded';
    this.state.requirements.push(req);
    d.resolution = { interpretationId, summary: interp.behavior, confirmedBy: req.confirmedBy, requirementId: req.id };
    setStatus(d, 'resolved', at, note);
    for (const c of this.state.clarifications) {
      if (c.discrepancyId === d.id && c.confirmationStatus === 'pending') c.confirmationStatus = 'superseded';
    }
    events.push({ type: 'requirement_recorded', requirement: req });
  }

  /** "Sounds good" after a proposal records a verbal agreement — unconfirmed if an ambiguity was raised on it. */
  private recordVerbalAgreement(claim: Claim, touched: Discrepancy[], events: EngineEvent[]) {
    if (!claim.kinds.includes('agreement') || claim.ambiguousSpeaker) return;
    const window = this.state.claims.slice(-(this.cfg.agreementWindow + 1), -1).reverse();
    const target = window.find(
      (c) =>
        c.participantId !== claim.participantId &&
        !c.ambiguousSpeaker &&
        // Earlier records are context, not something said in this meeting that can be agreed to again.
        !isPriorRecord(c.participantId) &&
        (c.kinds.includes('proposal') || c.kinds.includes('requirement')) &&
        c.polarity !== 'negative',
    );
    if (!target || this.state.requirements.some((r) => r.evidence.some((e) => e.segmentId === target.segmentId))) return;
    const flagged = touched.find((d) => isOpen(d) && d.statements.some((s) => s.segmentId === target.segmentId));
    const req: Requirement = {
      id: this.nextId('r'),
      lineageId: flagged ? `L${flagged.id}` : `Lv${claim.id}`,
      description: target.text,
      status: flagged ? 'proposed' : 'confirmed',
      confirmation: 'verbal',
      evidence: [
        { segmentId: target.segmentId, participantId: target.participantId, text: target.text },
        { segmentId: claim.segmentId, participantId: claim.participantId, text: claim.text },
      ],
      confirmedBy: flagged ? [] : [target.participantId, claim.participantId],
      version: 1,
      supersedes: null,
      discrepancyId: flagged?.id ?? null,
      acceptanceCriteria: [],
      codeRefs: [],
    };
    this.state.requirements.push(req);
    events.push({ type: 'requirement_recorded', requirement: req });
  }

  // ------------------------------------------------------------------ budget & helpers

  private async overBudget(events: EngineEvent[]): Promise<boolean> {
    if (!this.deps.usage) return false;
    const spent = await this.deps.usage.spentUsd();
    if (spent >= this.cfg.budget.workspaceLimitUsd) {
      if (!this.state.budgetExhausted) {
        this.state.budgetExhausted = true;
        events.push({ type: 'budget_exhausted', spentUsd: spent, limitUsd: this.cfg.budget.workspaceLimitUsd });
      }
      return true;
    }
    return false;
  }

  discrepancy(id: string): Discrepancy {
    const d = this.state.discrepancies.find((x) => x.id === id);
    if (!d) throw new Error(`Unknown discrepancy ${id}`);
    return d;
  }

  private name(participantId: string): string {
    return this.state.participants.find((p) => p.id === participantId)?.displayName ?? participantId;
  }

  private nextId(prefix: string): string {
    const n = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = n;
    return `${prefix}${n}`;
  }
}
