import { parseTranscript, type LlmProvider, type LlmRequest } from '@uc/core';
import { DECISION_DEMO } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Services } from '../src/services';

/** A scripted model whose decision evaluation waits until released, so turns can arrive meanwhile. */
class SlowDecision implements LlmProvider {
  readonly name = 'slow-scripted';
  readonly ops: string[] = [];
  release: (() => void) | null = null;
  hold = true;
  private inner = new ScriptedLlmProvider({
    extraction: () => ({ kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false }),
    candidates: () => ({ candidates: [] }),
    clarification: () => ({ format: 'verbal', question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null }),
    response: () => ({ interpretationId: null, confidence: 0, reason: 'unclear' }),
    decision: (req: LlmRequest<unknown>) => {
      const m = req.user.match(/\[(E\d+)\] docs\/entitlements\.md:(\d+)-\d+ Entitlements › Downgrades take effect within one hour /);
      if (!m) return { isDecision: true, decision: 'A decision.', verdict: 'Nothing consequential.', findings: [] };
      const line = Number(m[2]) + 2;
      return {
        isDecision: true,
        decision: 'Cache entitlements in Redis for 24 hours.',
        verdict: null,
        findings: [
          {
            kind: 'risk',
            dimension: 'compatibility',
            severity: 'high',
            title: 'A 24-hour cache breaks the one-hour downgrade promise',
            impact: 'Downgraded customers keep premium for up to a day.',
            refs: [{ evidenceId: m[1], startLine: line, endLine: line + 1, note: '' }],
            slackRefs: [],
            alternative: null,
            ask: 'Should the TTL be an hour, or cleared on downgrade?',
            confidence: 0.9,
          },
        ],
      };
    },
  });
  async complete<T>(req: LlmRequest<T>) {
    this.ops.push(req.operation);
    if (req.operation === 'decision' && this.hold) await new Promise<void>((r) => (this.release = r));
    return this.inner.complete(req);
  }
}

let app: ReturnType<typeof createApp>;
let services: Services;
let model: SlowDecision;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

async function waitFor(fn: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function meeting(transcript: string) {
  const repo = await services.ensureSampleIndexed('subscriptions');
  const id = (await call('POST', '/api/sessions', { title: 'Decisions', repositoryId: repo.id, consentConfirmed: true })).body.id as string;
  let last: any;
  for (const seg of parseTranscript(transcript)) last = (await call('POST', `/api/sessions/${id}/segments`, seg)).body;
  return { id, last };
}

const decisions = async (id: string) => (await call('GET', `/api/sessions/${id}`)).body.state.decisions as any[];

beforeAll(async () => {
  model = new SlowDecision();
  services = await Services.create({ analyzer: 'llm', llm: model, host: null, recall: null, transcriber: null, slack: null });
  app = createApp(services);
});

describe('technical decision API', () => {
  it('evaluates an adopted decision in the background while turns keep flowing, then shows one finding', async () => {
    const { id, last } = await meeting(DECISION_DEMO.transcript);
    // "Sounds good" on the second turn adopted it.
    expect(last.state.decisions[0]).toMatchObject({ adoption: 'agreed', status: expect.stringMatching(/^(adopted|evaluating)$/) });

    // The model is still thinking; the meeting is not blocked.
    await waitFor(() => model.release !== null, 'the evaluation to start');
    const during = await call('POST', `/api/sessions/${id}/segments`, { speaker: 'Maya', text: 'Next up is the pricing page.' });
    expect(during.status).toBe(200);
    expect(during.body.state.decisions[0].status).toBe('evaluating');

    model.release!();
    await waitFor(async () => (await decisions(id))[0].status === 'evaluated', 'the evaluation to finish');
    const [d] = await decisions(id);
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0]).toMatchObject({ visibility: 'live', severity: 'high', refs: [expect.objectContaining({ filePath: 'docs/entitlements.md' })] });
    expect(model.ops.filter((o) => o === 'decision')).toHaveLength(1);

    const f = d.findings[0];
    const rated = await call('POST', `/api/sessions/${id}/decisions/${d.id}/findings/${f.id}/actions`, { action: 'mark_useful' });
    expect(rated.body.state.decisions[0].findings[0].feedback).toBe('useful');
    const dismissed = await call('POST', `/api/sessions/${id}/decisions/${d.id}/findings/${f.id}/actions`, { action: 'dismiss' });
    expect(dismissed.body.state.decisions[0].findings[0].visibility).toBe('hidden');
    expect((await call('POST', `/api/sessions/${id}/decisions/nope/dismiss`)).status).toBe(404);
  });

  it('finds callers through the database index, and evaluates open proposals when the meeting ends', async () => {
    model.hold = false;
    const { id } = await meeting(`Leo (Developer): Let's replace getSession with a stateless JWT check instead of the session map.`);
    expect((await decisions(id))[0].status).toBe('proposed');
    const before = model.ops.filter((o) => o === 'decision').length;

    const ended = await call('POST', `/api/sessions/${id}/end`);
    expect(ended.status).toBe(200);
    const [d] = ended.body.state.decisions;
    expect(d).toMatchObject({ status: 'evaluated', adoption: 'meeting_end' });
    // Ended meetings only note findings; nothing pops up after the call.
    expect(d.findings.map((f: any) => [f.source, f.visibility, f.refs.map((r: any) => r.symbolName)])).toEqual([['rules', 'noted', ['getSession', 'hasPremiumAccess']]]);
    expect(model.ops.filter((o) => o === 'decision').length).toBe(before + 1);
  });
});
