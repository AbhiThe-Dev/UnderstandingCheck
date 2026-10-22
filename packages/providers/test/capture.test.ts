import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { OpenAiLiveTranscriber, RecallClient, parseRecallTranscript, recallSegment } from '../src';

const transcriptEvent = (event: string, words: string[], participant: { id: number; name: string | null }, start = 12.5) => ({
  event,
  data: {
    data: {
      words: words.map((text, i) => ({ text, start_timestamp: { relative: start + i * 0.4 }, end_timestamp: { relative: start + i * 0.4 + 0.3 } })),
      participant: { id: participant.id, name: participant.name, is_host: false, platform: 'zoom', extra_data: null, email: null },
    },
    realtime_endpoint: { id: 're1', metadata: {} },
    transcript: { id: 't1', metadata: {} },
    recording: { id: 'r1', metadata: {} },
  },
});

describe('Recall transcript events', () => {
  it('turns transcript.data into a speaker-labeled segment with a stable id', () => {
    const t = parseRecallTranscript(transcriptEvent('transcript.data', ['Sounds', 'good', '.'], { id: 3, name: 'Priya' }))!;
    expect(t).toMatchObject({ final: true, speaker: 'Priya', text: 'Sounds good.', startMs: 12500, participantId: '3' });
    expect(recallSegment(t, 'up1', 60_000)).toEqual({ speaker: 'Priya', text: 'Sounds good.', timestamp: 72_500, externalId: 'recall:up1:3:12500' });
  });

  it('accepts the payload without the outer wrapper, marks partials, and names unknown speakers', () => {
    const inner = transcriptEvent('transcript.partial_data', ['I', 'will'], { id: 7, name: null }).data;
    const t = parseRecallTranscript({ event: 'transcript.partial_data', data: inner.data })!;
    expect(t).toMatchObject({ final: false, speaker: 'Participant 7', text: 'I will' });
  });

  it('ignores other events and empty utterances', () => {
    expect(parseRecallTranscript({ event: 'participant_events.join', data: {} })).toBeNull();
    expect(parseRecallTranscript(transcriptEvent('transcript.data', [' '], { id: 1, name: 'A' }))).toBeNull();
  });

  it('creates SDK uploads with Recall streaming transcription delivered to the desktop app', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new RecallClient({
      apiKey: 'k_test',
      region: 'us-west-2',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ id: 'up1', upload_token: 'tok', recording_id: 'rec1', status: { code: 'pending' } }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(await client.createSdkUpload({ uc_session_id: 's1' })).toEqual({ id: 'up1', uploadToken: 'tok', recordingId: 'rec1', status: 'pending' });
    expect(seen!.url).toBe('https://us-west-2.recall.ai/api/v1/sdk_upload/');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Token k_test');
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      recording_config: {
        transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } } },
        realtime_endpoints: [{ type: 'desktop_sdk_callback', events: ['transcript.data', 'transcript.partial_data'] }],
      },
      metadata: { uc_session_id: 's1' },
    });
  });
});

describe('OpenAI live transcription client (against a local fake Realtime server)', () => {
  let wss: WebSocketServer;
  let url = '';
  const received: { type: string; [k: string]: unknown }[] = [];
  let auth = '';
  let behavior: 'ok' | 'quota' = 'ok';

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v1/realtime?intent=transcription`;
    let item = 0;
    wss.on('connection', (sock: ServerSocket, req) => {
      auth = String(req.headers.authorization);
      sock.on('message', (raw) => {
        const ev = JSON.parse(raw.toString());
        received.push(ev);
        if (ev.type === 'session.update') {
          if (behavior === 'quota') return sock.send(JSON.stringify({ type: 'error', error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'No credits' } }));
          sock.send(JSON.stringify({ type: 'session.updated', session: ev.session }));
        }
        if (ev.type === 'input_audio_buffer.commit') {
          const id = `item_${++item}`;
          sock.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: id }));
          sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: 'Sounds ' }));
          sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: 'good' }));
          sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Sounds good.' }));
        }
      });
    });
  });
  afterAll(() => wss.close());

  it('configures a transcription session, streams audio, and reports partial and final text', async () => {
    received.length = 0;
    const t = new OpenAiLiveTranscriber({ apiKey: 'sk-test', url });
    const events: string[] = [];
    t.on('committed', (e) => events.push(`committed:${e.itemId}`));
    t.on('partial', (e) => events.push(`partial:${e.text}`));
    const final = new Promise<{ itemId: string; text: string }>((r) => t.on('final', r));
    await t.start();
    expect(auth).toBe('Bearer sk-test');
    expect(received[0]).toMatchObject({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } } },
    });

    t.commit(); // nothing buffered yet: must not send an empty commit
    t.appendPcm16(Buffer.alloc(48_000)); // one second of silence
    t.commit();
    expect(await final).toEqual({ itemId: 'item_1', text: 'Sounds good.' });
    expect(events).toEqual(['committed:item_1', 'partial:Sounds ', 'partial:Sounds good']);
    expect(received.filter((e) => e.type === 'input_audio_buffer.commit')).toHaveLength(1);
    expect(t.audioSeconds).toBe(1);
    await t.close();
  });

  it('commits automatically during a long monologue', async () => {
    received.length = 0;
    const t = new OpenAiLiveTranscriber({ apiKey: 'sk-test', url });
    await t.start();
    for (let i = 0; i < 16; i++) t.appendPcm16(Buffer.alloc(48_000));
    await new Promise((r) => setTimeout(r, 50));
    expect(received.filter((e) => e.type === 'input_audio_buffer.commit')).toHaveLength(1);
    await t.close();
  });

  it('fails to start with the provider error (e.g. no credits)', async () => {
    behavior = 'quota';
    const t = new OpenAiLiveTranscriber({ apiKey: 'sk-test', url });
    await expect(t.start()).rejects.toThrow('insufficient_quota: No credits');
    behavior = 'ok';
  });
});
