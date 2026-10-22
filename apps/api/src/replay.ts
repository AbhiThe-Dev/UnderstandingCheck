import { parseTranscript } from '@uc/core';
import { ReplayTranscriptSource, type ReplayStatus } from '@uc/providers';
import type { HttpError as HttpErrorType, Services } from './services';

export interface ReplayInfo {
  jobId: string;
  status: ReplayStatus;
  /** Segments handed to the engine so far. */
  delivered: number;
  total: number;
  speed: number;
  error: string | null;
}

interface Job {
  id: string;
  source: ReplayTranscriptSource;
  delivered: number;
  text: string;
}

export type ReplayAction = 'pause' | 'resume' | 'step' | 'stop';

/**
 * Server-side transcript replay: simulates a live meeting by feeding segments into the same
 * serialized ingestion path a real transcription source uses, so every open viewer sees it live.
 */
export class ReplayManager {
  private jobs = new Map<string, Job>();
  private seq = 0;

  constructor(
    private services: Services,
    private makeError: (status: 404 | 409 | 422, message: string) => HttpErrorType,
  ) {}

  status(sessionId: string): ReplayInfo | null {
    const job = this.jobs.get(sessionId);
    if (!job) return null;
    return {
      jobId: job.id,
      status: job.source.status,
      delivered: job.delivered,
      total: job.source.total,
      speed: job.source.currentSpeed,
      error: job.source.error,
    };
  }

  private active(sessionId: string) {
    const job = this.jobs.get(sessionId);
    return job && (job.source.status === 'playing' || job.source.status === 'paused') ? job : null;
  }

  async start(sessionId: string, text: string, opts: { speed: number; paused?: boolean; force?: boolean }): Promise<ReplayInfo> {
    if (this.active(sessionId)) throw this.makeError(409, 'A replay is already running for this session; stop it first');
    const prev = this.jobs.get(sessionId);
    // Replaying the same finished transcript again would duplicate the meeting; require intent.
    if (!opts.force && prev?.source.status === 'finished' && prev.text.trim() === text.trim()) {
      throw this.makeError(409, 'This transcript was already replayed in this session. Load or edit a transcript to continue the meeting.');
    }
    const segments = parseTranscript(text);
    if (segments.length === 0) throw this.makeError(422, 'No "Speaker: text" lines found');
    const snap = await this.services.snapshot(sessionId);
    if (snap.status === 'ended') throw this.makeError(409, 'Session has ended');

    const last = snap.segments.at(-1);
    const id = `r${++this.seq}`;
    const source = new ReplayTranscriptSource(segments, {
      speed: opts.speed,
      paused: opts.paused,
      baseTimestampMs: last ? last.timestamp + 2000 : 0,
      idPrefix: `${id}-${Date.now().toString(36)}`,
    });
    const job: Job = { id, source, delivered: 0, text };
    this.jobs.set(sessionId, job);

    void source
      .start(async (seg) => {
        job.delivered++;
        try {
          await this.services.run(sessionId, (engine) => engine.ingest(seg));
        } catch (err) {
          job.delivered--;
          throw err;
        }
      })
      .finally(() => this.services.notify(sessionId));
    this.services.notify(sessionId);
    return this.status(sessionId)!;
  }

  control(sessionId: string, action: ReplayAction | null, speed?: number): ReplayInfo {
    const job = this.jobs.get(sessionId);
    if (!job) throw this.makeError(404, 'No replay for this session');
    if (speed !== undefined) job.source.setSpeed(speed);
    if (action === 'pause') job.source.pause();
    if (action === 'resume') job.source.resume();
    if (action === 'step') job.source.step();
    if (action === 'stop') void job.source.stop();
    this.services.notify(sessionId);
    return this.status(sessionId)!;
  }

  stop(sessionId: string) {
    void this.jobs.get(sessionId)?.source.stop();
  }

  forget(sessionId: string) {
    this.stop(sessionId);
    this.jobs.delete(sessionId);
  }
}
