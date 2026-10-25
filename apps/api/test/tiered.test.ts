import type { LlmProvider, LlmRequest } from '@uc/core';
import { ScriptedLlmProvider } from '@uc/providers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Services } from '../src/services';

/** A scripted model whose screen takes a while, to show ingestion does not wait for it. */
class SlowScreen implements LlmProvider {
  readonly name = 'slow-scripted';
  readonly ops: string[] = [];
  private inner = new ScriptedLlmProvider({
    screen: () => ({ flags: [] }),
    candidates: () => ({ candidates: [] }),
    clarification: () => ({ format: 'verbal', question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null }),
    response: () => ({ interpretationId: null, confidence: 0, reason: 'unclear' }),
  });
  async complete<T>(req: LlmRequest<T>) {
    this.ops.push(req.operation);
    if (req.operation === 'screen') await new Promise((r) => setTimeout(r, 300));
    return this.inner.complete(req);
  }
}

let app: ReturnType<typeof createApp>;
let services: Services;
let model: SlowScreen;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

async function waitFor(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  model = new SlowScreen();
  services = await Services.create({ analyzer: 'tiered', llm: model, host: null, recall: null, transcriber: null, slack: null });
  app = createApp(services);
});

describe('tiered analyzer in the API', () => {
  it('reports tiered mode and screens in the background without slowing ingestion', async () => {
    expect(services.analyzerMode).toBe('tiered');
    const repo = await services.ensureSampleIndexed('approvals');
    const id = (await call('POST', '/api/sessions', { title: 'Undo', repositoryId: repo.id, consentConfirmed: true })).body.id;
    const seg = (speaker: string, text: string, timestamp: number) => call('POST', `/api/sessions/${id}/segments`, { speaker, text, timestamp });

    await seg('Priya', 'Admins need to be able to undo an approval.', 0);
    const started = Date.now();
    await seg('Sam', 'I will add a button that resets the status.', 61_000); // a minute later: screen becomes due
    expect(Date.now() - started).toBeLessThan(250);
    expect(model.ops).not.toContain('extraction');
    await waitFor(async () => ((await services.snapshot(id)).state.metrics.screens ?? 0) === 1, 'background screen');
    expect(model.ops.filter((o) => o === 'screen')).toHaveLength(1);

    // Turns after the last screen are screened when the meeting ends.
    await seg('Priya', 'It should also email the member.', 62_000);
    const ended = (await call('POST', `/api/sessions/${id}/end`)).body;
    expect(ended.state.metrics.screens).toBe(2);
    expect(ended.state.ended).toBe(true);
  });
});
