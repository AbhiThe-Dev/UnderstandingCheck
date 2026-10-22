import type { Segment, SessionState } from './types';

export interface SessionMetrics {
  meetingDurationMs: number;
  segments: number;
  /** Detection & clarification quality */
  suggestions: number;
  suggestionsPerHour: number | null;
  revealedDifferenceRate: number | null;
  resolvedInMeetingRate: number | null;
  usefulRate: number | null;
  rated: number;
  duplicateCandidateRate: number | null;
  rejectedCandidates: number;
  /** User friction */
  dismissalRate: number | null;
  medianTimeToResolveMs: number | null;
  /** Pipeline */
  analysesRun: number;
  analysesSkipped: number;
  retrievals: number;
  retrievalCacheHits: number;
  duplicateSegments: number;
  latencyMs: { p50: number; p95: number; max: number } | null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

/**
 * Per-meeting metrics from the engine state. Optimizes for consequential misunderstandings found with
 * little interruption — so it reports dismissals and time-to-resolve alongside how many were raised.
 */
export function sessionMetrics(state: SessionState, segments: Segment[]): SessionMetrics {
  const duration = segments.length > 1 ? segments.at(-1)!.timestamp - segments[0]!.timestamp : 0;
  // History entries are stamped with a segment index; map them to meeting time.
  const tsAt = (index: number) => segments[Math.min(index, segments.length - 1)]?.timestamp ?? 0;

  const surfaced = state.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null);
  const resolved = surfaced.filter((d) => d.status === 'resolved');
  const rated = surfaced.filter((d) => d.feedback);
  const times = resolved
    .map((d) => {
      const done = [...d.history].reverse().find((h) => h.status === 'resolved');
      return done ? tsAt(done.at) - tsAt(d.surfacedAtSegmentIndex!) : null;
    })
    .filter((t): t is number => t !== null && t >= 0)
    .sort((a, b) => a - b);
  const lat = [...(state.metrics.latencyMs ?? [])].sort((a, b) => a - b);
  const m = state.metrics;

  return {
    meetingDurationMs: duration,
    segments: segments.length,
    suggestions: surfaced.length,
    suggestionsPerHour: duration > 0 ? surfaced.length / (duration / 3_600_000) : null,
    revealedDifferenceRate: ratio(surfaced.filter((d) => d.history.some((h) => h.status === 'different_expectations_confirmed')).length, surfaced.length),
    resolvedInMeetingRate: ratio(resolved.length, surfaced.length),
    usefulRate: ratio(rated.filter((d) => d.feedback === 'useful').length, rated.length),
    rated: rated.length,
    duplicateCandidateRate: ratio(m.duplicatesSuppressed, m.candidatesGenerated),
    rejectedCandidates: m.candidatesRejected,
    dismissalRate: ratio(surfaced.filter((d) => d.status === 'dismissed').length, surfaced.length),
    medianTimeToResolveMs: times.length ? percentile(times, 50) : null,
    analysesRun: m.analysesRun,
    analysesSkipped: m.analysesSkipped,
    retrievals: m.retrievals,
    retrievalCacheHits: m.retrievalCacheHits,
    duplicateSegments: m.duplicateSegments ?? 0,
    latencyMs: lat.length ? { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.at(-1)! } : null,
  };
}
