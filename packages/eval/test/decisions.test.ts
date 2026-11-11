import {
  DEFAULT_CONFIG,
  HeuristicAnalyzer,
  LlmAnalyzer,
  SessionEngine,
  decisionSignal,
  analyzeSegmentHeuristic,
  parseTranscript,
  validateDecision,
  type DeepPartial,
  type EngineConfig,
  type LlmRequest,
  type RawDecisionEvaluation,
} from '@uc/core';
import { DECISION_DEMO, PREVIEW_DEMO } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { describe, expect, it } from 'vitest';
import { MemoryUsage, loadSampleRepo } from '../src/runner';

type Req = LlmRequest<unknown>;
type Answer = (req: Req) => unknown;

/** The evidence id and line range the prompt gave a symbol or documentation section. */
function ev(req: Req, file: string, symbol: string) {
  const m = req.user.match(new RegExp(`\\[(E\\d+)\\] ${file.replaceAll('.', '\\.')}:(\\d+)-(\\d+) ${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  if (!m) throw new Error(`${file} ${symbol} was not in the prompt`);
  return { evidenceId: m[1]!, start: Number(m[2]), end: Number(m[3]) };
}

/** What a good model says about caching entitlements for 24 hours: the documented one-hour limit. */
const cacheRisk: Answer = (req) => {
  const doc = ev(req, 'docs/entitlements.md', 'Entitlements › Downgrades take effect within one hour');
  return {
    isDecision: true,
    decision: 'Cache entitlements in Redis for 24 hours to speed up premium checks.',
    verdict: null,
    findings: [
      {
        kind: 'risk',
        dimension: 'compatibility',
        severity: 'high',
        title: 'A 24-hour entitlement cache breaks the one-hour downgrade promise',
        impact: 'Customers who downgrade would keep premium features for up to a day; support and finance rely on one hour.',
        refs: [{ evidenceId: doc.evidenceId, startLine: doc.start + 2, endLine: doc.start + 4, note: 'one-hour limit' }],
        slackRefs: [],
        alternative: null,
        ask: 'Our docs say downgrades take effect within an hour; should the Redis TTL be an hour, or cleared on downgrade?',
        confidence: 0.9,
      },
      // Speculation without evidence, and a minor point: validation drops both.
      { kind: 'risk', dimension: 'reliability', severity: 'high', title: 'Redis could go down', impact: 'Premium checks fail.', refs: [], slackRefs: [], alternative: null, ask: null, confidence: 0.7 },
      { kind: 'risk', dimension: 'maintainability', severity: 'low', title: 'Another service to run', impact: 'More ops work.', refs: [{ evidenceId: doc.evidenceId, startLine: doc.start, endLine: doc.start }], slackRefs: [], alternative: null, ask: null, confidence: 0.8 },
    ],
  };
};

const nothing: Answer = () => ({ isDecision: true, decision: 'Use a JWT check.', verdict: 'Fine as discussed.', findings: [] });

async function meeting(opts: { transcript: string; decision?: Answer | Answer[]; analyzer?: 'llm' | 'heuristic'; config?: DeepPartial<EngineConfig> }) {
  const repo = await loadSampleRepo('subscriptions');
  const usage = new MemoryUsage();
  const scripted = new ScriptedLlmProvider({
    extraction: () => ({ kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false }),
    candidates: () => ({ candidates: [] }),
    clarification: { format: 'verbal', question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null },
    response: { interpretationId: null, confidence: 0, reason: 'unclear' },
    decision: Array.isArray(opts.decision) ? [...opts.decision] : (opts.decision ?? nothing),
  });
  const analyzer =
    opts.analyzer === 'heuristic'
      ? new HeuristicAnalyzer()
      : new LlmAnalyzer({ provider: scripted, sessionId: 't', usage, limits: DEFAULT_CONFIG.llm, withRules: true, prices: { scripted: { inputPerMTok: 0.25, outputPerMTok: 2 } } });
  const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search, usage, config: opts.config });
  for (const s of parseTranscript(opts.transcript)) await engine.ingest(s);
  const decisionCalls = () => scripted.calls.filter((c) => c.operation === 'decision');
  return { engine, scripted, usage, decisionCalls };
}

describe('technical decision detection (rules, free)', () => {
  const signal = (text: string) => {
    const segment = { id: 's1', index: 0, participantId: 'p1', timestamp: 0, text };
    const participant = { id: 'p1', displayName: 'Leo', role: 'developer' as const, ambiguous: false };
    const state = { participants: [participant], claims: [], focus: null } as never;
    return decisionSignal({ text, analysis: analyzeSegmentHeuristic({ state, segment, participant, recent: [] }), evidence: [] });
  };

  it('recognises architecture, technology and approach decisions', () => {
    expect(signal("Let's cache entitlements in Redis with a 24 hour TTL.")?.topics).toContain('caching');
    expect(signal("We'll put the invoice export on a background queue instead of doing it in the request.")?.topics).toContain('background processing');
    expect(signal("Let's switch the reports endpoint to GraphQL.")?.topics).toEqual(expect.arrayContaining(['API and integration']));
    expect(signal("We should store the API keys in plain text in the config table.")?.dimensions).toContain('security');
  });

  it('ignores questions, product requirements, bare agreement and chatter', () => {
    expect(signal('Should we cache entitlements in Redis?')).toBeNull();
    expect(signal('When a customer downgrades their subscription, remove their access to premium features.')).toBeNull();
    expect(signal('Sounds good.')).toBeNull();
    expect(signal('The demo is on Friday, I will send the deck.')).toBeNull();
  });

  it('does not detect a decision in a product discussion', async () => {
    const { engine, decisionCalls } = await meeting({ transcript: PREVIEW_DEMO.transcript });
    expect(engine.state.decisions ?? []).toHaveLength(0);
    expect(decisionCalls()).toHaveLength(0);
  });
});

describe('technical decision lifecycle', () => {
  it('adopts a decision on agreement and evaluates it once, outside the turn path', async () => {
    const { engine, decisionCalls } = await meeting({ transcript: DECISION_DEMO.transcript, decision: cacheRisk });
    const [d] = engine.state.decisions!;
    expect(d).toMatchObject({ status: 'adopted', adoption: 'agreed', topics: expect.arrayContaining(['caching']) });
    // Turns never wait for the model: nothing was called during ingestion.
    expect(decisionCalls()).toHaveLength(0);

    await engine.evaluateDueDecisions();
    expect(decisionCalls()).toHaveLength(1);
    expect(d!.status).toBe('evaluated');
    expect(engine.state.metrics.decisionsEvaluated).toBe(1);
    expect(d!.usage.calls).toBe(1);
    expect(d!.usage.costUsd).toBeGreaterThan(0);
  });

  it('turns down a decision someone objects to before adoption, at no cost', async () => {
    const { engine, decisionCalls } = await meeting({ transcript: DECISION_DEMO.rejected });
    expect(engine.state.decisions!.map((d) => d.status)).toEqual(['rejected']);
    await engine.evaluateDueDecisions();
    await engine.finalize();
    await engine.evaluateDueDecisions();
    expect(decisionCalls()).toHaveLength(0);
  });

  it('treats a counter-proposal as a new decision and drops the first', async () => {
    const { engine } = await meeting({
      transcript: `Leo (Developer): Let's cache entitlements in Redis with a 24 hour TTL.
Priya (Developer): No, let's use the existing session cache instead of adding Redis.`,
    });
    expect(engine.state.decisions!.map((d) => d.status)).toEqual(['rejected', 'proposed']);
    expect(engine.state.decisions![1]!.summary).toMatch(/existing session cache/);
  });

  it('adopts an unopposed decision after a couple of turns, and open ones at the end of the meeting', async () => {
    const { engine } = await meeting({
      transcript: `Leo (Developer): We'll put the downgrade emails on a background queue.
Maya (PO): Next, the pricing page copy.
Priya (Designer): I have new mockups for that.`,
    });
    expect(engine.state.decisions![0]).toMatchObject({ status: 'adopted', adoption: 'unopposed' });

    const late = await meeting({ transcript: `Leo (Developer): We'll put the downgrade emails on a background queue.` });
    expect(late.engine.state.decisions![0]!.status).toBe('proposed');
    await late.engine.finalize();
    expect(late.engine.state.decisions![0]).toMatchObject({ status: 'adopted', adoption: 'meeting_end' });
  });
});

