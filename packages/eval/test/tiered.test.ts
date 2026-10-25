import { DEFAULT_CONFIG, LlmAnalyzer, SessionEngine, TieredAnalyzer, estimateCostUsd, parseTranscript } from '@uc/core';
import { SEEDED_DEMO } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { describe, expect, it } from 'vitest';
import { MemoryUsage, loadSampleRepo } from '../src/runner';

const TRANSCRIPT = `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.`;

const interpretations = [
  { id: 'A', label: 'Status only', behavior: 'Only the status changes; access stays.' },
  { id: 'B', label: 'Revoke access', behavior: 'Undo also revokes the access granted on approval.' },
];

function candidate(over: Record<string, unknown> = {}) {
  return {
    key: 'llm:undo-access',
    category: 'false_alignment',
    title: 'Agreement may hide different expectations about access',
    description: 'Approval also grants access; nobody said whether undo revokes it.',
    quotes: [{ segmentId: 's2', quote: 'set the status back to pending' }],
    codeRefs: [{ evidenceId: 'E1', startLine: 22, endLine: 22, note: 'grantAccess call' }],
    interpretations,
    consequence: 'permission',
    impactExplanation: 'Access could remain after undo.',
    confidence: 0.8,
    relevantParticipantIds: ['p1', 'p2'],
    statedPositions: [{ participantId: 'p2', interpretationId: 'A', segmentId: 's2', explicit: false }],
    ...over,
  };
}

type Scripts = ConstructorParameters<typeof ScriptedLlmProvider>[0];

async function engineWith(scripts: Scripts, config = {}) {
  const repo = await loadSampleRepo('approvals');
  const usage = new MemoryUsage();
  const provider = new ScriptedLlmProvider({
    clarification: { format: 'verbal', question: 'Should undo revoke access?', scenario: null, yesMeans: 'B', noMeans: 'A', decisionTable: null },
    response: { interpretationId: null, confidence: 0, reason: 'unclear' },
    ...scripts,
  });
  const analyzer = new TieredAnalyzer(new LlmAnalyzer({ provider, sessionId: 't', usage, limits: DEFAULT_CONFIG.llm }));
  const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search, usage, config });
  return { engine, provider, usage };
}

const calls = (p: ScriptedLlmProvider, op: string) => p.calls.filter((c) => c.operation === op).length;

