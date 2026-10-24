import { transcriptionPricesFrom } from '@uc/core';
import { parseRecallParticipantEvent, parseRecallTranscript, recallSegment, type LiveTranscriber, type RecallClient } from '@uc/providers';
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
  /** Recall only: the person at this computer, whose microphone Recall labels "Host". */
  localName: string | null;
  /** Recall only: everyone else in the call, from Recall's join and leave events. */
  remoteParticipants: string[];
  meeting: { title?: string; platform?: string } | null;
  error: string | null;
  audioSeconds: number;
  model: string | null;
  /** Recall only: code read from the shared screen on the desktop, as matched against the repository. */
  screen: { lastAt: string; matched: string[] } | null;
}

export interface MicrophoneConnection {
  send(message: Record<string, unknown>): void;
  close(): void;
}

/** How long a committed turn may take to transcribe before later turns stop waiting for it. */
const TURN_TIMEOUT_MS = 20_000;

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
  private captures = new Map<string, CaptureInfo & { uploadId?: string; baseTimestampMs: number; roster?: Map<string, string> }>();

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
    const { uploadId: _u, baseTimestampMs: _b, roster: _r, ...info } = c;
    return info;
  }

  private async begin(sessionId: string, source: CaptureInfo['source'], extra: Partial<CaptureInfo> = {}) {
    const snap = await this.services.snapshot(sessionId);
    if (snap.status === 'ended') throw this.makeError(409, 'Session has ended');
    if (this.captures.get(sessionId)?.status === 'live') throw this.makeError(409, 'Capture is already running for this session; stop it first');
    const last = snap.segments.at(-1);
    const info: CaptureInfo & { uploadId?: string; baseTimestampMs: number; roster?: Map<string, string> } = {
      source,
      status: 'live',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      segments: 0,
      duplicates: 0,
      partial: null,
      speaker: null,
      localName: null,
      remoteParticipants: [],
      meeting: null,
      error: null,
      audioSeconds: 0,
      model: null,
      screen: null,
      ...extra,
      baseTimestampMs: last ? last.timestamp + 2000 : 0,
    };
    this.captures.set(sessionId, info);
    this.services.notify(sessionId);
    return info;
  }

  // ---------------- Recall.ai (meeting calls)

  async startRecall(sessionId: string, meeting: { title?: string; platform?: string } | null, localName: string | null = null) {
    if (!this.deps.recall) throw this.makeError(503, 'Recall.ai is not configured (set RECALL_API_KEY and RECALL_REGION)');
    const info = await this.begin(sessionId, 'recall', { meeting, localName });
    info.roster = new Map();
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
    const p = parseRecallParticipantEvent(evt);
    if (p) {
      if (p.kind === 'join') info.roster!.set(p.id, p.name);
      else info.roster!.delete(p.id);
      info.remoteParticipants = this.remotes(info);
      this.services.notify(sessionId);
      return { accepted: true as const, partial: false };
    }
    const parsed = parseRecallTranscript(evt);
    if (!parsed) return { accepted: false as const };
    const t = { ...parsed, speaker: this.speakerFor(info, parsed.speaker) };
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

  /**
   * On the desktop Recall labels speech by audio stream, not by person: "Host" is this computer's
   * microphone and "Guest" is everything the call plays. Name them from what is known: the local user,
   * and the other participant when there is exactly one. With several, "Others" (who said what among
   * them is unknown, which the engine accounts for).
   */
  private speakerFor(info: CaptureInfo, label: string): string {
    if (label === 'Host') return info.localName ?? label;
    if (label !== 'Guest') return label;
    const remotes = info.remoteParticipants;
    return remotes.length === 1 ? remotes[0]! : remotes.length > 1 ? 'Others' : label;
  }

  private remotes(info: CaptureInfo & { roster?: Map<string, string> }) {
    const local = info.localName?.toLowerCase();
    return [...new Set(info.roster?.values() ?? [])].filter((n) => n.toLowerCase() !== local);
  }

  /**
   * Code names the desktop app read from the screen (never images or prose). Only names that match
   * the session's repository are kept, as context for what people are looking at.
   */
  async screen(sessionId: string, mentions: { identifiers: string[]; files: { path: string; line?: number }[] }) {
    const info = this.captures.get(sessionId);
    if (!info || info.status !== 'live') throw this.makeError(409, 'No capture is running for this session');
    const { snapshot: { state } } = await this.services.run(sessionId, (engine) => engine.observeScreen(mentions));
    const seen = state.screen ? state.screen.evidenceIds.flatMap((id) => state.evidence.find((e) => e.id === id) ?? []) : [];
    info.screen = { lastAt: new Date().toISOString(), matched: seen.map((e) => `${e.symbolName} (${e.filePath}:${e.startLine})`) };
    this.services.notify(sessionId);
    return { matched: info.screen.matched };
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

    // Turns are attributed to the speaker selected when the turn was committed locally (acknowledgements
    // can lag behind a speaker switch), and reach the engine in the order they were spoken: transcripts
    // for short turns often complete before longer, earlier ones.
    interface Turn {
      seq: number;
      itemId: string;
      speaker: string;
      text: string | null;
      done: boolean;
    }
    const turns: Turn[] = [];
    const early = new Map<string, string>();
    let delivering: Promise<void> = Promise.resolve();
    transcriber.setTag(speaker);

    const drain = () => {
      delivering = delivering.then(async () => {
        while (turns[0]?.done) {
          const t = turns.shift()!;
          if (!t.text) continue; // silence or a turn that never completed
          try {
            const { events } = await this.services.run(sessionId, (engine) => engine.ingest({ speaker: t.speaker, text: t.text!, externalId: `mic:${t.itemId}` }));
            const seg = events.find((e) => e.type === 'segment_added');
            info.segments++;
            conn.send({ type: 'final', text: t.text, speaker: t.speaker, segmentId: seg?.type === 'segment_added' ? seg.segment.id : null });
          } catch (err) {
            conn.send({ type: 'error', message: (err as Error).message });
          }
        }
      });
    };

    transcriber.on('committed', ({ itemId, seq, tag }) => {
      const turn: Turn = { seq, itemId, speaker: tag ?? 'Room', text: null, done: false };
      turns.push(turn);
      turns.sort((a, b) => a.seq - b.seq);
      if (early.has(itemId)) {
        turn.text = early.get(itemId)!;
        turn.done = true;
        early.delete(itemId);
        drain();
      }
      // Never let one lost transcript hold back everything said after it.
      setTimeout(() => {
        if (!turn.done) {
          turn.done = true;
          conn.send({ type: 'error', message: 'A turn was not transcribed in time and was skipped' });
          drain();
        }
      }, TURN_TIMEOUT_MS).unref();
    });
    transcriber.on('partial', ({ itemId, text }) => {
      const who = turns.find((t) => t.itemId === itemId)?.speaker ?? info.speaker ?? 'Room';
      info.partial = { speaker: who, text };
      conn.send({ type: 'partial', text, speaker: who });
      this.services.notify(sessionId);
    });
    transcriber.on('final', ({ itemId, text }) => {
      info.partial = null;
      const turn = turns.find((t) => t.itemId === itemId);
      if (!turn) return void early.set(itemId, text);
      turn.text = text;
      turn.done = true;
      drain();
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
      // Let turns still being transcribed land before reporting the capture as stopped.
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (turns.some((t) => !t.done) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await delivering;
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
          transcriber.setTag(info.speaker);
          this.services.notify(sessionId);
        }
        if (msg.type === 'stop') void finish().then(() => conn.close());
      },
      onClose: () => void finish(),
    };
  }
}