describe('technical decision evaluation', () => {
  it('surfaces one evidence-backed finding live and drops speculation and minor points', async () => {
    const { engine } = await meeting({ transcript: DECISION_DEMO.transcript, decision: cacheRisk });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    expect(d.findings).toHaveLength(1);
    const [f] = d.findings;
    expect(f).toMatchObject({ dimension: 'compatibility', severity: 'high', visibility: 'live', source: 'model' });
    // The citation resolves to the documentation section that states the limit.
    expect(f!.refs[0]).toMatchObject({ filePath: 'docs/entitlements.md', commitSha: engine.state.commitSha });
    expect(d.removed.map((r) => r.reason)).toEqual(expect.arrayContaining(['speculative', 'minor']));
    expect(engine.state.metrics.decisionFindingsSurfaced).toBe(1);
  });

  it('shows the documentation and code it read to the model, and nothing sensitive', async () => {
    const { engine, scripted } = await meeting({ transcript: DECISION_DEMO.transcript, decision: cacheRisk });
    await engine.evaluateDueDecisions();
    const prompt = scripted.calls.find((c) => c.operation === 'decision')!.user;
    expect(prompt).toContain('Project documentation');
    expect(prompt).toMatch(/docs\/entitlements\.md:\d+-\d+ Entitlements › Downgrades take effect within one hour/);
    expect(prompt).toMatch(/src\/entitlements\/entitlements\.ts:\d+-\d+ hasPremiumAccess/);
    expect(prompt).not.toMatch(/\.env/);
  });

  it('records "no consequential issues" quietly when the model finds nothing', async () => {
    const { engine } = await meeting({ transcript: DECISION_DEMO.replaceSession, decision: nothing });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    expect(d.status).toBe('evaluated');
    // The free rule check still notes the caller nobody mentioned, without interrupting.
    expect(d.findings.map((f) => [f.kind, f.source, f.visibility])).toEqual([['overlooked_dependency', 'rules', 'noted']]);
    expect(d.findings[0]!.refs.map((r) => r.symbolName)).toEqual(['getSession', 'hasPremiumAccess']);
  });

  it('checks decisions with rules alone when no AI analyzer is configured (no model calls)', async () => {
    const { engine, scripted } = await meeting({ transcript: DECISION_DEMO.replaceSession, analyzer: 'heuristic' });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    expect(d).toMatchObject({ status: 'evaluated', usage: { calls: 0 } });
    expect(d.findings.map((f) => f.kind)).toEqual(['overlooked_dependency']);
    expect(scripted.calls).toHaveLength(0);
  });

  it('respects the per-meeting evaluation cap, then falls back to rules', async () => {
    const { engine, decisionCalls } = await meeting({
      transcript: `${DECISION_DEMO.transcript}\n${DECISION_DEMO.replaceSession}`,
      decision: cacheRisk,
      config: { decisions: { maxEvaluationsPerSession: 1 } },
    });
    await engine.evaluateDueDecisions();
    expect(decisionCalls()).toHaveLength(1);
    const second = engine.state.decisions!.at(-1)!;
    expect(second.verdict ?? second.findings[0]?.source).toBeTruthy();
    expect(second.usage.calls).toBe(0);
  });

  it('keeps rule findings when the model call fails, and reports the failure', async () => {
    const { engine } = await meeting({ transcript: DECISION_DEMO.replaceSession, decision: () => 'not json at all' });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    expect(d.status).toBe('evaluated');
    expect(d.findings.map((f) => f.source)).toEqual(['rules']);
    expect(d.error).toMatch(/AI evaluation failed/);
  });

  it('marks an evaluation stale when the discussion continues, and re-checks only on request', async () => {
    const { engine, decisionCalls } = await meeting({ transcript: DECISION_DEMO.transcript, decision: [cacheRisk, nothing] });
    await engine.evaluateDueDecisions();
    await engine.ingest({ speaker: 'Leo', text: 'Actually the Redis TTL for entitlements could be one hour instead.' });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    expect(d.newSegmentIds).toHaveLength(1);
    expect(decisionCalls()).toHaveLength(1);

    engine.requestDecisionEvaluation(d.id);
    await engine.evaluateDueDecisions();
    expect(decisionCalls()).toHaveLength(2);
    expect(d.newSegmentIds).toHaveLength(0);
  });

  it('skips decisions it has nothing to check against, without a model call', async () => {
    const { engine, decisionCalls } = await meeting({
      transcript: `Leo (Developer): Let's run the marketing site on a serverless lambda behind a CDN.
Priya (Developer): Sounds good.`,
    });
    await engine.evaluateDueDecisions();
    expect(engine.state.decisions![0]).toMatchObject({ status: 'skipped' });
    expect(decisionCalls()).toHaveLength(0);
  });

  it('shares the panel with misunderstanding suggestions and never exceeds its live budget', async () => {
    const { engine } = await meeting({ transcript: DECISION_DEMO.transcript, decision: cacheRisk, config: { decisions: { maxLivePerSession: 0 } } });
    await engine.evaluateDueDecisions();
    expect(engine.state.decisions![0]!.findings[0]!.visibility).toBe('noted');
  });

  it('lets the user dismiss, rate and restore a finding', async () => {
    const { engine } = await meeting({ transcript: DECISION_DEMO.transcript, decision: cacheRisk });
    await engine.evaluateDueDecisions();
    const d = engine.state.decisions![0]!;
    const f = d.findings[0]!;
    engine.actOnFinding(d.id, f.id, 'mark_useful');
    expect(f.feedback).toBe('useful');
    engine.actOnFinding(d.id, f.id, 'dismiss');
    expect(f.visibility).toBe('hidden');
    engine.actOnFinding(d.id, f.id, 'restore');
    expect(f.visibility).toBe('live');
  });
});

