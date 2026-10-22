'use client';

import Link from 'next/link';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import type { Clarification, Discrepancy, Participant } from '@uc/core';
import { Badge, Button } from '@/components/ui/primitives';
import { CATEGORY_LABEL, STATUS_LABEL, cn } from '@/lib/utils';

export type Act = (discrepancyId: string, action: 'ask_now' | 'dismiss' | 'save_for_later' | 'restore' | 'mark_useful' | 'mark_not_useful') => Promise<void>;
export type Respond = (clarificationId: string, participantId: string, body: { interpretationId?: string; text?: string }) => Promise<void>;

const STATUS_TONE: Partial<Record<Discrepancy['status'], 'amber' | 'green' | 'red' | 'blue' | 'accent'>> = {
  suggested: 'accent',
  awaiting_response: 'blue',
  different_expectations_confirmed: 'red',
  resolution_proposed: 'amber',
  resolved: 'green',
};

export function SuggestionCard(props: {
  sessionId: string;
  d: Discrepancy;
  clarifications: Clarification[];
  participants: Participant[];
  act: Act;
  respond: Respond;
  readOnly: boolean;
  /** Rating stays possible after a concern settles, until the session ends. */
  canRate?: boolean;
}) {
  const { d, clarifications, participants, sessionId } = props;
  const name = (id: string | null) => participants.find((p) => p.id === id)?.displayName ?? 'Someone';
  const active = clarifications.filter((c) => c.confirmationStatus !== 'superseded');
  const surface = active.find((c) => c.purpose === 'surface_difference');
  const group = active.find((c) => c.purpose === 'group_question');
  const checks = active.filter((c) => c.purpose === 'private_check');
  const main = surface ?? group;
  const open = !['resolved', 'dismissed', 'unresolved'].includes(d.status);

  return (
    <article className={cn('settle-in rounded-lg border bg-[var(--color-surface)] p-3.5 text-sm', d.status === 'different_expectations_confirmed' ? 'border-red-300 dark:border-red-900' : 'border-[var(--color-line)]')} data-testid="suggestion">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{CATEGORY_LABEL[d.category]}</Badge>
        <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{STATUS_LABEL[d.status]}</Badge>
      </div>
      <h3 className="mt-2 font-medium leading-snug">{d.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">{d.description}</p>
      {d.codeRefs[0] && (
        <p className="mt-1.5 font-mono text-[11px] text-[var(--color-muted)]">
          {d.codeRefs[0].filePath}:{d.codeRefs[0].startLine}
        </p>
      )}

      {surface?.scenario && <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">{surface.scenario}</p>}

      {main && open && (
        <div className="mt-3 rounded-md bg-[var(--color-accent-soft)] px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-accent)]">Suggested question</div>
          {main.scenario && main.purpose !== 'surface_difference' && <p className="mt-1 text-xs text-[var(--color-muted)]">{main.scenario}</p>}
          <p className="mt-0.5 font-medium" data-testid="suggested-question">“{main.question}”</p>
        </div>
      )}

      {open && checks.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Private scenario check</div>
          {checks[0]?.scenario && <p className="text-xs text-[var(--color-muted)]">{checks[0].scenario}</p>}
          <p className="font-medium">{checks[0]?.question}</p>
          {checks.map((c) => (
            <PrivateCheck key={c.id} c={c} who={name(c.targetedParticipantId)} interpretations={d.interpretations} respond={props.respond} readOnly={props.readOnly} />
          ))}
        </div>
      )}

      {d.resolution && (
        <p className="mt-3 rounded bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          Decided: {d.resolution.summary} <span className="opacity-70">({d.resolution.confirmedBy.map(name).join(', ')})</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {open && !props.readOnly && d.status === 'suggested' && checks.length === 0 && (
          <Button size="sm" variant="primary" onClick={() => props.act(d.id, 'ask_now')}>
            Mark asked
          </Button>
        )}
        {open && !props.readOnly && d.visibility === 'live' && (
          <Button size="sm" onClick={() => props.act(d.id, 'save_for_later')}>
            Save for later
          </Button>
        )}
        {open && !props.readOnly && d.visibility === 'queued' && (
          <Button size="sm" onClick={() => props.act(d.id, 'restore')}>
            Show again
          </Button>
        )}
        {open && !props.readOnly && (
          <Button size="sm" variant="ghost" onClick={() => props.act(d.id, 'dismiss')}>
            Dismiss
          </Button>
        )}
        <span className="ml-auto flex items-center gap-0.5 text-[11px] text-[var(--color-muted)]" aria-label="Was this useful?">
          {d.feedback ? (
            <span data-testid="feedback-given">{d.feedback === 'useful' ? 'Marked useful' : 'Marked not useful'}</span>
          ) : (
            (props.canRate ?? !props.readOnly) && (
              <>
                Useful?
                <Button size="sm" variant="ghost" onClick={() => props.act(d.id, 'mark_useful')} aria-label="Useful" data-testid="mark-useful">
                  <ThumbsUp className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => props.act(d.id, 'mark_not_useful')} aria-label="Not useful">
                  <ThumbsDown className="size-3.5" />
                </Button>
              </>
            )
          )}
        </span>
        <Link href={`/sessions/${sessionId}/d/${d.id}`}>
          <Button size="sm" variant="ghost">
            Evidence →
          </Button>
        </Link>
      </div>
    </article>
  );
}

function PrivateCheck(props: { c: Clarification; who: string; interpretations: Discrepancy['interpretations']; respond: Respond; readOnly: boolean }) {
  const { c } = props;
  const [busy, setBusy] = useState(false);
  const last = c.responses.at(-1);
  const answer = (key: 'yes' | 'no') => {
    const interpretationId = c.answerKey[key];
    setBusy(true);
    void props.respond(c.id, c.targetedParticipantId!, { interpretationId, text: key === 'yes' ? 'Yes' : 'No' }).finally(() => setBusy(false));
  };
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-[var(--color-line)] px-2.5 py-1.5" data-testid={`check-${props.who}`}>
      <span className="text-xs">
        Ask <strong>{props.who}</strong>
      </span>
      {last ? (
        <span className="text-xs text-[var(--color-muted)]">
          answered: {props.interpretations.find((i) => i.id === last.interpretationId)?.label ?? 'unclear'}
        </span>
      ) : props.readOnly ? (
        <span className="text-xs text-[var(--color-muted)]">no answer</span>
      ) : (
        <span className="flex gap-1">
          <Button size="sm" disabled={busy || !c.answerKey.yes} onClick={() => answer('yes')}>
            Yes
          </Button>
          <Button size="sm" disabled={busy || !c.answerKey.no} onClick={() => answer('no')}>
            No
          </Button>
        </span>
      )}
    </div>
  );
}
