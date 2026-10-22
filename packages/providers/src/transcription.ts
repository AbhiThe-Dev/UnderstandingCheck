import { speechGapMs, type TranscriptSegmentInput } from '@uc/core';

/**
 * Boundary for anything that produces speaker-labeled transcript segments: replayed files today,
 * real-time transcription (e.g. OpenAI) or botless meeting capture (e.g. Recall.ai Desktop SDK) later.
 * The analysis engine only ever sees `TranscriptSegmentInput`, so sources can change without touching it.
 */
export interface TranscriptSource {
  readonly name: string;
  start(onSegment: (segment: TranscriptSegmentInput) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'finished' | 'stopped' | 'failed';

export interface ReplayOptions {
  speed: number;
  /** Start paused (useful for stepping through a transcript one turn at a time). */
  paused?: boolean;
  /** Added to every timestamp, so a replay appended to a running meeting continues its clock. */
  baseTimestampMs?: number;
  /** Prefix for generated externalIds; must be unique per replay within a session. */
  idPrefix?: string;
  /** Pacing granularity; tests inject an instant sleep. */
  tickMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 50;

/**
 * Replays a transcript as if it were arriving live: segments are paced by their timestamps
 * (or by how long they take to say), scaled by `speed`, which can change mid-replay.
 * Each segment gets a stable externalId so a restarted replay never ingests a turn twice.
 */
export class ReplayTranscriptSource implements TranscriptSource {
  readonly name = 'replay';
  status: ReplayStatus = 'idle';
  cursor = 0;
  error: string | null = null;
  private speed: number;
  private stepRequested = false;
  private readonly tickMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly segments: TranscriptSegmentInput[],
    private readonly opts: ReplayOptions,
  ) {
    this.speed = clampSpeed(opts.speed);
    this.tickMs = opts.tickMs ?? 50;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.paused) this.status = 'paused';
  }

  get total() {
    return this.segments.length;
  }

  get currentSpeed() {
    return this.speed;
  }

  setSpeed(speed: number) {
    this.speed = clampSpeed(speed);
  }

  pause() {
    if (this.status === 'playing') this.status = 'paused';
  }

  resume() {
    if (this.status === 'paused') this.status = 'playing';
  }

  /** While paused, release exactly one segment without waiting. */
  step() {
    if (this.status === 'paused') this.stepRequested = true;
  }

  async stop() {
    if (this.status === 'playing' || this.status === 'paused' || this.status === 'idle') this.status = 'stopped';
  }

  /** Wall-clock gap before segment `i`, at speed 1. */
  private gapBefore(i: number): number {
    if (i === 0) return 0;
    const prev = this.segments[i - 1]!;
    const cur = this.segments[i]!;
    if (prev.timestamp !== undefined && cur.timestamp !== undefined) return Math.max(0, cur.timestamp - prev.timestamp);
    return speechGapMs(cur.text);
  }

  async start(onSegment: (segment: TranscriptSegmentInput) => void | Promise<void>): Promise<void> {
    if (this.status === 'idle') this.status = 'playing';
    let clock = this.segments.slice(0, this.cursor).reduce((t, _s, i) => t + this.gapBefore(i), 0);
    while (this.cursor < this.segments.length) {
      const gap = this.gapBefore(this.cursor);
      let waited = 0;
      // Advance in small ticks so pause, stop and speed changes take effect promptly.
      while (waited < gap || this.status === 'paused') {
        if (this.status === 'stopped') return;
        if (this.status === 'paused') {
          if (this.stepRequested) break;
          await this.sleep(this.tickMs);
          continue;
        }
        await this.sleep(this.tickMs);
        waited += this.tickMs * this.speed;
      }
      if (this.status === 'stopped') return;
      this.stepRequested = false;
      clock += gap;
      const seg = this.segments[this.cursor]!;
      try {
        await onSegment({
          ...seg,
          timestamp: (seg.timestamp ?? clock) + (this.opts.baseTimestampMs ?? 0),
          externalId: seg.externalId ?? `${this.opts.idPrefix ?? 'replay'}:${this.cursor}`,
        });
      } catch (err) {
        this.status = 'failed';
        this.error = (err as Error).message;
        return;
      }
      this.cursor++;
    }
    this.status = 'finished';
  }
}

function clampSpeed(n: number) {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(n) ? n : 1));
}
