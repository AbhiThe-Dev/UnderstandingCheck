import { describe, expect, it } from 'vitest';
import { emptyState, type Claim, type Segment } from '@uc/core';
import { latestRequest } from '../lib/topic';

const MIN = 60_000;

function meeting(lines: [atMin: number, kinds: Claim['kinds'], text: string][]) {
  const state = emptyState('s', 'c');
  const segments: Segment[] = lines.map(([at, , text], i) => ({ id: `s${i}`, index: i, participantId: 'p1', timestamp: at * MIN, text }));
  state.claims = lines.map(([, kinds, text], i) => ({
    id: `c${i}`,
    segmentId: `s${i}`,
    participantId: 'p1',
    kinds,
    text,
    terms: text.split(/\s+/).filter((w) => w.length > 3),
    polarity: 'neutral',
    provenance: 'explicit',
    ambiguousSpeaker: false,
  }));
  return { state, segments };
}

describe('what the meeting is discussing now', () => {
  it('follows the latest substantial request, not the first one', () => {
    const { state, segments } = meeting([
      [1, ['requirement'], 'then he should have the two factor codes somewhere'],
      [30, ['requirement'], 'what i want to know is how many people signed up this week'],
      [31, ['agreement'], 'yeah'],
    ]);
    expect(latestRequest(state, segments)).toMatchObject({ text: 'what i want to know is how many people signed up this week', agoMs: MIN });
  });

  it('skips short or vague lines', () => {
    const { state, segments } = meeting([
      [1, ['requirement'], 'admins need to be able to undo an approval'],
      [2, ['requirement'], 'we should, yes'],
    ]);
    expect(latestRequest(state, segments)?.text).toBe('admins need to be able to undo an approval');
  });

  it('shows nothing once the last request is more than ten minutes old', () => {
    const { state, segments } = meeting([
      [1, ['proposal'], 'let us move the onboarding emails into the worker queue'],
      [15, ['statement'], 'anyway how was everyone weekend'],
    ]);
    expect(latestRequest(state, segments)).toBeNull();
  });
});
