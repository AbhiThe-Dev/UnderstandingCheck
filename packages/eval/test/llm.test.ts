import { DEFAULT_CONFIG, HeuristicAnalyzer, LlmAnalyzer, SessionEngine, parseTranscript } from '@uc/core';
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
    key: 'effect:approveApplication:grantAccess',
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

async function run(candidates: unknown[]) {
  const repo = await loadSampleRepo('approvals');
  const usage = new MemoryUsage();
  const provider = new ScriptedLlmProvider({
    extraction: (req: { user: string }) => {
      const last = req.user.trim().split('\n').at(-1) ?? '';
      void last;
      return { kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false };
    },
    candidates: () => ({ candidates: candidates.splice(0, 1).flat() }),
    clarification: { format: 'scenario', question: 'Can they still use the portal?', scenario: 'Approved yesterday, undone today.', yesMeans: 'A', noMeans: 'B', decisionTable: null },
    response: { interpretationId: null, confidence: 0, reason: 'unclear' },
  });
  const analyzer = new LlmAnalyzer({ provider, sessionId: 't', usage, limits: DEFAULT_CONFIG.llm });
  const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search, usage });
  for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
  return { engine, usage, provider };
}

describe('LLM analyzer behind the same validation gate', () => {
  it('drops a hallucinated code reference', async () => {
    const { engine } = await run([[], [candidate({ codeRefs: [{ evidenceId: 'E1', startLine: 400, endLine: 401, note: 'made up' }] })], []]);
    expect(engine.state.discrepancies).toHaveLength(0);
    expect(engine.state.metrics.rejectionReasons.lines_out_of_range).toBe(1);
  });

  it('drops a reference to a file that was never retrieved', async () => {
    const { engine } = await run([[], [candidate({ codeRefs: [{ evidenceId: 'E42', startLine: 1, endLine: 1, note: 'src/secret.ts' }] })], []]);
    expect(engine.state.metrics.rejectionReasons.unknown_evidence).toBe(1);
  });

  it('drops an invented quotation', async () => {
    const { engine } = await run([[], [candidate({ quotes: [{ segmentId: 's2', quote: 'and revoke their access' }] })], []]);
    expect(engine.state.metrics.rejectionReasons.quote_not_found).toBe(1);
  });

  it('rejects malformed model output without crashing (missing citations field)', async () => {
    const bad = candidate();
    delete (bad as Record<string, unknown>).codeRefs;
    const { engine } = await run([[], [bad], []]);
    expect(engine.state.discrepancies).toHaveLength(0);
  });

  it('accepts a valid candidate, records token usage per operation, and never sends the whole repo', async () => {
    const { engine, usage, provider } = await run([[], [], [candidate({ quotes: [{ segmentId: 's2', quote: 'set the status back to pending' }, { segmentId: 's3', quote: 'Sounds good' }] })]]);
    const d = engine.state.discrepancies[0]!;
    expect(d.category).toBe('false_alignment');
    expect(d.codeRefs[0]).toMatchObject({ filePath: 'src/applications/approve.ts', startLine: 22 });
    expect(usage.records.map((r) => r.operation)).toEqual(expect.arrayContaining(['candidates', 'clarification']));
    expect(usage.records.every((r) => r.inputTokens > 0)).toBe(true);
    const prompt = provider.calls.find((c) => c.operation === 'candidates')!.user;
    expect(prompt).toContain('<untrusted_repository_content>');
    expect(prompt).toContain('<untrusted_transcript>');
    // Only retrieved evidence is sent: every code block header is a pooled evidence id, within the symbol cap.
    const ids = [...prompt.matchAll(/^\[(E\d+)\] /gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(DEFAULT_CONFIG.retrieval.maxSymbols + 1);
    expect(ids.every((id) => engine.state.evidence.some((e) => e.id === id))).toBe(true);
  });

  it('stops model calls once the workspace budget is exhausted', async () => {
    const repo = await loadSampleRepo('approvals');
    const usage = new MemoryUsage();
    usage.record({ sessionId: 'x', model: 'm', operation: 'o', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 100 });
    const provider = new ScriptedLlmProvider({});
    const analyzer = new LlmAnalyzer({ provider, sessionId: 't', usage, limits: DEFAULT_CONFIG.llm });
    const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search, usage, config: { budget: { workspaceLimitUsd: 1 } } });
    const events = await engine.ingest({ speaker: 'Priya', text: 'Admins need to be able to undo an approval.' });
    expect(events.some((e) => e.type === 'budget_exhausted')).toBe(true);
    expect(engine.state.budgetExhausted).toBe(true);
    expect(provider.calls.filter((c) => c.operation === 'candidates')).toHaveLength(0);
  });
});

describe('clarification drafting with real-model output shapes', () => {
  it('accepts a reply that omits format (as gpt-5-mini did live) and infers it from the scenario', async () => {
    const provider = new ScriptedLlmProvider({
      clarification: { question: 'When a reviewer clicks Undo, should the member also lose portal access, or only the approval status change?'.repeat(2), scenario: 'Alice was approved at 10:00 and undone at 10:05.', yesMeans: 'B', noMeans: 'A', decisionTable: null },
    });
    const analyzer = new LlmAnalyzer({ provider, sessionId: 't', limits: DEFAULT_CONFIG.llm });
    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    const d = engine.state.discrepancies[0]!;
    const draft = await analyzer.draftClarification(d, 'private_check', engine.state, null);
    expect(draft.format).toBe('scenario');
    expect(draft.question).toMatch(/^When a reviewer clicks Undo/);
  });
});
