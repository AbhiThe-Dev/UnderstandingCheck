import { transcriptionPricesFrom } from '@uc/core';
import { parseRecallTranscript, recallSegment, type LiveTranscriber, type RecallClient } from '@uc/providers';
import type { HttpError as HttpErrorType, Services } from './services';

export interface CaptureInfo {
  source: 'recall' | 'microphone';
  status: 'live' | 'stopped' | 'error';
  startedAt: string;
  stoppedAt: string | null;
  /** Final utterances delivered to the engine. */
  segments: number;
  /** Utterances ignored because they were already received (retries, resends). */
  duplicates: number;
  /** What is being said right now (not yet final). */
  partial: { speaker: string; text: string } | null;
  /** Microphone only: who the next utterances are attributed to. */
  speaker: string | null;
  meeting: { title?: string; platform?: string } | null;
  error: string | null;
  audioSeconds: number;
  model: string | null;
}

export interface MicrophoneConnection {
  send(message: Record<string, unknown>): void;
  close(): void;
}

type MakeError = (status: 400 | 404 | 409 | 422 | 503, message: string) => HttpErrorType;

/**
 * Live meeting capture for a session. Two sources feed the same ingestion path as replays and
 * the streaming endpoint:
 * - Recall.ai Desktop SDK (meeting calls): the server creates the upload (the API key never leaves
 *   it); the desktop app forwards Recall's speaker-labeled transcript events here.
 * - Microphone (in-person): audio is relayed to a live transcription model; the operator chooses
 *   the current speaker, because live transcription does not separate voices.
 * Capture only ever starts from an explicit user action with consent confirmed.
 */
export class CaptureManager {
  private captures = new Map<string, CaptureInfo & { uploadId?: string; baseTimestampMs: number }>();

  constructor(
    private services: Services,
    private deps: { recall: RecallClient | null; transcriber: (() => LiveTranscriber) | null },
    private makeError: MakeError,
  ) {}

  config() {
    const r = this.deps.recall;
    return {
      recall: r ? { configured: true, region: r.region, apiUrl: r.apiUrl } : { configured: false },
      microphone: this.deps.transcriber ? { configured: true, model: 'gpt-live-transcribe' } : { configured: false },
    };
  }

  status(sessionId: string): CaptureInfo | null {
    const c = this.captures.get(sessionId);
    if (!c) return null;
    const { uploadId: _u, baseTimestampMs: _b, ...info } = c;
    return info;
  }

  private async begin(sessionId: string, source: CaptureInfo['source'], extra: Partial<CaptureInfo> = {}) {
    const snap = await this.services.snapshot(sessionId);
    if (snap.status === 'ended') throw this.makeError(409, 'Session has ended');
    if (this.captures.get(sessionId)?.status === 'live') throw this.makeError(409, 'Capture is already running for this session; stop it first');
    const last = snap.segments.at(-1);
    const info: CaptureInfo & { uploadId?: string; baseTimestampMs: number } = {
      source,
      status: 'live',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      segments: 0,
      duplicates: 0,
      partial: null,
      speaker: null,
      meeting: null,
      error: null,
      audioSeconds: 0,
      model: null,
      ...extra,
      baseTimestampMs: last ? last.timestamp + 2000 : 0,
    };
    this.captures.set(sessionId, info);
    this.services.notify(sessionId);
    return info;
  }

  // ---------------- Recall.ai (meeting calls)

  async startRecall(sessionId: string, meeting: { title?: string; platform?: string } | null) {
    if (!this.deps.recall) throw this.makeError(503, 'Recall.ai is not configured (set RECALL_API_KEY and RECALL_REGION)');
    const info = await this.begin(sessionId, 'recall', { meeting });
    try {
      const upload = await this.deps.recall.createSdkUpload({ uc_session_id: sessionId });
      info.uploadId = upload.id;
      return { uploadId: upload.id, uploadToken: upload.uploadToken, apiUrl: this.deps.recall.apiUrl };
    } catch (err) {
      Object.assign(info, { status: 'error', error: (err as Error).message, stoppedAt: new Date().toISOString() });
      this.services.notify(sessionId);
      throw err;
    }
  }

  /** A raw `realtime-event` forwarded by the desktop app. */
  async recallEvent(sessionId: string, evt: { event?: string; data?: unknown }) {
    const info = this.captures.get(sessionId);
    if (!info || info.source !== 'recall' || !info.uploadId) throw this.makeError(409, 'No Recall capture is running for this session');
    const t = parseRecallTranscript(evt);
    if (!t) return { accepted: false as const };
    if (!t.final) {
      info.partial = { speaker: t.speaker, text: t.text };
      this.services.notify(sessionId);
      return { accepted: true as const, partial: true };
    }
    info.partial = null;
    const { events } = await this.services.run(sessionId, (engine) => engine.ingest(recallSegment(t, info.uploadId!, info.baseTimestampMs)));
    if (events.some((e) => e.type === 'duplicate_segment')) info.duplicates++;
    else info.segments++;
    this.services.notify(sessionId);
    return { accepted: true as const, partial: false };
  }

