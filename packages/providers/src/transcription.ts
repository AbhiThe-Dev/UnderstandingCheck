import type { TranscriptSegmentInput } from '@uc/core';

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

/** Replays parsed segments with real-time pacing scaled by `speed` (2 = twice as fast). */
export class ReplayTranscriptSource implements TranscriptSource {
  readonly name = 'replay';
  private stopped = false;
  constructor(
    private segments: TranscriptSegmentInput[],
    private opts: { speed: number; defaultGapMs?: number; sleep?: (ms: number) => Promise<void> },
  ) {}

  async start(onSegment: (segment: TranscriptSegmentInput) => void | Promise<void>): Promise<void> {
    this.stopped = false;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let prev = 0;
    for (const [i, seg] of this.segments.entries()) {
      if (this.stopped) return;
      const ts = seg.timestamp ?? i * (this.opts.defaultGapMs ?? 3000);
      await sleep(Math.max(0, (ts - prev) / this.opts.speed));
      prev = ts;
      await onSegment({ ...seg, timestamp: ts });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
