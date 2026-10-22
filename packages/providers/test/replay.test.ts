import type { TranscriptSegmentInput } from '@uc/core';
import { describe, expect, it } from 'vitest';
import { ReplayTranscriptSource } from '../src';

const SEGS: TranscriptSegmentInput[] = [
  { speaker: 'A', text: 'first', timestamp: 0 },
  { speaker: 'B', text: 'second', timestamp: 4000 },
  { speaker: 'A', text: 'third', timestamp: 10000 },
];

/** An instant sleep that keeps a virtual clock, so pacing can be asserted without waiting. */
function virtualClock() {
  const clock = { now: 0, sleep: async (ms: number) => void (clock.now += ms) };
  return clock;
}

describe('ReplayTranscriptSource', () => {
  it('paces segments by their timestamps, scaled by speed', async () => {
    const clock = virtualClock();
    const got: { text: string; at: number }[] = [];
    const src = new ReplayTranscriptSource(SEGS, { speed: 2, sleep: clock.sleep, tickMs: 10 });
    await src.start((s) => void got.push({ text: s.text, at: clock.now }));
    expect(got.map((g) => g.at)).toEqual([0, 2000, 5000]);
    expect(src.status).toBe('finished');
  });

  it('applies speed changes mid-replay', async () => {
    const clock = virtualClock();
    const src = new ReplayTranscriptSource(SEGS, { speed: 1, sleep: clock.sleep, tickMs: 10 });
    const at: number[] = [];
    await src.start((s) => {
      at.push(clock.now);
      if (s.text === 'second') src.setSpeed(3);
    });
    expect(at).toEqual([0, 4000, 6000]);
  });

  it('assigns unique externalIds and offsets timestamps to continue a meeting clock', async () => {
    const got: TranscriptSegmentInput[] = [];
    const src = new ReplayTranscriptSource([{ speaker: 'A', text: 'no timestamps here' }, { speaker: 'B', text: 'nor here' }], {
      speed: 50,
      sleep: async () => undefined,
      baseTimestampMs: 60_000,
      idPrefix: 'job7',
    });
    await src.start((s) => void got.push(s));
    expect(got.map((s) => s.externalId)).toEqual(['job7:0', 'job7:1']);
    expect(got[0]!.timestamp).toBe(60_000);
    expect(got[1]!.timestamp).toBeGreaterThan(60_000);
  });

  it('pauses, steps one segment at a time, resumes and stops', async () => {
    let ticks = 0;
    const got: string[] = [];
    const src = new ReplayTranscriptSource(SEGS, {
      speed: 1,
      paused: true,
      tickMs: 10,
      sleep: async () => {
        ticks++;
        if (ticks === 5) src.step(); // release "first" while paused
        if (ticks === 20) src.step(); // release "second" while still paused
        if (ticks === 30) void src.stop();
      },
    });
    await src.start((s) => void got.push(s.text));
    expect(got).toEqual(['first', 'second']);
    expect(src.status).toBe('stopped');
    expect(src.cursor).toBe(2);
  });

  it('reports failure when the consumer rejects a segment', async () => {
    const src = new ReplayTranscriptSource(SEGS, { speed: 50, sleep: async () => undefined });
    await src.start((s) => {
      if (s.text === 'second') throw new Error('Session has ended');
    });
    expect(src.status).toBe('failed');
    expect(src.error).toBe('Session has ended');
    expect(src.cursor).toBe(1);
  });
});