describe('decision validation', () => {
  const base: RawDecisionEvaluation = { isDecision: true, decision: 'x', verdict: null, findings: [] };
  const cfg = DEFAULT_CONFIG.decisions;
  const evidence = [{ id: 'E1', symbolId: 'a', symbolName: 'getSession', filePath: 'src/auth/sessions.ts', startLine: 10, endLine: 20, commitSha: 'sha', snippet: '', reason: 'matches', effects: [], isTest: false }];
  const finding = { kind: 'better_alternative' as const, dimension: 'maintainability' as const, severity: 'high' as const, title: 't', impact: 'i', slackRefs: [], ask: null, confidence: 0.9 };

  it('rejects invented citations, ungrounded alternatives and low confidence', () => {
    const v = validateDecision(
      {
        ...base,
        findings: [
          { ...finding, refs: [{ evidenceId: 'E1', startLine: 30, endLine: 31 }], alternative: 'use X' },
          { ...finding, refs: [{ evidenceId: 'E9', startLine: 1, endLine: 1 }], alternative: 'use Y' },
          { ...finding, refs: [{ evidenceId: 'E1', startLine: 12, endLine: 12 }], alternative: null },
          { ...finding, kind: 'risk', refs: [{ evidenceId: 'E1', startLine: 12, endLine: 12 }], alternative: null, confidence: 0.3 },
        ],
      },
      { evidence, commitSha: 'sha', slack: [], cfg, ruleFindings: [] },
    );
    expect(v.findings).toHaveLength(0);
    expect(v.removed.map((r) => r.reason)).toEqual(expect.arrayContaining(['invalid_reference', 'speculative', 'no_alternative', 'low_confidence']));
    expect(v.verdict).toBe('No consequential issues found.');
  });

  it('ignores findings when the turns were not a technical decision', () => {
    const v = validateDecision({ ...base, isDecision: false, verdict: 'A product requirement.', findings: [{ ...finding, refs: [{ evidenceId: 'E1', startLine: 12, endLine: 12 }], alternative: 'x' }] }, { evidence, commitSha: 'sha', slack: [], cfg, ruleFindings: [] });
    expect(v.findings).toHaveLength(0);
    expect(v.verdict).toBe('A product requirement.');
  });
});
