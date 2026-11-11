import type { LlmProvider, LlmRequest } from '@uc/core';
import { ScriptedLlmProvider } from '@uc/providers';
import { beforeAll, describe, expect, it } from 'vitest';
import { Services } from '../src/services';

/** A scripted model whose candidate analysis is slow, like gpt-5 on a busy call. */
class SlowModel implements LlmProvider {
  readonly name = 'slow-scripted';
  readonly ops: { operation: string; segment: string | null }[] = [];
  private inner = new ScriptedLlmProvider({
    extraction: () => ({ kinds: ['statement'], polarity: 'neutral', reuseTarget: null, reversal: false }),
    candidates: () => ({ candidates: [] }),
    clarification: () => ({ question: 'Which?', scenario: null, yesMeans: null, noMeans: null, decisionTable: null }),
    response: () => ({ interpretationId: null, confidence: 0, reason: 'unclear' }),
  });
  async complete<T>(req: LlmRequest<T>) {
    this.ops.push({ operation: req.operation, segment: req.user.match(/Newest segment id: (s\d+)/)?.[1] ?? null });
    if (req.operation === 'candidates') await new Promise((r) => setTimeout(r, 400));
    return this.inner.complete(req);
  }
}

let services: Services;
let model: SlowModel;

async function waitFor(fn: () => Promise<boolean> | boolean, what: string, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  model = new SlowModel();
  services = await Services.create({ analyzer: 'llm', llm: model, host: null, recall: null, transcriber: null, slack: null });
});

describe('live capture: transcript first, analysis in the background', () => {
  it('shows each turn at once while the model is busy, and skips the model for turns it fell behind on', async () => {
    const repo = await services.ensureSampleIndexed('approvals');
    const row = await services.createSession({ title: 'Live', repositoryId: repo.id, consentConfirmed: true });
    const turns = [
      ['Priya', 'Admins need to be able to undo an approval.'],
      ['Sam', "I'll just set the status back to pending."],
      ['Priya', 'And it should email the applicant.'],
      ['Sam', 'We could also log who undid it.'],
      ['Priya', 'Sounds good.'],
    ];
    const started = Date.now();
    for (const [speaker, text] of turns) await services.record(row.id, (engine) => engine.record({ speaker: speaker!, text: text! }));
    // All five turns are in the transcript well before even one slow analysis (400 ms) could finish.
    expect(Date.now() - started).toBeLessThan(300);
    expect((await services.snapshot(row.id)).segments).toHaveLength(5);

    await waitFor(async () => (await services.snapshot(row.id)).state.analyzedThrough === 4, 'analysis to catch up');
    const snap = await services.snapshot(row.id);
    // The first turn started analysing alone; turns that piled up behind it were stale except the newest ones.
    const analysedByModel = new Set(model.ops.filter((o) => o.operation === 'candidates').map((o) => o.segment));
    expect(analysedByModel.has('s5')).toBe(true);
    expect(snap.state.metrics.staleTurns).toBeGreaterThan(0);
    expect(analysedByModel.size + (snap.state.metrics.staleTurns ?? 0)).toBeLessThanOrEqual(5);
    // Every turn still became context (a claim), whether the model or the rules analysed it.
    expect(snap.state.claims.filter((c) => !c.participantId.startsWith('prior:'))).toHaveLength(5);
  });

  it('a duplicate delivery is recorded once', async () => {
    const row = await services.createSession({ title: 'Dupes', repositoryId: null, consentConfirmed: true });
    const turn = { speaker: 'Priya', text: 'Admins need to undo approvals.', externalId: 'recall:1' };
    await services.record(row.id, (engine) => engine.record(turn));
    const again = await services.record(row.id, (engine) => engine.record(turn));
    expect(again.events).toEqual([{ type: 'duplicate_segment', externalId: 'recall:1' }]);
    expect((await services.snapshot(row.id)).segments).toHaveLength(1);
  });

  it('ending the meeting analyses turns that are still waiting', async () => {
    const row = await services.createSession({ title: 'End', repositoryId: null, consentConfirmed: true });
    for (const t of ['We need a CSV export.', 'It should include totals.', 'Sounds good.']) {
      await services.record(row.id, (engine) => engine.record({ speaker: 'Priya', text: t }));
    }
    const { snapshot } = await services.endSession(row.id);
    expect(snapshot.state.analyzedThrough).toBe(2);
    expect(snapshot.state.ended).toBe(true);
  });

  it('sessions saved before this change still analyse correctly after a restart', async () => {
    const row = await services.createSession({ title: 'Old', repositoryId: null, consentConfirmed: true });
    await services.run(row.id, (engine) => engine.ingest({ speaker: 'Priya', text: 'We need a CSV export.' }));
    // Simulate an old saved state: no analysedThrough field.
    await services.run(row.id, async (engine) => {
      delete (engine.state as { analyzedThrough?: number }).analyzedThrough;
      return [];
    });
    services.forget(row.id);
    await services.record(row.id, (engine) => engine.record({ speaker: 'Sam', text: 'It should include totals.' }));
    await waitFor(async () => (await services.snapshot(row.id)).state.analyzedThrough === 1, 'the new turn to be analysed');
    const ops = model.ops.filter((o) => o.operation === 'candidates' && o.segment === 's1');
    expect(ops.length).toBeLessThanOrEqual(1); // s1 was analysed by ingest, never again
  });
});
