import { DEFAULT_CONFIG, HeuristicAnalyzer, LlmAnalyzer, SessionEngine, parseTranscript } from '@uc/core';
import { CASES } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { describe, expect, it } from 'vitest';
import { MemoryUsage, loadSampleRepo, runCase, surfaced } from '../src/runner';

const byId = (id: string) => CASES.find((c) => c.id === id)!;

describe('Slack context (heuristic analyzer)', () => {
  it('cites the Slack decision by link and keeps its text out of the state', async () => {
    const { engine } = await runCase(byId('s1-slack-decision-conflict'));
    const d = surfaced(engine).find((x) => x.category === 'direct_disagreement')!;
    expect(d.title).toMatch(/earlier Slack decision/);
    expect(d.slackRefs).toEqual([expect.objectContaining({ id: 'S1', channelLabel: '#approvals', authorName: 'Dana', private: false })]);
    expect(d.positions.find((p) => p.participantId === 'prior:slack:S1')?.text).toMatch(/^Slack #approvals \(Dana, /);
    const saved = JSON.stringify(engine.state);
    expect(saved).not.toContain('30 days');
    expect(engine.slackExcerpts()[0]!.text).toContain('30 days');
  });

  it('a DM decision is cited without channel or author names', async () => {
    const { engine } = await runCase(byId('s4-slack-dm-conflict'));
    const d = surfaced(engine).find((x) => x.slackRefs?.length)!;
    expect(d.slackRefs![0]).toMatchObject({ channelLabel: 'private conversation', authorName: null, private: true });
    const saved = JSON.stringify(engine.state);
    expect(saved).not.toContain('U0PARTNER');
    expect(saved).not.toContain('Dana');
    expect(saved).not.toContain('30 days');
  });

  it('Slack results stop counting once the window has passed', async () => {
    const repo = await loadSampleRepo('approvals');
    const { engine } = await SessionEngine.create({ sessionId: 'w' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
    engine.observeSlack([{ permalink: 'https://x.slack.com/p1', channelName: 'approvals', channelKind: 'public', authorName: 'Dana', ts: '1760000000.0001', text: 'Approved members must keep portal access for at least 30 days after approval.' }]);
    await engine.ingest({ speaker: 'Chris', text: 'Morning everyone.', timestamp: 0 });
    await engine.ingest({ speaker: 'Priya', text: 'When an admin undoes an approval, the member should lose portal access immediately.', timestamp: 16 * 60_000 });
    expect(engine.state.discrepancies.filter((d) => d.slackRefs?.length)).toHaveLength(0);
  });
});

describe('Slack context (LLM analyzer behind the validation gate)', () => {
  const SLACK = 'Decision: approved members must keep portal access for at least 30 days after approval.';
  const TRANSCRIPT = `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`;

  function candidate(slackRefs: { refId: string; note: string }[]) {
    return {
      key: 'disagree:access',
      category: 'direct_disagreement',
      title: 'Conflicts with what Slack decided about access',
      description: 'The request contradicts an earlier decision in Slack.',
      quotes: [{ segmentId: 's1', quote: 'lose portal access immediately' }],
      codeRefs: [],
      slackRefs,
      interpretations: [
        { id: 'A', label: 'Keep access 30 days', behavior: 'Undoing keeps access for the agreed period.' },
        { id: 'B', label: 'Revoke immediately', behavior: 'Undoing revokes access right away.' },
      ],
      consequence: 'permission',
      impactExplanation: 'Only one behavior can ship.',
      confidence: 0.8,
      relevantParticipantIds: ['p1', 'prior:slack:S1'],
      statedPositions: [
        { participantId: 'prior:slack:S1', interpretationId: 'A', segmentId: 'slack:S1', explicit: true },
        { participantId: 'p1', interpretationId: 'B', segmentId: 's1', explicit: true },
      ],
    };
  }

  async function run(slackRefs: { refId: string; note: string }[]) {
    const repo = await loadSampleRepo('approvals');
    const usage = new MemoryUsage();
    let sent = 0;
    const provider = new ScriptedLlmProvider({
      extraction: { kinds: ['requirement'], polarity: 'negative', reuseTarget: null, reversal: true },
      candidates: (req: { user: string }) => ({ candidates: req.user.includes('<untrusted_slack_messages>') && sent++ === 0 ? [candidate(slackRefs)] : [] }),
      clarification: { format: 'verbal', question: 'Which should happen?', scenario: null, yesMeans: 'A', noMeans: 'B', decisionTable: null },
      response: { interpretationId: null, confidence: 0, reason: 'unclear' },
    });
    const analyzer = new LlmAnalyzer({ provider, sessionId: 't', usage, limits: DEFAULT_CONFIG.llm });
    const { engine } = await SessionEngine.create({ sessionId: 't' }, { analyzer, search: repo.search, usage });
    engine.observeSlack([{ permalink: 'https://x.slack.com/archives/C1/p1', channelName: 'approvals', channelKind: 'public', authorName: 'Dana', ts: '1760000000.0001', text: SLACK }]);
    for (const s of parseTranscript(TRANSCRIPT)) await engine.ingest(s);
    return { engine, provider };
  }

  it('sends Slack text fenced as untrusted and accepts a citation of a message it was given', async () => {
    const { engine, provider } = await run([{ refId: 'S1', note: 'earlier decision' }]);
    const prompt = provider.calls.find((c) => c.operation === 'candidates' && c.user.includes('<untrusted_slack_messages>'))!.user;
    expect(prompt).toContain('[S1] participantId=prior:slack:S1');
    const d = engine.state.discrepancies.find((x) => x.slackRefs?.length)!;
    expect(d.slackRefs![0]).toMatchObject({ id: 'S1', note: 'earlier decision' });
    // The Slack side's stated position shows the pointer, not the message.
    expect(d.positions.find((p) => p.participantId === 'prior:slack:S1')?.text).toMatch(/^Slack #approvals/);
    expect(JSON.stringify(engine.state)).not.toContain('30 days after approval');
  });

  it('drops a candidate citing a Slack message it was never given', async () => {
    const { engine } = await run([{ refId: 'S9', note: 'made up' }]);
    expect(engine.state.discrepancies.filter((x) => x.slackRefs?.length)).toHaveLength(0);
    expect(engine.state.metrics.rejectionReasons.unknown_slack_message).toBe(1);
  });
});
