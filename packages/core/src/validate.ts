import type { RawCandidate } from './ports';
import type { CodeEvidence, CodeRef, Quote, Segment } from './types';
import { normalizeForMatch, quoteAppearsIn } from './text';

export type ValidationResult =
  | { ok: true; quotes: Quote[]; codeRefs: CodeRef[] }
  | { ok: false; reason: string; detail: string };

/**
 * Hard gate between any analyzer (heuristic or model) and the user.
 * - every code citation must resolve to evidence actually retrieved at the session's commit,
 *   with line numbers inside that symbol's range;
 * - every quote must be a real substring of a real segment by the stated participant;
 * - a candidate must offer at least two interpretations that describe different behavior.
 * Candidates failing any check are dropped (never "repaired" into a claim the evidence does not support).
 */
export function validateCandidate(
  c: RawCandidate,
  evidence: CodeEvidence[],
  segments: Map<string, Segment>,
  commitSha: string,
): ValidationResult {
  const quotes: Quote[] = [];
  for (const q of c.quotes) {
    const seg = segments.get(q.segmentId);
    if (!seg) return { ok: false, reason: 'unknown_segment', detail: `quote cites missing segment ${q.segmentId}` };
    if (!quoteAppearsIn(q.quote.replace(/…$/, ''), seg.text)) {
      return { ok: false, reason: 'quote_not_found', detail: `"${q.quote}" is not in segment ${q.segmentId}` };
    }
    quotes.push({ segmentId: seg.id, participantId: seg.participantId, quote: q.quote });
  }
  if (quotes.length === 0 && c.category !== 'missing_specification') {
    return { ok: false, reason: 'no_conversation_evidence', detail: 'candidate has no supporting statements' };
  }

  const codeRefs: CodeRef[] = [];
  for (const r of c.codeRefs) {
    const ev = evidence.find((e) => e.id === r.evidenceId);
    if (!ev) return { ok: false, reason: 'unknown_evidence', detail: `cites ${r.evidenceId}, which was never retrieved` };
    if (ev.commitSha !== commitSha) return { ok: false, reason: 'stale_commit', detail: `${ev.filePath} is from ${ev.commitSha}` };
    if (!Number.isInteger(r.startLine) || !Number.isInteger(r.endLine) || r.startLine > r.endLine) {
      return { ok: false, reason: 'invalid_lines', detail: `${r.startLine}-${r.endLine}` };
    }
    if (r.startLine < ev.startLine || r.endLine > ev.endLine) {
      return {
        ok: false,
        reason: 'lines_out_of_range',
        detail: `${ev.filePath}:${r.startLine}-${r.endLine} outside ${ev.symbolName} (${ev.startLine}-${ev.endLine})`,
      };
    }
    codeRefs.push({
      evidenceId: ev.id,
      filePath: ev.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      commitSha: ev.commitSha,
      symbolName: ev.symbolName,
      note: r.note,
    });
  }
  if (['codebase_conflict', 'hidden_assumption'].includes(c.category) && codeRefs.length === 0) {
    return { ok: false, reason: 'no_code_evidence', detail: `${c.category} requires a code citation` };
  }

  if (c.interpretations.length < 2) {
    return { ok: false, reason: 'single_interpretation', detail: 'needs at least two plausible interpretations' };
  }
  const behaviors = new Set(c.interpretations.map((i) => normalizeForMatch(i.behavior)));
  if (behaviors.size < c.interpretations.length) {
    return { ok: false, reason: 'indistinct_interpretations', detail: 'interpretations describe the same behavior' };
  }
  return { ok: true, quotes, codeRefs };
}
