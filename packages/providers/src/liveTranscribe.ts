import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** 16-bit little-endian mono PCM at this rate is what the live transcription model accepts. */
export const LIVE_SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = LIVE_SAMPLE_RATE * 2;
/** Safety net: commit a turn on our own if the client never signals a pause. */
const MAX_TURN_SECONDS = 15;

export interface LiveTranscriberEvents {
  ready: [];
  /** A turn was committed; its transcript will arrive later with this item id. */
  committed: [{ itemId: string }];
  partial: [{ itemId: string; text: string }];
  final: [{ itemId: string; text: string }];
  error: [{ code: string; message: string }];
  closed: [];
}

/** Streaming speech-to-text for one audio source. */
export interface LiveTranscriber extends EventEmitter<LiveTranscriberEvents> {
  readonly model: string;
  /** Seconds of audio sent so far (for cost tracking). */
  readonly audioSeconds: number;
  start(): Promise<void>;
  appendPcm16(chunk: Buffer): void;
  /** End the current turn: whatever was appended since the last commit is transcribed. */
  commit(): void;
  close(): Promise<void>;
}

export interface OpenAiLiveOptions {
  apiKey: string;
  model?: string;
  url?: string;
  languages?: string[];
}

/**
 * OpenAI Realtime transcription (`gpt-live-transcribe`). The model only supports manually committed
 * turns (no server-side voice activity detection), so callers commit at pauses; a long monologue is
 * committed automatically every {@link MAX_TURN_SECONDS}.
 */
export class OpenAiLiveTranscriber extends EventEmitter<LiveTranscriberEvents> implements LiveTranscriber {
  readonly model: string;
  private ws: WebSocket | null = null;
  private pendingBytes = 0;
  private totalBytes = 0;
  private partials = new Map<string, string>();

  constructor(private readonly opts: OpenAiLiveOptions) {
    super();
    this.model = opts.model ?? 'gpt-live-transcribe';
  }

  get audioSeconds() {
    return this.totalBytes / BYTES_PER_SECOND;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url ?? 'wss://api.openai.com/v1/realtime?intent=transcription', {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: LIVE_SAMPLE_RATE },
                  transcription: { model: this.model, ...(this.opts.languages ? { languages: this.opts.languages } : {}) },
                  turn_detection: null,
                },
              },
            },
          }),
        );
      });
      ws.on('message', (raw) => {
        let ev: { type: string; [k: string]: unknown };
        try {
          ev = JSON.parse(raw.toString());
        } catch {
          return;
        }
        switch (ev.type) {
          case 'session.updated':
          case 'transcription_session.updated':
            if (!settled) {
              settled = true;
              this.emit('ready');
              resolve();
            }
            break;
          case 'input_audio_buffer.committed':
            this.emit('committed', { itemId: String(ev.item_id) });
            break;
          case 'conversation.item.input_audio_transcription.delta': {
            const id = String(ev.item_id);
            const text = (this.partials.get(id) ?? '') + String(ev.delta ?? '');
            this.partials.set(id, text);
            this.emit('partial', { itemId: id, text });
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            const id = String(ev.item_id);
            const text = String(ev.transcript ?? this.partials.get(id) ?? '').trim();
            this.partials.delete(id);
            if (text) this.emit('final', { itemId: id, text });
            break;
          }
          case 'error': {
            const e = (ev.error ?? {}) as { code?: string; type?: string; message?: string };
            const err = { code: e.code ?? e.type ?? 'error', message: e.message ?? 'Transcription error' };
            // An 'error' event with no listener throws in Node; during startup the caller gets the rejection instead.
            if (this.listenerCount('error') > 0) this.emit('error', err);
            if (!settled) {
              settled = true;
              reject(new Error(`${err.code}: ${err.message}`));
            }
            break;
          }
        }
      });
      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else if (this.listenerCount('error') > 0) this.emit('error', { code: 'connection', message: err.message });
      });
      ws.on('close', () => {
        this.emit('closed');
        if (!settled) {
          settled = true;
          reject(new Error('Transcription connection closed before it was ready'));
        }
      });
    });
  }

  appendPcm16(chunk: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || chunk.length === 0) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
    this.pendingBytes += chunk.length;
    this.totalBytes += chunk.length;
    if (this.pendingBytes >= MAX_TURN_SECONDS * BYTES_PER_SECOND) this.commit();
  }

  commit() {
    // Committing an empty buffer is an error on the server; a short blip is not worth a turn.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pendingBytes < BYTES_PER_SECOND / 10) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.pendingBytes = 0;
  }

  async close() {
    this.commit();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    // Give the final commit a moment to come back before closing.
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
  }
}
