'use client';

import { useState } from 'react';
import { slackPointer, type SlackRef } from '@uc/core';

/** A Slack message the copilot used, linked by permalink. Slack itself decides who can open it. */
export function SlackLink({ r, note, className = 'text-xs' }: { r: SlackRef; note?: string; className?: string }) {
  return (
    <a
      href={r.permalink}
      target="_blank"
      rel="noreferrer"
      className={`${className} text-[var(--color-accent)] hover:underline`}
      title={[note, r.private ? 'Private conversation: only people in it can open the link' : 'Open in Slack'].filter(Boolean).join(' · ')}
      data-testid="slack-link"
    >
      {slackPointer(r)}
      {r.private && ' 🔒'}
    </a>
  );
}

/**
 * A Slack message with its excerpt (held in server memory, never stored). Excerpts from private
 * channels and DMs stay hidden until revealed, so a shared screen does not show them at a glance.
 */
export function SlackExcerpt({ r, text, note }: { r: SlackRef; text: string | undefined; note?: string }) {
  const [shown, setShown] = useState(!r.private);
  return (
    <div className="text-xs" data-testid="slack-excerpt">
      <SlackLink r={r} note={note} />
      {note && <span className="ml-1.5 text-[var(--color-muted)]">{note}</span>}
      {text === undefined ? (
        <p className="mt-0.5 text-[var(--color-muted)]">Excerpt not available (it is never stored; open the link to read it).</p>
      ) : shown ? (
        <p className="mt-0.5 whitespace-pre-wrap text-[var(--color-ink)]">{text}</p>
      ) : (
        <button type="button" className="mt-0.5 block text-[var(--color-muted)] underline" onClick={() => setShown(true)}>
          Show private message
        </button>
      )}
    </div>
  );
}