describe('tiered analyzer', () => {
  it('never screens or analyzes inside ingest, and drops the per-turn extraction and candidate calls', async () => {
    const { engine, provider } = await engineWith({ screen: { flags: [] } });
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    // Only follow-ups to a rule finding that surfaced (wording its question, reading a reply) may use the model here.
    expect(provider.calls.filter((c) => c.operation !== 'clarification' && c.operation !== 'response')).toEqual([]);
    await engine.screenIfDue({ force: true });
    expect(calls(provider, 'screen')).toBe(1);
    expect(calls(provider, 'extraction') + calls(provider, 'candidates')).toBe(0);
  });

  it('screens on a meeting-time timer or after enough meaningful turns, not per turn', async () => {
    const { engine, provider } = await engineWith({ screen: () => ({ flags: [] }) }, { screening: { intervalMs: 60_000, maxTurns: 3 } });
    const say = async (speaker: string, text: string, timestamp: number) => {
      await engine.ingest({ speaker, text, timestamp });
      await engine.screenIfDue();
    };
    await say('Priya', 'Admins need to be able to undo an approval.', 0);
    await say('Sam', 'Morning, how was the weekend?', 5_000); // not meaningful
    expect(calls(provider, 'screen')).toBe(0);
    await say('Priya', 'The undo should also notify the member.', 61_000); // a minute has passed
    expect(calls(provider, 'screen')).toBe(1);
    await say('Sam', 'I will add an undo button.', 62_000);
    await say('Priya', 'It must be logged too.', 63_000);
    expect(calls(provider, 'screen')).toBe(1);
    await say('Sam', 'We should email support as well.', 64_000); // third meaningful turn since the last screen
    expect(calls(provider, 'screen')).toBe(2);
    // Nothing new: forcing does nothing.
    await engine.screenIfDue({ force: true });
    expect(calls(provider, 'screen')).toBe(2);
  });

  it('sends a flagged stretch to the large model, with the flag as a hint, and accepts a valid candidate', async () => {
    const { engine, provider } = await engineWith({
      screen: { flags: [{ segmentIds: ['s2', 's3'], concern: 'Agreement on status-only undo; access unclear', category: 'false_alignment' }] },
      candidates: { candidates: [candidate({ quotes: [{ segmentId: 's2', quote: 'set the status back to pending' }, { segmentId: 's3', quote: 'Sounds good' }] })] },
    });
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    await engine.screenIfDue({ force: true });
    expect(calls(provider, 'candidates')).toBe(1);
    const prompt = provider.calls.find((c) => c.operation === 'candidates')!.user;
    expect(prompt).toContain('A screening pass flagged this stretch: Agreement on status-only undo');
    expect(prompt.indexOf('<untrusted_repository_content>')).toBeLessThan(prompt.indexOf('<untrusted_transcript>'));
    expect(engine.state.discrepancies.some((d) => d.key === 'llm:undo-access')).toBe(true);
    expect(engine.state.metrics).toMatchObject({ screens: 1, screenFlags: 1, deepCalls: 1 });
  });

  it('a flag on context-only or unknown turns causes no large-model call', async () => {
    const { engine, provider } = await engineWith({
      screen: [{ flags: [] }, { flags: [{ segmentIds: ['s1'], concern: 'old turn', category: 'missing_specification' }, { segmentIds: ['s99'], concern: 'made up', category: 'missing_specification' }] }],
    });
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    await engine.screenIfDue({ force: true });
    await engine.ingest({ speaker: 'Sam', text: 'We should also send the member an email about the undo.' });
    await engine.screenIfDue({ force: true });
    expect(calls(provider, 'screen')).toBe(2);
    expect(calls(provider, 'candidates')).toBe(0);
  });

  it('the validation gate still drops an invented quote from the large model', async () => {
    const { engine } = await engineWith({
      screen: { flags: [{ segmentIds: ['s2'], concern: 'x', category: 'false_alignment' }] },
      candidates: { candidates: [candidate({ quotes: [{ segmentId: 's2', quote: 'and revoke their access' }] })] },
    });
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    await engine.screenIfDue({ force: true });
    expect(engine.state.metrics.rejectionReasons.quote_not_found).toBe(1);
    expect(engine.state.discrepancies.some((d) => d.key === 'llm:undo-access')).toBe(false);
  });

  it('rule findings surface with no model call, and the large model cannot re-raise them', async () => {
    const { engine, provider } = await engineWith({ screen: { flags: [{ segmentIds: ['s3'], concern: 'same thing', category: 'false_alignment' }] }, candidates: () => ({ candidates: [] }) });
    for (const s of parseTranscript(SEEDED_DEMO.transcript)) await engine.ingest(s);
    const fromRules = engine.state.discrepancies.find((d) => d.category === 'false_alignment')!;
    expect(fromRules).toBeDefined();
    expect(calls(provider, 'candidates')).toBe(0);
    // The large model is told what is already tracked and reuses its key: counted as a duplicate.
    const scripted = (provider as unknown as { scripts: Scripts }).scripts;
    scripted.candidates = { candidates: [candidate({ key: fromRules.key, quotes: [{ segmentId: 's2', quote: 'set the status back to pending' }] })] };
    const before = engine.state.discrepancies.length;
    await engine.screenIfDue({ force: true });
    expect(engine.state.discrepancies).toHaveLength(before);
    expect(engine.state.metrics.duplicatesSuppressed).toBeGreaterThan(0);
  });

  it('prices cached input tokens at the cached rate', () => {
    expect(estimateCostUsd('gpt-5', 1_000_000, 0)).toBeCloseTo(1.25);
    expect(estimateCostUsd('gpt-5', 1_000_000, 0, undefined, 800_000)).toBeCloseTo(0.25 + 0.1);
    expect(estimateCostUsd('gpt-5-mini', 1_000_000, 1_000_000, undefined, 1_000_000)).toBeCloseTo(0.025 + 2);
  });
});

describe('tiered analyzer without rule findings', () => {
  it('still classifies turns with the rules but raises nothing from them', async () => {
    const repo = await loadSampleRepo('approvals');
    const provider = new ScriptedLlmProvider({ screen: { flags: [] } });
    const analyzer = new TieredAnalyzer(new LlmAnalyzer({ provider, sessionId: 't', limits: DEFAULT_CONFIG.llm }), { ruleCandidates: false });
    const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search });
    for (const s of parseTranscript(SEEDED_DEMO.transcript)) await engine.ingest(s);
    expect(engine.state.discrepancies).toHaveLength(0);
    expect(engine.screenDue({ force: true })).toBe(true);
  });
});
