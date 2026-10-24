import { slackPointer } from './slack';
import type { CodeRef, Discrepancy, Requirement, SessionState, SlackCitation } from './types';

export interface MeetingSummary {
  feature: string;
  agreedChanges: { requirement: Requirement; confirmedBy: string[]; how: string }[];
  unconfirmedProposals: Requirement[];
  existingBehavior: string[];
  resolvedMisunderstandings: { discrepancy: Discrepancy; resolution: string; hadDifferentExpectations: boolean }[];
  openQuestions: { text: string; discrepancyId: string | null }[];
  codeRefs: CodeRef[];
  /** Slack messages the meeting's concerns cited (links only). */
  slackRefs: SlackCitation[];
  acceptanceCriteria: string[];
  disclaimer: string;
}

const DISCLAIMER =
  'This summary records what participants confirmed during the discussion. It does not guarantee that an implementation will match it.';

export function buildSummary(state: SessionState): MeetingSummary {
  const name = (id: string) => state.participants.find((p) => p.id === id)?.displayName ?? id;
  const current = state.requirements.filter((r) => r.status !== 'superseded');
  const confirmed = current.filter((r) => r.status === 'confirmed');

  const resolved = state.discrepancies
    .filter((d) => d.status === 'resolved' && d.resolution && d.surfacedAtSegmentIndex !== null)
    .map((d) => ({
      discrepancy: d,
      resolution: d.resolution!.summary,
      hadDifferentExpectations: d.history.some((h) => h.status === 'different_expectations_confirmed'),
    }));

  const openFromDiscrepancies = state.discrepancies
    .filter((d) => (d.status === 'unresolved' || (!['resolved', 'dismissed'].includes(d.status) && d.visibility !== 'hidden')) && !state.openQuestions.some((q) => q.discrepancyId === d.id))
    .map((d) => ({
      text: state.clarifications.find((c) => c.discrepancyId === d.id && c.confirmationStatus !== 'superseded')?.question ?? d.title,
      discrepancyId: d.id,
    }));

  const refs = new Map<string, CodeRef>();
  for (const d of state.discrepancies) {
    if (d.status === 'dismissed' || d.visibility === 'hidden') continue;
    for (const r of d.codeRefs) refs.set(`${r.filePath}:${r.startLine}`, r);
  }
  const slack = new Map<string, SlackCitation>();
  for (const d of state.discrepancies) {
    if (d.status === 'dismissed' || d.visibility === 'hidden') continue;
    for (const r of d.slackRefs ?? []) slack.set(r.permalink, r);
  }

  return {
    feature: state.feature.description || '(not stated)',
    agreedChanges: confirmed.map((r) => ({
      requirement: r,
      confirmedBy: r.confirmedBy.map(name),
      how: r.confirmation === 'clarified' ? 'confirmed through clarification' : 'verbal agreement',
    })),
    unconfirmedProposals: current.filter((r) => r.status === 'proposed'),
    existingBehavior: state.existingBehavior.map((b) => b.description),
    resolvedMisunderstandings: resolved,
    openQuestions: [...state.openQuestions.map((q) => ({ text: q.text, discrepancyId: q.discrepancyId })), ...openFromDiscrepancies],
    codeRefs: [...refs.values()],
    slackRefs: [...slack.values()],
    acceptanceCriteria: confirmed.flatMap((r) => r.acceptanceCriteria),
    disclaimer: DISCLAIMER,
  };
}

/** GitHub-issue-flavored markdown, ready to paste into an issue. */
export function summaryToMarkdown(s: MeetingSummary, opts: { repoUrl?: string; commitSha?: string } = {}): string {
  const link = (r: CodeRef) =>
    opts.repoUrl ? `[\`${r.filePath}:${r.startLine}\`](${opts.repoUrl}/blob/${r.commitSha}/${r.filePath}#L${r.startLine})` : `\`${r.filePath}:${r.startLine}\``;
  const lines: string[] = [];
  lines.push(`## Agreed behavior: ${s.feature}`, '');
  lines.push('### Agreed behavior changes');
  if (s.agreedChanges.length === 0) lines.push('_None confirmed._');
  for (const a of s.agreedChanges) {
    lines.push(`- ${a.requirement.description} _(v${a.requirement.version}, ${a.how}; ${a.confirmedBy.join(', ')})_`);
  }
  if (s.unconfirmedProposals.length) {
    lines.push('', '### Proposed but not confirmed');
    for (const r of s.unconfirmedProposals) lines.push(`- ${r.description}`);
  }
  lines.push('', '### Relevant existing behavior');
  if (s.existingBehavior.length === 0) lines.push('_No relevant code located._');
  for (const b of s.existingBehavior) lines.push(`- ${b}`);
  lines.push('', '### Resolved misunderstandings');
  if (s.resolvedMisunderstandings.length === 0) lines.push('_None._');
  for (const m of s.resolvedMisunderstandings) {
    lines.push(`- **${m.discrepancy.title}** → ${m.resolution}${m.hadDifferentExpectations ? ' _(participants initially expected different behavior)_' : ''}`);
  }
  lines.push('', '### Open questions');
  if (s.openQuestions.length === 0) lines.push('_None._');
  for (const q of s.openQuestions) lines.push(`- [ ] ${q.text}`);
  lines.push('', '### Affected code');
  if (s.codeRefs.length === 0) lines.push('_None._');
  for (const r of s.codeRefs) lines.push(`- ${link(r)} — ${r.note}`);
  if (s.slackRefs.length) {
    lines.push('', '### Slack discussion');
    for (const r of s.slackRefs) lines.push(`- [${slackPointer(r)}](${r.permalink}) — ${r.note}`);
  }
  lines.push('', '### Suggested acceptance criteria');
  if (s.acceptanceCriteria.length === 0) lines.push('_None yet._');
  for (const c of s.acceptanceCriteria) lines.push(`- [ ] ${c}`);
  lines.push('', `> ${s.disclaimer}`);
  if (opts.commitSha) {
    const short = opts.commitSha.startsWith('content-') ? opts.commitSha.slice(0, 20) : opts.commitSha.slice(0, 12);
    lines.push(`> Code references are at commit \`${short}\`.`);
  }
  return lines.join('\n');
}
