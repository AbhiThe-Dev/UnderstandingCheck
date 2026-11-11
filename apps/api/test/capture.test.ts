import { EventEmitter } from 'node:events';
import { serve, type ServerType } from '@hono/node-server';
import type { LiveTranscriber, LiveTranscriberEvents, RecallClient } from '@uc/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import { Services } from '../src/services';

/**
 * Behaves like the real Realtime API: acknowledgements arrive after a delay (possibly after the
 * operator switched speakers), and shorter turns finish transcribing before longer, earlier ones.
 */
class FakeTranscriber extends EventEmitter<LiveTranscriberEvents> implements LiveTranscriber {
  readonly model = 'gpt-live-transcribe';
  audioSeconds = 0;
  private pending = 0;
  private n = 0;
  private tag: string | null = null;
  constructor(private script: string[]) {
    super();
  }
  async start() {}
  setTag(tag: string | null) {
    this.tag = tag;
  }
  appendPcm16(chunk: Buffer) {
    this.pending += chunk.length;
    this.audioSeconds += chunk.length / 48_000;
  }
  commit() {
    if (!this.pending) return;
    this.pending = 0;
    const seq = ++this.n;
    const itemId = `item_${seq}`;
    const tag = this.tag;
    const text = this.script.shift() ?? '';
    setTimeout(() => this.emit('committed', { itemId, seq, tag }), 40);
    setTimeout(() => {
      this.emit('partial', { itemId, text: text.slice(0, 5) });
      this.emit('final', { itemId, text });
    }, 60 + text.length * 3);
  }
  async close() {
    this.commit();
  }
}

const uploads: Record<string, string>[] = [];
const fakeRecall = {
  region: 'us-west-2',
  apiUrl: 'https://us-west-2.recall.ai',
  async createSdkUpload(metadata: Record<string, string>) {
    uploads.push(metadata);
    return { id: `up${uploads.length}`, uploadToken: 'tok_test', recordingId: 'rec', status: 'pending' };
  },
} as unknown as RecallClient;

const word = (text: string, t: number) => ({ text, start_timestamp: { relative: t }, end_timestamp: { relative: t + 0.3 } });
const utterance = (name: string, text: string, at: number, event = 'transcript.data') => ({
  event,
  data: { data: { words: text.split(' ').map((w, i) => word(w, at + i * 0.3)), participant: { id: name.length, name } } },
});

let app: ReturnType<typeof createApp>;
let server: ServerType;
let port = 0;
const script: string[] = [];

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  const services = await Services.create({ analyzer: 'heuristic', host: null, recall: fakeRecall, transcriber: () => new FakeTranscriber(script) });
  app = createApp(services);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      port = info.port;
      resolve();
    });
  });
  app.injectWebSocket(server);
});
afterAll(() => server.close());

