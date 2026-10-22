import { mergeConfig, type DeepPartial, type EngineConfig } from './config';
import { CONSEQUENCE_WEIGHT, describeEffect } from './lexicon';
import type { Analyzer, ClarificationPurpose, RawCandidate, SegmentAnalysis, SymbolSearch, UsageSink } from './ports';
import { decide, hasLiveCapacity, scoreDiscrepancy } from './prioritizer';
import { RetrievalCache, retrieveContext } from './retrieval';
import { contentTerms, leadingYesNo } from './text';
import { addPosition, consensus, firmPositions, isOpen, isPriorRecord, needsIndependentAnswer, setStatus } from './tracker';
import type {
  Claim,
  Clarification,
  CodeEvidence,
  Discrepancy,
  DiscrepancyCategory,
  EngineEvent,
  Participant,
  ParticipantRole,
  Position,
  PriorDecision,
  Requirement,
  Segment,
  SessionState,
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

const AMBIGUOUS_SPEAKER = /^(unknown|unidentified|speaker\s*\d*|participant\s*\d+|guest|\?+|unattributed)$/i;

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

  async ingest(input: TranscriptSegmentInput): Promise<EngineEvent[]> {
    if (input.externalId) {
      const seen = (this.state.externalIds ??= []);
      if (seen.includes(input.externalId)) {
        this.state.metrics.duplicateSegments = (this.state.metrics.duplicateSegments ?? 0) + 1;
        return [{ type: 'duplicate_segment', externalId: input.externalId }];
      }
      seen.push(input.externalId);
    }
    const started = performance.now();
    try {
      return await this.ingestSegment(input);
    } finally {
      const samples = (this.state.metrics.latencyMs ??= []);
      samples.push(Math.round((performance.now() - started) * 100) / 100);
      if (samples.length > LATENCY_SAMPLES) samples.splice(0, samples.length - LATENCY_SAMPLES);
    }
  }

  private async ingestSegment(input: TranscriptSegmentInput): Promise<EngineEvent[]> {
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
    if (this.state.ended) return events;

    const recent = this.segments.slice(-this.cfg.recentWindow);
    const ctx = { state: this.state, segment, participant, recent };
    const analysis = await this.deps.analyzer.analyzeSegment(ctx);
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

    const raw = await this.deps.analyzer.generateCandidates({ ctx, analysis, claim, evidence: candidateEvidence });
    const touched: Discrepancy[] = [];
    for (const c of raw) {
      const d = await this.acceptCandidate(c, segment, events);
      if (d) touched.push(d);
    }
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

  // ------------------------------------------------------------------ retrieval

  private async retrieve(analysis: SegmentAnalysis, events: EngineEvent[]): Promise<CodeEvidence[]> {
    if (!this.deps.search) {
      this.state.contextStatus = 'insufficient';
      return [];
    }
    const terms = contentTerms(analysis.words.join(' '));
    if (terms.length === 0) return [];
    const r = await retrieveContext({ terms, words: analysis.words }, this.deps.search, this.cfg.retrieval, this.cache);
    this.state.metrics.retrievals++;
    if (r.cacheHit) this.state.metrics.retrievalCacheHits++;
    const out: CodeEvidence[] = [];
    for (const e of r.evidence) {
      let pooled = this.state.evidence.find((x) => x.symbolId === e.symbolId);
      if (!pooled) {
        pooled = { ...e, id: `E${this.state.evidence.length + 1}` };
        this.state.evidence.push(pooled);
      }
      // The reason reflects *this* retrieval (primary match vs. followed call), the id stays stable.
      out.push({ ...pooled, reason: e.reason });
    }
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

  private async acceptCandidate(c: RawCandidate, segment: Segment, events: EngineEvent[]): Promise<Discrepancy | null> {
    this.state.metrics.candidatesGenerated++;
    const v = validateCandidate(c, this.state.evidence, this.segMap, this.state.commitSha);
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
      history: [{ at, status: 'potential', note: `Detected by ${this.deps.analyzer.name}` }],
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
      // Someone already took an explicit position: the team is discussing it, so let them finish.
      if (d.status === 'potential' && firmPositions(d).size > 0) continue;
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
      const r = await this.deps.analyzer.interpretResponse(segment.text, d, {
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
    const prior = [...d.positions].reverse().find((p) => isPriorRecord(p.participantId));
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