  stop(sessionId: string, error?: string) {
    const info = this.captures.get(sessionId);
    if (!info || info.status !== 'live') return this.status(sessionId);
    Object.assign(info, { status: error ? 'error' : 'stopped', error: error ?? null, stoppedAt: new Date().toISOString(), partial: null });
    this.services.notify(sessionId);
    return this.status(sessionId);
  }

  // ---------------- Microphone (in-person)

  /**
   * Relay one microphone stream. Returns handlers for the socket; the caller wires them to its
   * WebSocket implementation. Binary frames are 24 kHz mono PCM16; text frames are control messages.
   */
  async openMicrophone(sessionId: string, conn: MicrophoneConnection, speaker: string) {
    if (!this.deps.transcriber) throw this.makeError(503, 'Live transcription is not configured (set OPENAI_API_KEY)');
    const ws = await this.services.store.workspace();
    if ((await this.services.store.spentThisMonthUsd()) >= ws.monthlyBudgetUsd) {
      throw this.makeError(409, 'The workspace budget for this month is used up; transcription is paused');
    }
    const info = await this.begin(sessionId, 'microphone', { speaker });
    const transcriber = this.deps.transcriber();
    info.model = transcriber.model;
    const pricePerMinute = transcriptionPricesFrom(process.env.UC_TRANSCRIPTION_PRICES_JSON)[transcriber.model] ?? 0;

    // Turns are attributed to whoever was speaking when the turn was committed, not when its
    // transcript arrives (which can be after the operator switched speakers).
    const speakerByItem = new Map<string, string>();
    transcriber.on('committed', ({ itemId }) => speakerByItem.set(itemId, info.speaker ?? 'Room'));
    transcriber.on('partial', ({ text }) => {
      info.partial = { speaker: info.speaker ?? 'Room', text };
      conn.send({ type: 'partial', text, speaker: info.speaker });
      this.services.notify(sessionId);
    });
    transcriber.on('final', ({ itemId, text }) => {
      info.partial = null;
      const who = speakerByItem.get(itemId) ?? info.speaker ?? 'Room';
      speakerByItem.delete(itemId);
      void this.services
        .run(sessionId, (engine) => engine.ingest({ speaker: who, text, externalId: `mic:${itemId}` }))
        .then(({ events }) => {
          const seg = events.find((e) => e.type === 'segment_added');
          info.segments++;
          conn.send({ type: 'final', text, speaker: who, segmentId: seg?.type === 'segment_added' ? seg.segment.id : null });
        })
        .catch((err: Error) => conn.send({ type: 'error', message: err.message }));
    });
    transcriber.on('error', ({ code, message }) => {
      conn.send({ type: 'error', code, message });
      // Billing and auth problems will not fix themselves mid-meeting: stop rather than keep streaming.
      if (/quota|credit|invalid_api_key|authentication/i.test(code)) {
        this.stop(sessionId, `Transcription stopped: ${message}`);
        conn.close();
      }
    });

    try {
      await transcriber.start();
    } catch (err) {
      this.stop(sessionId, (err as Error).message);
      throw this.makeError(503, `Could not start live transcription: ${(err as Error).message}`);
    }
    conn.send({ type: 'ready', model: transcriber.model, speaker });

    let closed = false;
    const finish = async () => {
      if (closed) return;
      closed = true;
      await transcriber.close();
      info.audioSeconds = Math.round(transcriber.audioSeconds);
      if (transcriber.audioSeconds > 0) {
        await this.services.store.recordUsage({
          sessionId,
          sessionDbId: sessionId,
          model: transcriber.model,
          operation: 'transcription',
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: (transcriber.audioSeconds / 60) * pricePerMinute,
        });
      }
      this.stop(sessionId);
    };

    return {
      onAudio: (chunk: Buffer) => {
        transcriber.appendPcm16(chunk);
        info.audioSeconds = Math.round(transcriber.audioSeconds);
      },
      onControl: (msg: { type?: string; name?: string }) => {
        if (msg.type === 'commit') transcriber.commit();
        if (msg.type === 'speaker' && typeof msg.name === 'string' && msg.name.trim()) {
          // Finish the previous speaker's turn before attributing new audio to someone else.
          transcriber.commit();
          info.speaker = msg.name.trim().slice(0, 80);
          this.services.notify(sessionId);
        }
        if (msg.type === 'stop') void finish().then(() => conn.close());
      },
      onClose: () => void finish(),
    };
  }
}
