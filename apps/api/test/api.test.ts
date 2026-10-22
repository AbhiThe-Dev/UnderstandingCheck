import { parseTranscript } from '@uc/core';
import { SEEDED_DEMO, SEEDED_DEMO_RESOLUTION } from '@uc/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Services } from '../src/services';

let app: ReturnType<typeof createApp>;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  app = createApp(await Services.create({ analyzer: 'heuristic' }));
});

describe('API end to end (heuristic analyzer, in-memory Postgres)', () => {
  it('requires explicit transcription consent', async () => {
    const r = await call('POST', '/api/sessions', { title: 'x', repositoryId: null, consentConfirmed: false });
    expect(r.status).toBe(400);
  });

  it('runs the seeded scenario through live ingestion, private checks and resolution', async () => {
    const created = await call('POST', '/api/demo');
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    let last: Record<string, any> = {};
    for (const seg of parseTranscript(SEEDED_DEMO.transcript)) {
      const r = await call('POST', `/api/sessions/${id}/segments`, seg);
      expect(r.status).toBe(200);
      last = r.body;
    }
    const d = last.state.discrepancies.find((x: any) => x.visibility === 'live');
    expect(d).toMatchObject({ category: 'false_alignment', status: 'suggested' });
    expect(d.codeRefs[0]).toMatchObject({ filePath: 'src/applications/approve.ts', startLine: 22 });

    const checks = last.state.clarifications.filter((c: any) => c.discrepancyId === d.id && c.purpose === 'private_check');
    const priya = last.state.participants.find((p: any) => p.displayName === 'Priya').id;
    for (const c of checks) {
      const r = await call('POST', `/api/sessions/${id}/clarifications/${c.id}/responses`, {
        participantId: c.targetedParticipantId,
        interpretationId: c.targetedParticipantId === priya ? 'B' : 'A',
      });
      expect(r.status).toBe(200);
      last = r.body;
    }
    expect(last.state.discrepancies.find((x: any) => x.id === d.id).status).toBe('different_expectations_confirmed');

    for (const seg of parseTranscript(SEEDED_DEMO_RESOLUTION)) last = (await call('POST', `/api/sessions/${id}/segments`, seg)).body;
    expect(last.state.discrepancies.find((x: any) => x.id === d.id).status).toBe('resolved');

    const ended = await call('POST', `/api/sessions/${id}/end`);
    expect(ended.body.status).toBe('ended');
    const summary = await call('GET', `/api/sessions/${id}/summary`);
    expect(summary.body.markdown).toContain('Undoing the approval also revokes the access');

    const more = await call('POST', `/api/sessions/${id}/segments`, { speaker: 'Sam', text: 'one more thing' });
    expect(more.status).toBe(409);

    const usage = await call('GET', '/api/usage');
    expect(usage.body.bySession.find((s: any) => s.id === id)).toMatchObject({ metrics: { suggestions: 1, resolvedInMeetingRate: 1 }, confirmedMisunderstandings: 1, costUsd: 0 });
  });

  it('validates segments and rejects unknown sessions', async () => {
    expect((await call('POST', '/api/sessions/00000000-0000-0000-0000-000000000000/segments', { speaker: 'A', text: 'hi' })).status).toBe(404);
    const { body } = await call('POST', '/api/demo');
    expect((await call('POST', `/api/sessions/${body.id}/segments`, { speaker: '', text: '' })).status).toBe(400);
  });

  it('runs a server-side replay that feeds the live pipeline, with controls', async () => {
    const { body } = await call('POST', '/api/demo');
    const id = body.id as string;
    const started = await call('POST', `/api/sessions/${id}/replay`, { text: SEEDED_DEMO.transcript, speed: 50 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'playing', total: 4 });
    expect((await call('POST', `/api/sessions/${id}/replay`, { text: SEEDED_DEMO.transcript })).status).toBe(409);

    const deadline = Date.now() + 5000;
    let view: Record<string, any> = {};
    while (Date.now() < deadline) {
      view = (await call('GET', `/api/sessions/${id}`)).body;
      if (view.replay?.status === 'finished') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(view.replay).toMatchObject({ status: 'finished', delivered: 4, total: 4 });
    expect(view.segments).toHaveLength(4);
    expect(view.state.discrepancies.some((d: any) => d.category === 'false_alignment' && d.visibility === 'live')).toBe(true);
    expect(view.metrics.suggestions).toBe(1);

    // Replaying the identical finished transcript would duplicate the meeting.
    expect((await call('POST', `/api/sessions/${id}/replay`, { text: SEEDED_DEMO.transcript, speed: 50 })).status).toBe(409);

    // A follow-up replay continues the meeting clock instead of restarting at 00:00.
    await call('POST', `/api/sessions/${id}/replay`, { text: SEEDED_DEMO_RESOLUTION, speed: 1, paused: true });
    const stepped = await call('POST', `/api/sessions/${id}/replay/control`, { action: 'step', speed: 2 });
    expect(stepped.body).toMatchObject({ status: 'paused', speed: 2 });
    await new Promise((r) => setTimeout(r, 300));
    view = (await call('GET', `/api/sessions/${id}`)).body;
    expect(view.segments).toHaveLength(5);
    expect(view.segments[4].timestamp).toBeGreaterThan(view.segments[3].timestamp);
    expect((await call('POST', `/api/sessions/${id}/replay/control`, { action: 'stop' })).body.status).toBe('stopped');
    expect((await call('POST', `/api/sessions/${id}/replay/control`, {})).status).toBe(400);
  });

  it('accepts retried live segments only once', async () => {
    const { body } = await call('POST', '/api/demo');
    const seg = { speaker: 'Priya', text: 'Admins need to be able to undo an approval.', externalId: 'zoom-123' };
    await call('POST', `/api/sessions/${body.id}/segments`, seg);
    const retry = await call('POST', `/api/sessions/${body.id}/segments`, seg);
    expect(retry.body.events).toEqual([{ type: 'duplicate_segment', externalId: 'zoom-123' }]);
    expect(retry.body.segments).toHaveLength(1);
  });

  it('processes an uploaded transcript and deletes the session on request', async () => {
    const { body } = await call('POST', '/api/demo');
    const r = await call('POST', `/api/sessions/${body.id}/transcript`, { text: SEEDED_DEMO.transcript });
    expect(r.body.segments).toHaveLength(4);
    expect((await call('DELETE', `/api/sessions/${body.id}`)).status).toBe(200);
    expect((await call('GET', `/api/sessions/${body.id}`)).status).toBe(404);
  });
});
