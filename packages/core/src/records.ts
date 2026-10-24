import type { CodeRef, Requirement, SessionState, SlackCitation } from './types';
import { truncate } from './text';

export interface RecordEvidence {
  speaker: string;
  text: string;
  kind: 'statement' | 'scenario_answer';
}

/** A confirmed requirement from one session, ready to become (or extend) a durable record. */
export interface RecordDraft {
  requirementId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  codeRefs: CodeRef[];
  /** Links to Slack messages behind the decision (never their text). */
  slackRefs: SlackCitation[];
  confirmation: Requirement['confirmation'];
  confirmedBy: string[];
  evidence: RecordEvidence[];
  /** The concern that led to this decision, if it came from a clarification. */
  concern: string | null;
  /** Earlier record this decision replaces or reaffirms. */
  priorRecord: { id: string; outcome: 'supersedes' | 'reaffirms' } | null;
  /** The decision changed during the meeting before it settled. */
  revisedInMeeting: boolean;
}

/**
 * Only confirmed, current decisions become records — proposals and decisions superseded later in
 * the same meeting do not. Evidence keeps speaker names (not session-local ids) so the record
 * stays readable after the session is gone.
 */
export function recordDrafts(state: SessionState): RecordDraft[] {
  const name = (id: string) => state.participants.find((p) => p.id === id)?.displayName ?? 'Unknown';
  return state.requirements
    .filter((r) => r.status === 'confirmed')
    .map((r) => {
      const d = r.discrepancyId ? state.discrepancies.find((x) => x.id === r.discrepancyId) : undefined;
      const label = d?.resolution ? d.interpretations.find((i) => i.id === d.resolution!.interpretationId)?.label : undefined;
      const feature = state.feature.description;
      return {
        requirementId: r.id,
        // A disagreement's winning side is already a plain statement of the requirement.
        title: label && d!.meta.kind !== 'disagreement' ? truncate(`${feature || d!.title}: ${label}`, 120) : truncate(r.description, 120),
        description: r.description,
        acceptanceCriteria: r.acceptanceCriteria,
        codeRefs: r.codeRefs,
        slackRefs: r.slackRefs ?? [],
        confirmation: r.confirmation,
        confirmedBy: r.confirmedBy.filter((id) => !id.startsWith('prior:')).map(name),
        evidence: r.evidence
          .filter((e) => !e.participantId.startsWith('prior:'))
          .map((e) => ({ speaker: name(e.participantId), text: e.text, kind: e.clarificationId ? 'scenario_answer' : 'statement' })),
        concern: d?.title ?? null,
        priorRecord: r.priorRecord ?? null,
        revisedInMeeting: d?.history.some((h) => /changed/.test(h.note)) ?? false,
      };
    });
}

/** Word-level diff between two versions of a requirement, for the version history view. */
export function wordDiff(before: string, after: string): { op: 'same' | 'add' | 'del'; text: string }[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  // Longest common subsequence over tokens; requirement texts are short, so O(n·m) is fine.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { op: 'same' | 'add' | 'del'; text: string }[] = [];
  const push = (op: 'same' | 'add' | 'del', text: string) => {
    const last = out.at(-1);
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push('del', a[i++]!);
    else push('add', b[j++]!);
  }
  while (i < a.length) push('del', a[i++]!);
  while (j < b.length) push('add', b[j++]!);
  return out;
}
