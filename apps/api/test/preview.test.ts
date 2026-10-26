import { parseTranscript, type LlmProvider, type LlmRequest } from '@uc/core';
import { PREVIEW_DEMO } from '@uc/fixtures';
import { ScriptedLlmProvider } from '@uc/providers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Services } from '../src/services';

/** A scripted model whose preview takes a while, so requests can overlap with it. */
class SlowPreview implements LlmProvider {
  readonly name = 'slow-scripted';
  readonly ops: string[] = [];
  release: (() => void) | null = null;
  private inner = new ScriptedLlmProvider({
    extraction: () => ({ kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false }),
    candidates: () => ({ candidates: [] }),
    clarification: () => ({ format: 'verbal', question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null }),
    response: () => ({ interpretationId: null, confidence: 0, reason: 'unclear' }),
    preview: (req: LlmRequest<unknown>) => {
      const m = req.user.match(/\[(E\d+)\] src\/auth\/sessions\.ts:(\d+)-\d+ getSession /)!;
      const line = Number(m[2]) + 5;
      return {
        proposedChange: 'Remove premium access when a customer downgrades.',
        summary: 'Sessions keep cached entitlements until they expire.',
        currentBehavior: [{ text: 'getSession reloads entitlements only after the token expires.', refs: [{ evidenceId: m[1], startLine: line, endLine: line }] }],
        questions: [{ text: 'Immediately, or when the session expires?', why: 'Sessions cache entitlements.', status: 'open', answer: null }],
        clarification: 'Should premium access end immediately after a downgrade?',
      };
    },
  });
  async complete<T>(req: LlmRequest<T>) {
    this.ops.push(req.operation);
    if (req.operation === 'preview') await new Promise<void>((r) => (this.release = r));
    return this.inner.complete(req);
  }
}

let app: ReturnType<typeof createApp>;
let services: Services;
let model: SlowPreview;

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

async function downgradeMeeting() {
  const repo = await services.ensureSampleIndexed('subscriptions');
  const id = (await call('POST', '/api/sessions', { title: 'Downgrades', repositoryId: repo.id, consentConfirmed: true })).body.id as string;
  let last: any;
  for (const seg of parseTranscript(PREVIEW_DEMO.transcript)) last = (await call('POST', `/api/sessions/${id}/segments`, seg)).body;
  return { id, repoId: repo.id, last };
}

beforeAll(async () => {
  model = new SlowPreview();
  services = await Services.create({ analyzer: 'llm', llm: model, host: null, recall: null, transcriber: null, slack: null });
  app = createApp(services);
});

describe('implementation preview API', () => {
  it('hints for free, generates once outside the queue, joins repeat requests, then reuses the answer', async () => {
    const { id, last } = await downgradeMeeting();
    const hint = last.state.previews[0];
    expect(hint).toMatchObject({ status: 'suggested', trigger: 'auto' });
    expect(model.ops).not.toContain('preview');

    const first = await call('POST', `/api/sessions/${id}/previews`, { previewId: hint.id });
    expect(first.status).toBe(202);
    expect(first.body.state.previews[0].status).toBe('generating');
    await waitFor(() => model.release !== null, 'the preview call');

    // While the model works: the meeting keeps flowing, and a second click joins the running analysis.
    const seg = await call('POST', `/api/sessions/${id}/segments`, { speaker: 'Leo', text: 'I can ship it on Thursday.' });
    expect(seg.status).toBe(200);
    const again = await call('POST', `/api/sessions/${id}/previews`, { previewId: hint.id });
    expect(again.body.previewId).toBe(hint.id);

    model.release!();
    await waitFor(async () => (await services.snapshot(id)).state.previews![0]!.status === 'ready', 'ready preview');
    expect(model.ops.filter((o) => o === 'preview')).toHaveLength(1);
    const ready = (await services.snapshot(id)).state.previews![0]!;
    expect(ready.content!.currentBehavior[0]!.refs[0]).toMatchObject({ filePath: 'src/auth/sessions.ts' });
    expect(ready.usage.calls).toBe(1);

    // Nothing relevant changed: answered from the stored preview, no new call.
    const cached = await call('POST', `/api/sessions/${id}/previews`, { previewId: hint.id });
    expect(cached.body.state.previews[0]).toMatchObject({ status: 'ready', cacheHits: 1 });
    expect(model.ops.filter((o) => o === 'preview')).toHaveLength(1);

    const usage = (await call('GET', '/api/usage')).body;
    expect(usage.byOperation.find((o: any) => o.operation === 'preview')).toMatchObject({ calls: 1 });

    const dismissed = await call('POST', `/api/sessions/${id}/previews/${hint.id}/dismiss`);
    expect(dismissed.body.state.previews[0].status).toBe('dismissed');
  });

  it('rejects unknown previews, ended sessions and repositories whose access was revoked', async () => {
    const { id, repoId } = await downgradeMeeting();
    expect((await call('POST', `/api/sessions/${id}/previews`, { previewId: 'ip404' })).status).toBe(404);

    await services.store.updateRepository(repoId, { indexingStatus: 'revoked' });
    const revoked = await call('POST', `/api/sessions/${id}/previews`, {});
    expect(revoked.status).toBe(409);
    expect(revoked.body.error).toMatch(/no longer accessible/);
    await services.store.updateRepository(repoId, { indexingStatus: 'ready' });

    await call('POST', `/api/sessions/${id}/end`);
    expect((await call('POST', `/api/sessions/${id}/previews`, {})).status).toBe(409);
  });
});
