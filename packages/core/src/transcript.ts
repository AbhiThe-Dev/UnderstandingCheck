import type { ParticipantRole, TranscriptSegmentInput } from './types';

const ROLE_ALIASES: [RegExp, ParticipantRole][] = [
  [/^(po|product owner|product manager|pm|product)$/i, 'product_owner'],
  [/^(dev|developer|engineer|eng|swe|tech lead|backend|frontend)$/i, 'developer'],
  [/^(qa|tester|quality)$/i, 'qa'],
  [/^(designer|design|ux|ui)$/i, 'designer'],
  [/^(stakeholder|support lead|support|ops|sales|manager|lead)$/i, 'stakeholder'],
];

export function parseRole(raw: string | undefined): ParticipantRole | undefined {
  if (!raw) return undefined;
  const r = raw.trim();
  return ROLE_ALIASES.find(([re]) => re.test(r))?.[1] ?? 'stakeholder';
}

/**
 * Parse a speaker-labeled transcript. Accepted line shapes:
 *   Priya (PO): We need a way to undo approvals.
 *   [00:01:05] Sam (Developer): I'll set the status back to pending.
 *   Sam: Sounds good.
 * Lines without a speaker label are appended to the previous segment.
 */
export function parseTranscript(text: string): TranscriptSegmentInput[] {
  const out: TranscriptSegmentInput[] = [];
  const LINE = /^\s*(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?([^:()[\]]{1,40}?)\s*(?:\(([^)]{1,30})\))?\s*:\s*(.+)$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(LINE);
    if (!m) {
      const prev = out.at(-1);
      if (prev) prev.text = `${prev.text} ${line}`;
      continue;
    }
    const [, a, b, c, speaker, role, body] = m;
    let timestamp: number | undefined;
    if (a && b) {
      timestamp = c ? (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000 : (Number(a) * 60 + Number(b)) * 1000;
    }
    out.push({ speaker: speaker!.trim(), role: parseRole(role), text: body!.trim(), ...(timestamp !== undefined ? { timestamp } : {}) });
  }
  return out;
}

/**
 * Roughly how long it takes to say a segment, for pacing replays when the transcript has no
 * timestamps: ~45 ms per character, clamped to 0.8–4 s.
 */
export function speechGapMs(text: string): number {
  return Math.min(4000, Math.max(800, text.length * 45));
}
