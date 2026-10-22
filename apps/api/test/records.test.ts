import { parseTranscript } from '@uc/core';
import { SEEDED_DEMO, SEEDED_DEMO_RESOLUTION } from '@uc/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Services } from '../src/services';

let app: ReturnType<typeof createApp>;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* markdown export */
  }
  return { status: res.status, body: parsed, headers: res.headers };
};

async function meeting(transcript: string) {
  const { body } = await call('POST', '/api/demo');
  let last: any;
  for (const seg of parseTranscript(transcript)) last = (await call('POST', `/api/sessions/${body.id}/segments`, seg)).body;
  return { id: body.id as string, view: last };
}

beforeAll(async () => {
  app = createApp(await Services.create({ analyzer: 'heuristic' }));
});

describe('versioned requirement records across meetings', () => {
  let accessRecordId = '';

  it('meeting 1: confirmed decisions become records when the session ends, exactly once', async () => {
    const { id, view } = await meeting(SEEDED_DEMO.transcript);
    const priya = view.state.participants.find((p: any) => p.displayName === 'Priya').id;
    for (const c of view.state.clarifications.filter((x: any) => x.purpose === 'private_check')) {
      await call('POST', `/api/sessions/${id}/clarifications/${c.id}/responses`, { participantId: c.targetedParticipantId, interpretationId: c.targetedParticipantId === priya ? 'B' : 'A' });
    }
    for (const seg of parseTranscript(SEEDED_DEMO_RESOLUTION)) await call('POST', `/api/sessions/${id}/segments`, seg);

    const ended = await call('POST', `/api/sessions/${id}/end`);
    const published = ended.body.published as any[];
    expect(published.map((p) => p.outcome)).toEqual(['created', 'created']);
    const access = published.find((p) => /revoke access/i.test(p.title))!;
    expect(access).toMatchObject({ version: 1 });
    accessRecordId = access.recordId;

    expect((await call('POST', `/api/sessions/${id}/end`)).body.published).toEqual([]); // idempotent

    const rec = (await call('GET', `/api/requirements/${accessRecordId}`)).body;
    expect(rec.label).toMatch(/^REQ-\d+$/);
    expect(rec.versions).toHaveLength(1);
    expect(rec.versions[0]).toMatchObject({ confirmation: 'clarified', confirmedBy: expect.arrayContaining(['Priya', 'Sam']), origin: 'created' });
    expect(rec.versions[0].evidence.some((e: any) => e.kind === 'scenario_answer')).toBe(true);
    expect(rec.versions[0].description).toMatch(/revokes the access/);
  });

  it('meeting 2: is checked against the record, and a confirmed change creates v2', async () => {
    const { id, view } = await meeting(`Priya (PO): When an approval is undone, the applicant should keep their access.
Sam (Developer): Okay, access stays then.`);
    expect(view.state.priorDecisions.some((p: any) => p.id === accessRecordId)).toBe(true);
    const conflict = view.state.discrepancies.find((d: any) => d.category === 'direct_disagreement');
    expect(conflict.title).toMatch(/earlier decision/);
    expect(conflict.history.some((h: any) => h.status === 'different_expectations_confirmed')).toBe(true);
    expect(conflict.status).toBe('resolved');
    expect(conflict.resolution.confirmedBy.every((id: string) => !id.startsWith('prior:'))).toBe(true);

    const ended = await call('POST', `/api/sessions/${id}/end`);
    expect(ended.body.published).toEqual([
      expect.objectContaining({ recordId: accessRecordId, version: 2, outcome: 'superseded', title: 'When an approval is undone, the applicant should keep their access.' }),
    ]);
    const rec = (await call('GET', `/api/requirements/${accessRecordId}`)).body;
    expect(rec.record.currentVersion).toBe(2);
    expect(rec.versions.map((v: any) => v.origin)).toEqual(['created', 'supersedes']);
    expect(rec.versions[0].description).toMatch(/revokes the access/); // history is immutable
  });

  it('meeting 3: returning to the recorded decision reaffirms it without a new version', async () => {
    const { id } = await meeting(`Priya (PO): When an approval is undone, the applicant should lose their access.
Sam (Developer): No, we agreed access stays.
Priya (PO): Right, they keep access then.`);
    const ended = await call('POST', `/api/sessions/${id}/end`);
    // Only the reaffirmation: loaded records are context, never re-recorded as new agreements.
    expect(ended.body.published).toEqual([expect.objectContaining({ recordId: accessRecordId, outcome: 'reaffirmed', version: 2 })]);
    const rec = (await call('GET', `/api/requirements/${accessRecordId}`)).body;
    expect(rec.record.currentVersion).toBe(2);
    expect(rec.record.reaffirmations).toHaveLength(1);
  });

  it('lists, retires and exports records; retired records are not used as prior decisions', async () => {
    const list = (await call('GET', '/api/requirements?status=active')).body as any[];
    expect(list.some((r) => r.id === accessRecordId && r.current.version === 2)).toBe(true);

    const md = await call('GET', '/api/requirements/export?format=md');
    expect(md.headers.get('content-disposition')).toMatch(/requirements-.*\.md/);
    expect(md.body).toMatch(/## REQ-\d+ — /);
    expect(md.body).toContain('**History**');

    expect((await call('POST', `/api/requirements/${accessRecordId}/status`, { status: 'retired', reason: 'Replaced by policy doc' })).body.status).toBe('retired');
    const { view } = await meeting('Priya (PO): Admins should be able to undo approvals.');
    expect(view.state.priorDecisions.some((p: any) => p.id === accessRecordId)).toBe(false);
    await call('POST', `/api/requirements/${accessRecordId}/status`, { status: 'active' });
  });

  it('deleting a session removes its quotes from records but keeps the agreed text', async () => {
    const before = (await call('GET', `/api/requirements/${accessRecordId}`)).body;
    const v2 = before.versions[1];
    expect(v2.evidence.length).toBeGreaterThan(0);
    await call('DELETE', `/api/sessions/${v2.sessionId}`);
    const after = (await call('GET', `/api/requirements/${accessRecordId}`)).body;
    expect(after.versions[1]).toMatchObject({ evidence: [], evidenceRedacted: true, sessionId: null, description: v2.description });
  });
});
