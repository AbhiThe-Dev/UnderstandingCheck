import type { Segment, SessionState } from '@uc/core';

/** How far back a request may be and still count as what the meeting is discussing now. */
export const TOPIC_WINDOW_MS = 10 * 60_000;

export interface LatestRequest {
  text: string;
  participantId: string;
  /** How long before the latest line it was said. */
  agoMs: number;
}

/**
 * What the conversation is about right now: the most recent substantial request or proposal.
 * The engine's inferred feature is the first request-like sentence of the meeting and never changes,
 * so on a long call it goes stale; this follows the conversation instead. Short or vague lines
 * ("yeah, we should") are skipped, and nothing is returned once the last request is old.
 */
export function latestRequest(state: SessionState, segments: Segment[]): LatestRequest | null {
  const last = segments.at(-1);
  if (!last) return null;
  const at = new Map(segments.map((s) => [s.id, s.timestamp]));
  for (let i = state.claims.length - 1; i >= 0; i--) {
    const c = state.claims[i]!;
    const ts = at.get(c.segmentId);
    if (ts === undefined) continue;
    if (last.timestamp - ts > TOPIC_WINDOW_MS) return null;
    const substantial = c.terms.length >= 3 && c.text.split(/\s+/).length >= 6;
    if (substantial && (c.kinds.includes('requirement') || c.kinds.includes('proposal'))) {
      return { text: c.text, participantId: c.participantId, agoMs: last.timestamp - ts };
    }
  }
  return null;
}

/** Code currently on the shared screen (matched against the repository), if it was seen recently. */
export function onScreen(state: SessionState, segments: Segment[]) {
  const sc = state.screen;
  if (!sc) return [];
  const last = segments.at(-1)?.timestamp ?? 0;
  if (last - sc.at > TOPIC_WINDOW_MS) return [];
  return sc.evidenceIds.flatMap((id) => state.evidence.find((e) => e.id === id) ?? []);
}

export function agoLabel(ms: number) {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'just now' : `${min} min ago`;
}
