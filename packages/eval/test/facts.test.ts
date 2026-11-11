import { DEFAULT_CONFIG, HeuristicAnalyzer, LlmAnalyzer, SessionEngine, buildFactSheet, parseTranscript, renderFactSheet } from '@uc/core';
import { FactCandidateSchema } from '../../core/src/analyzers/prompts';
import { ScriptedLlmProvider } from '@uc/providers';
import { describe, expect, it } from 'vitest';
import { loadSampleRepo } from '../src/runner';

const DEMO = `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.`;

async function rulesEngine(transcript: string) {
  const repo = await loadSampleRepo('approvals');
  const { engine } = await SessionEngine.create({ sessionId: 'f' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
  for (const s of parseTranscript(transcript)) await engine.ingest(s);
  return engine;
}

const sheetOf = (engine: Awaited<ReturnType<typeof rulesEngine>>) =>
  buildFactSheet({ state: engine.state, segments: engine.segments, evidence: engine.state.evidence, recentWindow: DEFAULT_CONFIG.recentWindow });

describe('fact sheet (deterministic)', () => {
  it('lists the unmentioned access grant with its code line, and who agreed to what', async () => {
    const sheet = sheetOf(await rulesEngine(DEMO));
    expect(sheet.focus).toMatchObject({ symbolName: 'approveApplication', reversal: true });
    const access = sheet.effects.find((f) => f.code.includes('grantAccess'))!;
    expect(access).toMatchObject({ filePath: 'src/applications/approve.ts', line: 22, category: 'permission', inFocus: true, matchingTurns: [] });
    expect(sheet.agreements).toEqual([expect.objectContaining({ segmentId: 's3', speaker: 'Priya', agreedTo: { segmentId: 's2', speaker: 'Sam' } })]);
    const status = sheet.effects.find((f) => f.code.includes('status'));
    if (status) expect(status.matchingTurns.map((m) => m.segmentId)).toContain('s2');
  });

  it('shows its receipt: a paraphrase the rules miss is visible as unmatched, with the words searched', async () => {
    const sheet = sheetOf(
      await rulesEngine(`Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll set the status back to pending, and they shouldn't get in anymore.
Priya (PO): Sounds good.`),
    );
    const access = sheet.effects.find((f) => f.code.includes('grantAccess'))!;
    expect(access.matchingTurns).toEqual([]);
    const text = renderFactSheet(sheet);
    expect(text).toMatch(/F\d+ src\/applications\/approve\.ts:22 approveApplication \[permission\]/);
    expect(text).toMatch(/searched recent turns for word stems: [^\n]*access[^\n]*→ matching turns: none/);
  });

  it('asks for the model output in conversation-first order', () => {
    // The JSON schema sent to the model keeps this order, and models generate fields in schema order.
    expect(Object.keys(FactCandidateSchema.shape)).toEqual(['agreements', 'openQuestions', 'factChecks', 'candidates', 'settled']);
  });
});

describe('fact-sheet prompt style', () => {
  function candidate(over: Record<string, unknown> = {}) {
    return {
      key: 'llm:undo-access',
      category: 'false_alignment',
      title: 'Agreement may hide different expectations about access',
      description: 'Undo resets the status; approval also granted access.',
      quotes: [{ segmentId: 's3', quote: 'Sounds good' }],
      slackRefs: [],
      interpretations: [
        { id: 'A', label: 'Status only', behavior: 'Access stays after undo.' },
        { id: 'B', label: 'Full undo', behavior: 'Undo also revokes access.' },
      ],
      consequence: 'permission',
      impactExplanation: 'Members could keep access.',
      confidence: 0.8,
      relevantParticipantIds: ['p1', 'p2'],
      statedPositions: [],
      ...over,
    };
  }

  async function run(output: (sheetText: string) => unknown) {
    const repo = await loadSampleRepo('approvals');
    const provider = new ScriptedLlmProvider({
      extraction: { kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false },
      candidates: (req: { user: string }) => output(req.user),
      clarification: { question: 'Should undo also remove portal access?', scenario: null, yesMeans: 'B', noMeans: 'A', decisionTable: null },
      response: { interpretationId: null, confidence: 0, reason: 'unclear' },
    });
    const analyzer = new LlmAnalyzer({ provider, sessionId: 't', limits: DEFAULT_CONFIG.llm, promptStyle: 'facts' });
    const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search });
    const events = [];
    for (const s of parseTranscript(DEMO)) events.push(...(await engine.ingest(s)));
    return { engine, provider, events };
  }

  /** The id the fact sheet gave approve.ts:22 in this prompt. */
  const accessFact = (user: string) => user.match(/(F\d+) src\/applications\/approve\.ts:22/)?.[1];

  it('sends the fact sheet after the transcript, and turns cited facts into exact code citations', async () => {
    const { engine, provider } = await run((user) => {
      const f = accessFact(user);
      return { agreements: [], openQuestions: [], factChecks: [], candidates: f && user.includes('Newest segment id: s3') ? [candidate({ factIds: [f] })] : [] };
    });
    const prompt = provider.calls.filter((c) => c.operation === 'candidates').at(-1)!.user;
    expect(prompt.indexOf('<untrusted_transcript>')).toBeLessThan(prompt.indexOf('Fact sheet (machine-extracted'));
    const d = engine.state.discrepancies.find((x) => x.key === 'llm:undo-access')!;
    expect(d.codeRefs).toEqual([expect.objectContaining({ filePath: 'src/applications/approve.ts', startLine: 22, endLine: 22 })]);
  });

  it('logs a disputed fact as an event and a metric', async () => {
    const { engine, events } = await run((user) => {
      const f = accessFact(user);
      return { agreements: [], openQuestions: [], factChecks: f ? [{ factId: f, status: 'disputed', reason: 'Sam said they lose access' }] : [], candidates: [] };
    });
    expect(events.some((e) => e.type === 'fact_disputed' && e.fact.includes('approve.ts:22'))).toBe(true);
    expect(engine.state.metrics.factsDisputed).toBeGreaterThan(0);
  });

  it('still rejects an invented quote', async () => {
    const { engine } = await run((user) => {
      const f = accessFact(user);
      return { agreements: [], openQuestions: [], factChecks: [], candidates: f ? [candidate({ factIds: [f], quotes: [{ segmentId: 's3', quote: 'and revoke their access' }] })] : [] };
    });
    expect(engine.state.discrepancies.some((x) => x.key === 'llm:undo-access')).toBe(false);
    expect(engine.state.metrics.rejectionReasons.quote_not_found).toBeGreaterThan(0);
  });
});
