import { DEFAULT_CONFIG, HeuristicAnalyzer, LlmAnalyzer, SessionEngine, parseTranscript, sessionMetrics } from '@uc/core';
import { SEEDED_DEMO, SEEDED_DEMO_RESOLUTION } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { describe, expect, it } from 'vitest';
import { loadSampleRepo, participantId, runCase, surfaced } from '../src/runner';

describe('idempotent live ingestion', () => {
  it('ignores a segment re-sent with the same externalId (e.g. a transcription retry)', async () => {
    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create({ sessionId: 'idem' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
    const seg = { speaker: 'Priya', text: 'Admins need to be able to undo an approval.', externalId: 'tx-1' };
    await engine.ingest(seg);
    const again = await engine.ingest(seg);
    expect(again).toEqual([{ type: 'duplicate_segment', externalId: 'tx-1' }]);
    expect(engine.segments).toHaveLength(1);
    expect(engine.state.metrics.duplicateSegments).toBe(1);
    await engine.ingest({ ...seg, externalId: 'tx-2' });
    expect(engine.segments).toHaveLength(2);
  });
});

describe('meeting metrics', () => {
  it('reports quality, friction and latency for the seeded meeting', async () => {
    const r = await runCase(SEEDED_DEMO);
    const d = surfaced(r.engine)[0]!;
    const priya = participantId(r.engine, 'Priya');
    for (const c of r.engine.state.clarifications.filter((x) => x.purpose === 'private_check')) {
      await r.engine.respond(c.id, c.targetedParticipantId!, { interpretationId: c.targetedParticipantId === priya ? 'B' : 'A', text: '' });
    }
    for (const seg of parseTranscript(SEEDED_DEMO_RESOLUTION)) await r.engine.ingest(seg);
    await r.engine.act(d.id, 'mark_useful');

    const m = sessionMetrics(r.engine.state, r.engine.segments);
    expect(m).toMatchObject({
      segments: 6,
      suggestions: 1,
      revealedDifferenceRate: 1,
      resolvedInMeetingRate: 1,
      usefulRate: 1,
      rated: 1,
      dismissalRate: 0,
    });
    expect(m.meetingDurationMs).toBe(20_000); // 6 segments, default 4 s spacing
    expect(m.medianTimeToResolveMs).toBeGreaterThan(0);
    expect(m.latencyMs!.p95).toBeGreaterThanOrEqual(m.latencyMs!.p50);
    expect(m.suggestionsPerHour).toBeCloseTo(180);
  });
});

describe('soak: a long meeting stays quiet, bounded and fast', () => {
  it('processes 400 turns with only the concerns that matter', async () => {
    const chatter = [
      'Dev (Developer): I pushed the lint fixes this morning.',
      'Priya (PO): Can someone update the sprint board?',
      'Alex (QA): The staging deploy looks green.',
      'Dev (Developer): I will pair with Alex on the flaky test after lunch.',
      'Priya (PO): Let us keep the retro to fifteen minutes.',
      'Alex (QA): Sounds good to me.',
      'Dev (Developer): The docs site needs a new screenshot.',
      'Priya (PO): Thanks everyone, good progress.',
    ];
    const lines: string[] = [];
    for (let i = 0; i < 48; i++) lines.push(chatter[i % chatter.length]!);
    lines.push(...SEEDED_DEMO.transcript.split('\n'));
    for (let i = 0; i < 300; i++) lines.push(chatter[(i * 3) % chatter.length]!);
    // The same proposal and agreement coming back much later must not create a second card.
    lines.push("Sam (Developer): So again, I'll just set the status back to pending.", 'Priya (PO): Sounds good.');
    for (let i = 0; i < 46; i++) lines.push(chatter[(i * 5) % chatter.length]!);

    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create(
      { sessionId: 'soak', featureDescription: SEEDED_DEMO.featureDescription },
      { analyzer: new HeuristicAnalyzer(), search: repo.search },
    );
    for (const seg of parseTranscript(lines.join('\n'))) await engine.ingest(seg);

    const live = surfaced(engine);
    expect(engine.segments).toHaveLength(400);
    expect(live.map((d) => d.category)).toEqual(['false_alignment']);
    expect(new Set(engine.state.discrepancies.map((d) => d.key)).size).toBe(engine.state.discrepancies.length);
    expect(engine.state.metrics.duplicatesSuppressed).toBeGreaterThan(0);
    // Routine chatter is cheap: most turns either skip analysis or hit the retrieval cache.
    expect(engine.state.metrics.retrievalCacheHits).toBeGreaterThan(engine.state.metrics.retrievals / 2);
    const m = sessionMetrics(engine.state, engine.segments);
    expect(m.latencyMs!.p95).toBeLessThan(25); // heuristic analyzer + in-memory index
  });
});
const DEMO = `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.`;

describe('record, then analyse (live capture in the engine)', () => {
  it('record stores a turn without analysing it; analyzePending catches up in order', async () => {
    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create({ sessionId: 'r' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
    for (const s of parseTranscript(DEMO)) engine.record(s);
    expect(engine.segments).toHaveLength(3);
    expect(engine.state.claims).toHaveLength(0);
    expect(engine.pendingTurns).toBe(3);
    await engine.analyzePending();
    expect(engine.pendingTurns).toBe(0);
    expect(engine.state.claims.map((c) => c.segmentId)).toEqual(['s1', 's2', 's3']);
    // Same finding as ingesting turn by turn.
    expect(engine.state.discrepancies.some((d) => d.category === 'false_alignment')).toBe(true);
  });

  it('gives the model only the newest turns when it has fallen behind', async () => {
    const repo = await loadSampleRepo('approvals');
    const provider = new ScriptedLlmProvider({
      extraction: { kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false },
      candidates: () => ({ candidates: [] }),
      clarification: { question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null },
      response: { interpretationId: null, confidence: 0, reason: 'unclear' },
    });
    const analyzer = new LlmAnalyzer({ provider, sessionId: 'r', limits: DEFAULT_CONFIG.llm });
    const { engine } = await SessionEngine.create({ sessionId: 'r' }, { analyzer, search: repo.search });
    for (const s of parseTranscript(DEMO)) engine.record(s);
    await engine.analyzePending();
    // fullTurns = 2: s1 had two newer turns waiting (stale, rules only); s2 and s3 got the model.
    const modelTurns = provider.calls.filter((c) => c.operation === 'candidates').map((c) => c.user.match(/Newest segment id: (s\d+)/)?.[1]);
    expect(modelTurns).not.toContain('s1');
    expect(modelTurns).toContain('s3');
    expect(engine.state.metrics.staleTurns).toBe(1);
  });

  it('ingest behaves as before: record and analyse in one step', async () => {
    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create({ sessionId: 'r' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
    for (const s of parseTranscript(DEMO)) await engine.ingest(s);
    expect(engine.pendingTurns).toBe(0);
    expect(engine.state.analyzedThrough).toBe(2);
  });
});
