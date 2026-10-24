import { slackPointer, type CodeRef, type SlackCitation } from '@uc/core';
import { recordLabel, type RecordRow, type VersionRow } from '@uc/db';

export interface RecordWithVersions {
  record: RecordRow;
  versions: VersionRow[];
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Plain Markdown for a set of requirement records (local download; no external service involved). */
export function recordsToMarkdown(items: RecordWithVersions[], opts: { history: boolean }): string {
  const lines = ['# Agreed requirements', '', `_Exported ${day(new Date())}. Records describe what participants confirmed; they do not guarantee an implementation matches._`, ''];
  for (const { record, versions } of items) {
    const current = versions.find((v) => v.version === record.currentVersion) ?? versions.at(-1)!;
    lines.push(`## ${recordLabel(record)} — ${record.title}`, '');
    lines.push(`**Status:** ${record.status}${record.retiredReason ? ` (${record.retiredReason})` : ''} · **Version:** v${record.currentVersion} · **Last confirmed:** ${day(record.lastConfirmedAt)}`, '');
    lines.push(current.description, '');
    if (current.acceptanceCriteria.length) {
      lines.push('**Acceptance criteria**');
      for (const c of current.acceptanceCriteria) lines.push(`- [ ] ${c}`);
      lines.push('');
    }
    const refs = current.codeRefs as CodeRef[];
    if (refs.length) {
      lines.push('**Code**');
      for (const r of refs) lines.push(`- \`${r.filePath}:${r.startLine}\` @ \`${r.commitSha.slice(0, 20)}\` — ${r.note}`);
      lines.push('');
    }
    const slack = (current.slackRefs ?? []) as SlackCitation[];
    if (slack.length) {
      lines.push('**Slack**');
      for (const r of slack) lines.push(`- [${slackPointer(r)}](${r.permalink}) — ${r.note}`);
      lines.push('');
    }
    lines.push(`Confirmed by ${current.confirmedBy.join(', ') || '—'} (${current.confirmation}) in “${current.sessionTitle}”.`, '');
    if (opts.history && versions.length > 1) {
      lines.push('**History**');
      for (const v of [...versions].reverse()) lines.push(`- v${v.version} (${day(v.createdAt)}, ${v.origin}): ${v.description}`);
      lines.push('');
    }
    if (record.reaffirmations.length) {
      lines.push(`Reaffirmed ${record.reaffirmations.length}× — last in “${record.reaffirmations.at(-1)!.sessionTitle}”.`, '');
    }
  }
  return lines.join('\n');
}
