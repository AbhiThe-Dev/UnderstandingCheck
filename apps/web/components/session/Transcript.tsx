'use client';

import { useEffect, useRef } from 'react';
import type { Participant } from '@uc/core';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/primitives';
import type { SessionView } from '@/lib/api';
import { cn, formatTime } from '@/lib/utils';

/**
 * The conversation as speaker turns: consecutive lines from one person are grouped under their name,
 * and the newest line stays in view. `limit` shows only the most recent lines (side panel).
 */
export function Transcript(props: {
  segments: SessionView['segments'];
  participants: Participant[];
  partial?: { speaker: string; text: string } | null;
  limit?: number;
  className?: string;
  empty?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const shown = props.limit ? props.segments.slice(-props.limit) : props.segments;
  // Keep the newest line in view inside the transcript box only; never scroll the page away from the suggestions.
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }, [props.segments.length, props.partial?.text]);

  const who = (pid: string) => props.participants.find((p) => p.id === pid);
  const colorIndex = (name: string) => props.participants.findIndex((p) => p.displayName === name);
  const turns: { pid: string; lines: typeof shown }[] = [];
  for (const s of shown) {
    const last = turns.at(-1);
    if (last && last.pid === s.participantId) last.lines.push(s);
    else turns.push({ pid: s.participantId, lines: [s] });
  }

  return (
    <div ref={box} className={cn('space-y-3', props.className)} data-testid="transcript">
      {props.limit && props.segments.length > props.limit && (
        <p className="text-center text-[11px] text-[var(--color-muted)]">{props.segments.length - props.limit} earlier lines</p>
      )}
      {shown.length === 0 && !props.partial && props.empty}
      {turns.map((t) => {
        const p = who(t.pid);
        const name = p?.displayName ?? 'Unknown';
        return (
          <div key={t.lines[0]!.id} className="settle-in flex gap-2.5">
            <Avatar name={name} index={colorIndex(name)} unknown={p?.ambiguous} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold">{name}</span>
                {p?.ambiguous && (
                  <Badge tone="amber" title="The speaker could not be identified">
                    unattributed
                  </Badge>
                )}
                <span className="ml-auto font-mono text-[10px] text-[var(--color-muted)] tabular-nums">{formatTime(t.lines[0]!.timestamp)}</span>
              </div>
              {t.lines.map((s) => (
                <p key={s.id} className="text-sm leading-relaxed">
                  {s.text}
                </p>
              ))}
            </div>
          </div>
        );
      })}
      {props.partial && (
        <div className="flex gap-2.5 opacity-70" data-testid="partial-caption">
          <Avatar name={props.partial.speaker} index={colorIndex(props.partial.speaker)} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-semibold">{props.partial.speaker}</span>
            <p className="text-sm leading-relaxed italic">{props.partial.text}…</p>
          </div>
        </div>
      )}
    </div>
  );
}
