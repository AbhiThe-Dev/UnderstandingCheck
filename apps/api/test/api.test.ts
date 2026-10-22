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
    expect(usage.body.bySession.find((s: any) => s.id === id)).toMatchObject({ suggestions: 1, confirmedMisunderstandings: 1, costUsd: 0 });
  });

  it('validates segments and rejects unknown sessions', async () => {
    expect((await call('POST', '/api/sessions/00000000-0000-0000-0000-000000000000/segments', { speaker: 'A', text: 'hi' })).status).toBe(404);
    const { body } = await call('POST', '/api/demo');
    expect((await call('POST', `/api/sessions/${body.id}/segments`, { speaker: '', text: '' })).status).toBe(400);
  });

  it('processes an uploaded transcript and deletes the session on request', async () => {
    const { body } = await call('POST', '/api/demo');
    const r = await call('POST', `/api/sessions/${body.id}/transcript`, { text: SEEDED_DEMO.transcript });
    expect(r.body.segments).toHaveLength(4);
    expect((await call('DELETE', `/api/sessions/${body.id}`)).status).toBe(200);
    expect((await call('GET', `/api/sessions/${body.id}`)).status).toBe(404);
  });
});