/** Live capture shows turns at once and analyses them in the background; wait until it has caught up. */
async function analysed(id: string) {
  for (let i = 0; i < 200; i++) {
    const view = (await call('GET', `/api/sessions/${id}`)).body;
    if (view.state.analyzedThrough === view.segments.length - 1) return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('analysis did not catch up');
}

describe('meeting capture through Recall.ai', () => {
  it('reports what is configured without exposing keys', async () => {
    const cfg = (await call('GET', '/api/capture/config')).body;
    expect(cfg).toEqual({ recall: { configured: true, region: 'us-west-2', apiUrl: 'https://us-west-2.recall.ai' }, microphone: { configured: true, model: 'gpt-live-transcribe' } });
  });

  it('needs consent, then turns Recall transcript events into a live session', async () => {
    const { body } = await call('POST', '/api/demo');
    const id = body.id as string;
    expect((await call('POST', `/api/sessions/${id}/capture/recall`, { consentConfirmed: false })).status).toBe(400);

    const started = await call('POST', `/api/sessions/${id}/capture/recall`, { consentConfirmed: true, meeting: { title: 'Weekly sync', platform: 'zoom' } });
    expect(started.status).toBe(201);
    expect(started.body).toEqual({ uploadId: 'up1', uploadToken: 'tok_test', apiUrl: 'https://us-west-2.recall.ai' });
    expect(uploads[0]).toEqual({ uc_session_id: id });
    expect((await call('POST', `/api/sessions/${id}/capture/recall`, { consentConfirmed: true })).status).toBe(409); // already live

    const partial = await call('POST', `/api/sessions/${id}/capture/recall/events`, utterance('Priya', 'Admins need', 1, 'transcript.partial_data'));
    expect(partial.body.capture.partial).toEqual({ speaker: 'Priya', text: 'Admins need' });

    const batch = [
      utterance('Priya', 'Admins need to be able to undo an approval when a reviewer approves the wrong application.', 1),
      utterance('Sam', "Easy enough, I'll just set the status back to pending.", 9),
      utterance('Priya', 'Sounds good.', 14),
    ];
    const r = await call('POST', `/api/sessions/${id}/capture/recall/events`, batch);
    expect(r.body.capture).toMatchObject({ source: 'recall', status: 'live', segments: 3, duplicates: 0, partial: null, meeting: { title: 'Weekly sync' } });

    // The desktop app retrying the same events changes nothing.
    const retry = await call('POST', `/api/sessions/${id}/capture/recall/events`, batch);
    expect(retry.body.capture).toMatchObject({ segments: 3, duplicates: 3 });

    const view = await analysed(id);
    expect(view.segments.map((s: any) => s.text)).toHaveLength(3);
    expect(view.state.participants.map((p: any) => p.displayName)).toEqual(['Priya', 'Sam']);
    expect(view.state.discrepancies.find((d: any) => d.visibility === 'live')).toMatchObject({ category: 'false_alignment' });

    expect((await call('POST', `/api/sessions/${id}/capture/stop`)).body.capture.status).toBe('stopped');
    expect((await call('POST', `/api/sessions/${id}/capture/recall/events`, batch[0])).status).toBe(200); // still idempotent after stop
  });

  it('accepts a meeting Recall has not named yet', async () => {
    const { body } = await call('POST', '/api/demo');
    const started = await call('POST', `/api/sessions/${body.id}/capture/recall`, { consentConfirmed: true, meeting: { title: null, platform: 'google-meet' } });
    expect(started.status).toBe(201);
    expect((await call('GET', `/api/sessions/${body.id}`)).body.capture).toMatchObject({ meeting: { platform: 'google-meet' } });
    await call('POST', `/api/sessions/${body.id}/capture/stop`);
  });

  // The desktop SDK labels speech by audio stream: "Host" (this computer's mic) and "Guest" (the call).
  const joined = (id: number, name: string) => ({ event: 'participant_events.join', data: { data: { participant: { id, name } } } });
  const roster = (...names: string[]) => [joined(32766, 'Host'), joined(32767, 'Guest'), ...names.map((n, i) => joined(i, n))];

  it('names the stream labels in a 1:1 call: Host is the local user, Guest the one other person', async () => {
    const { body } = await call('POST', '/api/demo');
    await call('POST', `/api/sessions/${body.id}/capture/recall`, { consentConfirmed: true, localName: 'Priya' });
    const r = await call('POST', `/api/sessions/${body.id}/capture/recall/events`, [
      ...roster('Priya', 'Sam'),
      utterance('Host', 'Admins need to be able to undo an approval when a reviewer approves the wrong application.', 1),
      utterance('Guest', "Easy enough, I'll just set the status back to pending.", 9),
      utterance('Host', 'Sounds good.', 14),
    ]);
    expect(r.body.capture).toMatchObject({ localName: 'Priya', remoteParticipants: ['Sam'], segments: 3 });
    const view = await analysed(body.id);
    expect(view.state.participants.map((p: any) => p.displayName)).toEqual(['Priya', 'Sam']);
    expect(view.state.discrepancies.find((d: any) => d.visibility === 'live')).toMatchObject({ category: 'false_alignment' });
    await call('POST', `/api/sessions/${body.id}/capture/stop`);
  });

  it('calls several remote people "Others" and still raises what does not depend on who spoke', async () => {
    const { body } = await call('POST', '/api/demo');
    await call('POST', `/api/sessions/${body.id}/capture/recall`, { consentConfirmed: true, localName: 'priya' });
    const r = await call('POST', `/api/sessions/${body.id}/capture/recall/events`, [
      ...roster('Priya', 'Sam', 'Lee'),
      utterance('Guest', 'Admins need to be able to undo an approval when a reviewer approves the wrong application.', 1),
      utterance('Guest', "Easy enough, I'll just set the status back to pending.", 9),
      utterance('Guest', 'Sounds good.', 14),
    ]);
    expect(r.body.capture.remoteParticipants).toEqual(['Sam', 'Lee']);
    const view = await analysed(body.id);
    expect(view.state.participants).toEqual([expect.objectContaining({ displayName: 'Others', ambiguous: true })]);
    const live = view.state.discrepancies.filter((d: any) => d.visibility === 'live');
    expect(live.map((d: any) => d.category)).toEqual(['missing_specification']);
    expect(live[0].codeRefs[0].filePath).toBe('src/applications/approve.ts');
    await call('POST', `/api/sessions/${body.id}/capture/stop`);
  });

  it('takes code names read from the screen during a capture and keeps only what the repository has', async () => {
    const { body } = await call('POST', '/api/demo');
    const screen = (b: unknown) => call('POST', `/api/sessions/${body.id}/capture/screen`, b);
    const onScreen = { identifiers: ['approveApplication', 'somethingElse'], files: [{ path: 'src/applications/approve.ts', line: 17 }] };
    expect((await screen(onScreen)).status).toBe(409); // nothing is being captured

    await call('POST', `/api/sessions/${body.id}/capture/recall`, { consentConfirmed: true });
    expect((await screen({ identifiers: Array.from({ length: 201 }, (_, i) => `name${i}`), files: [] })).status).toBe(400);
    const r = await screen(onScreen);
    expect(r.status).toBe(200);
    expect(r.body.matched[0]).toBe('approveApplication (src/applications/approve.ts:11)');
    expect(r.body.matched.join(' ')).not.toContain('somethingElse');
    const view = (await call('GET', `/api/sessions/${body.id}`)).body;
    expect(view.capture.screen.matched[0]).toContain('approveApplication');
    expect(view.state.screen.files).toEqual(['src/applications/approve.ts']);
    await call('POST', `/api/sessions/${body.id}/capture/stop`);
  });

  it('rejects events for a session that is not capturing', async () => {
    const { body } = await call('POST', '/api/demo');
    expect((await call('POST', `/api/sessions/${body.id}/capture/recall/events`, utterance('A', 'hi there', 1))).status).toBe(409);
  });
});

describe('microphone capture', () => {
  const open = (id: string, query: string, origin = 'http://localhost:3000') =>
    new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/audio?${query}`, { headers: { origin } });
  const messages = (ws: WebSocket) => {
    const got: any[] = [];
    ws.on('message', (m) => got.push(JSON.parse(m.toString())));
    return got;
  };
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('refuses streams without consent or from another origin', async () => {
    const { body } = await call('POST', '/api/demo');
    for (const ws of [open(body.id, 'speaker=Priya'), open(body.id, 'consent=1', 'https://evil.example')]) {
      ws.on('error', () => undefined); // the refused handshake also surfaces as a client error
      const status = await new Promise<number>((r) => ws.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
      expect(status).toBe(403);
    }
  });

  it('transcribes turns, attributes them to the speaker at commit time, and records cost', async () => {
    const { body } = await call('POST', '/api/demo');
    const id = body.id as string;
    script.push('Admins need to be able to undo an approval when a reviewer approves the wrong application.', "Easy enough, I'll just set the status back to pending.", 'Sounds good.');
    const ws = open(id, 'consent=1&speaker=Priya');
    const got = messages(ws);
    await until(() => got.some((m) => m.type === 'ready'));

    const second = Buffer.alloc(48_000); // one second of PCM16 at 24 kHz
    // Priya speaks; the operator taps Sam (committing Priya's turn); Sam speaks; the operator taps
    // Priya; Priya says "Sounds good." and pauses. Everything is sent at once, so every acknowledgement
    // arrives after the last switch, and the short final turn finishes transcribing first.
    ws.send(second);
    ws.send(JSON.stringify({ type: 'speaker', name: 'Sam' }));
    ws.send(second);
    ws.send(JSON.stringify({ type: 'speaker', name: 'Priya' }));
    ws.send(second);
    ws.send(JSON.stringify({ type: 'commit' }));
    await until(() => got.filter((m) => m.type === 'final').length === 3);
    expect(got.filter((m) => m.type === 'final').map((m) => `${m.speaker}: ${m.text}`)).toEqual([
      'Priya: Admins need to be able to undo an approval when a reviewer approves the wrong application.',
      "Sam: Easy enough, I'll just set the status back to pending.",
      'Priya: Sounds good.',
    ]);

    const live = (await call('GET', `/api/sessions/${id}`)).body;
    expect(live.capture).toMatchObject({ source: 'microphone', status: 'live', segments: 3, speaker: 'Priya' });
    expect(live.segments).toHaveLength(3);
    // In spoken order, the engine sees proposal-then-agreement and suspects false alignment.
    expect(live.state.discrepancies.find((d: any) => d.visibility === 'live')).toMatchObject({ category: 'false_alignment' });

    ws.send(JSON.stringify({ type: 'stop' }));
    await new Promise((r) => ws.on('close', r));
    await until(() => true);
    const usage = (await call('GET', '/api/usage')).body;
    expect(usage.byOperation).toContainEqual(expect.objectContaining({ operation: 'transcription', model: 'gpt-live-transcribe', calls: 1 }));
    expect(usage.byOperation.find((o: any) => o.operation === 'transcription').costUsd).toBeCloseTo((3 / 60) * 0.017, 6);
    expect((await call('GET', `/api/sessions/${id}`)).body.capture.status).toBe('stopped');
  });
});
