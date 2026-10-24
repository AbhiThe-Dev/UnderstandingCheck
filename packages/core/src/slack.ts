import type { SlackRef } from './types';

/** What output may show in place of a Slack message: never its text, and nothing identifying for private ones. */
export function slackPointer(ref: SlackRef): string {
  const d = new Date(Number(ref.ts) * 1000);
  const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (ref.private) return `Slack private conversation${day ? ` (${day})` : ''}`;
  return `Slack ${ref.channelLabel} (${[ref.authorName, day].filter(Boolean).join(', ')})`;
}
