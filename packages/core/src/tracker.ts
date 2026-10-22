import type { Discrepancy, DiscrepancyStatus, Position } from './types';

/** Module 6 — Resolution Tracker primitives. */

export const TERMINAL_STATUSES: ReadonlySet<DiscrepancyStatus> = new Set(['resolved', 'dismissed', 'unresolved']);

export function isOpen(d: Discrepancy): boolean {
  return !TERMINAL_STATUSES.has(d.status);
}

export function setStatus(d: Discrepancy, status: DiscrepancyStatus, at: number, note: string): boolean {
  if (d.status === status) return false;
  d.status = status;
  d.history.push({ at, status, note });
  return true;
}

export function addPosition(d: Discrepancy, p: Position): void {
  d.positions.push(p);
}

/** Latest position per participant, ignoring inferred ones (inference never confirms anything). */
export function firmPositions(d: Discrepancy): Map<string, Position> {
  const out = new Map<string, Position>();
  for (const p of d.positions) {
    if (p.provenance === 'inferred') continue;
    out.set(p.participantId, p);
  }
  return out;
}

export type Consensus =
  | { state: 'agree'; interpretationId: string }
  | { state: 'differ'; byInterpretation: Record<string, string[]> }
  | { state: 'incomplete'; missing: string[]; leaning: string | null };

/**
 * Compare the independently established positions of the relevant participants.
 * Agreement requires every relevant participant to hold the same interpretation explicitly
 * (or via a private scenario answer); a single dissent is enough to establish a difference.
 */
export function consensus(d: Discrepancy, minParticipants = 2): Consensus {
  const firm = firmPositions(d);
  // Earlier recorded decisions ("prior:*") hold a position but cannot answer; people in the room can supersede them.
  const relevant = d.relevantParticipantIds.filter((id) => !isPriorRecord(id));
  const held = relevant.map((id) => firm.get(id)).filter((p): p is Position => Boolean(p));
  const byInterpretation: Record<string, string[]> = {};
  for (const p of held) (byInterpretation[p.interpretationId] ??= []).push(p.participantId);
  const distinct = Object.keys(byInterpretation);
  if (distinct.length > 1) return { state: 'differ', byInterpretation };
  const missing = relevant.filter((id) => !firm.has(id));
  // A decision held by one person is not shared understanding.
  if (missing.length === 0 && relevant.length >= minParticipants) {
    return { state: 'agree', interpretationId: distinct[0]! };
  }
  const priors = d.relevantParticipantIds.filter(isPriorRecord).map((id) => firm.get(id)).filter((p): p is Position => Boolean(p));
  const conflicting = priors.filter((p) => distinct.length === 1 && p.interpretationId !== distinct[0]);
  if (conflicting.length > 0) {
    for (const p of conflicting) (byInterpretation[p.interpretationId] ??= []).push(p.participantId);
    return { state: 'differ', byInterpretation };
  }
  return { state: 'incomplete', missing, leaning: distinct[0] ?? null };
}

export function isPriorRecord(participantId: string): boolean {
  return participantId.startsWith('prior:');
}

/** Participants whose expectation still has to be established independently. */
export function needsIndependentAnswer(d: Discrepancy): string[] {
  const firm = firmPositions(d);
  return d.relevantParticipantIds.filter((id) => !firm.has(id) && !isPriorRecord(id));
}
