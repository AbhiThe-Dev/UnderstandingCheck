'use client';

import Link from 'next/link';
import {
  Check,
  CircleCheck,
  CircleQuestionMark,
  CodeXml,
  Copy,
  Database,
  DollarSign,
  EyeOff,
  Handshake,
  KeyRound,
  Scale,
  Send,
  Swords,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { Clarification, Discrepancy, Participant } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/primitives';
import { CATEGORY_LABEL, STATUS_LABEL, cn } from '@/lib/utils';

export type Act = (discrepancyId: string, action: 'ask_now' | 'dismiss' | 'save_for_later' | 'restore' | 'mark_useful' | 'mark_not_useful') => Promise<void>;
export type Respond = (clarificationId: string, participantId: string, body: { interpretationId?: string; text?: string }) => Promise<void>;

/** One color and icon per kind of concern, so the kind reads at a glance during a call. */
const CATEGORY_STYLE: Record<Discrepancy['category'], { icon: LucideIcon; text: string; bar: string }> = {
  false_alignment: { icon: Handshake, text: 'text-violet-700 dark:text-violet-300', bar: 'bg-violet-500' },
  direct_disagreement: { icon: Swords, text: 'text-red-700 dark:text-red-300', bar: 'bg-red-500' },
  codebase_conflict: { icon: CodeXml, text: 'text-orange-700 dark:text-orange-300', bar: 'bg-orange-500' },
  hidden_assumption: { icon: EyeOff, text: 'text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
  missing_specification: { icon: CircleQuestionMark, text: 'text-sky-700 dark:text-sky-300', bar: 'bg-sky-500' },
};

const STATUS_STYLE: Partial<Record<Discrepancy['status'], string>> = {
  suggested: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  awaiting_response: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  different_expectations_confirmed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  resolution_proposed: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
};

const IMPACT_ICON: Record<Discrepancy['impact']['consequence'], LucideIcon> = {
  permission: KeyRound,
  financial: DollarSign,
  irreversible: TriangleAlert,
  external: Send,
  data: Database,
  business_rule: Scale,
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
  /** Repository URL, to link code references to GitHub. */
  htmlUrl?: string | null;
}) {
  const { d, clarifications, participants, sessionId } = props;
  const person = (id: string | null) => participants.find((p) => p.id === id);
  const name = (id: string | null) => person(id)?.displayName ?? 'Someone';
  const colorIndex = (id: string | null) => participants.findIndex((p) => p.id === id);
  const active = clarifications.filter((c) => c.confirmationStatus !== 'superseded');
  const surface = active.find((c) => c.purpose === 'surface_difference');
  const group = active.find((c) => c.purpose === 'group_question');
  const checks = active.filter((c) => c.purpose === 'private_check');
  const main = surface ?? group;
  const open = !['resolved', 'dismissed', 'unresolved'].includes(d.status);
  const style = CATEGORY_STYLE[d.category];
  const CategoryIcon = style.icon;
  const ImpactIcon = IMPACT_ICON[d.impact.consequence];
  const confirmedDifference = d.status === 'different_expectations_confirmed';

  // Who expects what, once people have said or answered something that shows it.
  const stances = d.interpretations
    .map((i) => ({ i, who: [...new Set(d.positions.filter((p) => p.interpretationId === i.id && p.provenance !== 'inferred').map((p) => p.participantId))] }))
    .filter((s) => s.who.length > 0);

  return (
    <article
      className={cn(
        'settle-in relative overflow-hidden rounded-xl border bg-[var(--color-surface)] shadow-sm',
        confirmedDifference ? 'border-red-300 dark:border-red-900' : 'border-[var(--color-line)]',
        !open && 'opacity-90',
      )}
      data-testid="suggestion"
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', style.bar)} aria-hidden />
      <div className="space-y-3 py-3.5 pr-4 pl-5">
        <header className="flex items-center justify-between gap-2">
          <span className={cn('flex items-center gap-1.5 text-xs font-semibold', style.text)}>
            <CategoryIcon className="size-3.5" aria-hidden />
            {CATEGORY_LABEL[d.category]}
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', STATUS_STYLE[d.status] ?? 'bg-[var(--color-canvas)] text-[var(--color-muted)]')}>
            {STATUS_LABEL[d.status]}
          </span>
        </header>

        <div>
          <h3 className="text-[15px] leading-snug font-semibold text-[var(--color-ink)]">{d.title}</h3>
          <Expandable text={d.description} />
        </div>

        {d.impact.explanation && (
          <p className="flex gap-2 text-[13px] leading-snug">
            <ImpactIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--color-muted)]" aria-hidden />
            <span>
              <span className="font-medium">Why it matters: </span>
              <span className="text-[var(--color-muted)]">{d.impact.explanation}</span>
            </span>
          </p>
        )}

        {main && open && <AskBlock question={main.question} context={main.scenario && main.purpose !== 'surface_difference' ? main.scenario : null} />}

        {stances.length > 0 && (
          <div className="space-y-1.5">
            <SectionLabel>Who expects what</SectionLabel>
            <ul className="space-y-1">
              {stances.map(({ i, who }) => (
                <li key={i.id} className="flex items-start gap-2 text-[13px]">
                  <span className="flex -space-x-1 pt-px">
                    {who.map((pid) => (
                      <Avatar key={pid} name={name(pid)} index={colorIndex(pid)} unknown={person(pid)?.ambiguous} className="size-5 ring-2 ring-[var(--color-surface)]" />
                    ))}
                  </span>
                  <span>
                    <span className="font-medium">{who.map(name).join(', ')}</span>
                    <span className="text-[var(--color-muted)]"> · {i.label}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {stances.length === 0 && surface?.scenario && <Callout tone="red">{surface.scenario}</Callout>}

        {open && checks.some((c) => c.responses.length === 0) && (
          <div className="space-y-2">
            <SectionLabel>Check privately</SectionLabel>
            {checks[0]?.scenario && <Callout>{checks[0].scenario}</Callout>}
            <p className="text-sm font-medium">{checks[0]?.question}</p>
            <div className="space-y-1.5">
              {checks.map((c) => (
                <PrivateCheck key={c.id} c={c} who={name(c.targetedParticipantId)} colorIndex={colorIndex(c.targetedParticipantId)} interpretations={d.interpretations} respond={props.respond} readOnly={props.readOnly} />
              ))}
            </div>
          </div>
        )}

        {d.codeRefs.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Code involved">
            {d.codeRefs.slice(0, 3).map((r) => (
              <li key={`${r.filePath}:${r.startLine}`} className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5" title={r.note}>
                <CodeLink htmlUrl={props.htmlUrl} r={r} className="font-mono text-[11px]" />
              </li>
            ))}
          </ul>
        )}

        {d.resolution && (
          <p className="flex gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Decided: {d.resolution.summary} <span className="opacity-70">({d.resolution.confirmedBy.map(name).join(', ')})</span>
            </span>
          </p>
        )}

        <footer className="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-line)] pt-3">
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
                  <Button size="sm" variant="ghost" className="px-1.5" onClick={() => props.act(d.id, 'mark_useful')} aria-label="Useful" title="Useful" data-testid="mark-useful">
                    <ThumbsUp className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="px-1.5" onClick={() => props.act(d.id, 'mark_not_useful')} aria-label="Not useful" title="Not useful">
                    <ThumbsDown className="size-3.5" />
                  </Button>
                </>
              )
            )}
          </span>
          <Link href={`/sessions/${sessionId}/d/${d.id}`} className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
            Evidence →
          </Link>
        </footer>
      </div>
    </article>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">{children}</div>;
}

function Callout({ children, tone }: { children: React.ReactNode; tone?: 'red' }) {
  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2 text-[13px] leading-relaxed',
        tone === 'red' ? 'bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-200' : 'bg-[var(--color-canvas)] text-[var(--color-muted)]',
      )}
    >
      {children}
    </p>
  );
}

/** Long explanations stay out of the way during a call: three lines, expandable. */
function Expandable({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 200;
  return (
    <div className="mt-1">
      <p className={cn('text-[13px] leading-relaxed text-[var(--color-muted)]', long && !more && 'line-clamp-3')}>{text}</p>
      {long && (
        <button className="mt-0.5 text-xs font-medium text-[var(--color-accent)] hover:underline" onClick={() => setMore((m) => !m)}>
          {more ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** The question to put to the group, worded to be read out as is. */
function AskBlock({ question, context }: { question: string; context: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(question).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="rounded-lg border border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)] px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-[var(--color-accent)] uppercase">Ask the group</span>
        <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-surface)]" aria-label="Copy question">
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {context && <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">{context}</p>}
      <p className="mt-1 text-[15px] leading-snug font-medium text-[var(--color-ink)]" data-testid="suggested-question">
        “{question}”
      </p>
    </div>
  );
}

function PrivateCheck(props: { c: Clarification; who: string; colorIndex: number; interpretations: Discrepancy['interpretations']; respond: Respond; readOnly: boolean }) {
  const { c } = props;
  const [busy, setBusy] = useState(false);
  const last = c.responses.at(-1);
  const answer = (key: 'yes' | 'no') => {
    const interpretationId = c.answerKey[key];
    setBusy(true);
    void props.respond(c.id, c.targetedParticipantId!, { interpretationId, text: key === 'yes' ? 'Yes' : 'No' }).finally(() => setBusy(false));
  };
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-1.5" data-testid={`check-${props.who}`}>
      <span className="flex items-center gap-2 text-[13px]">
        <Avatar name={props.who} index={props.colorIndex} />
        <span>
          Ask <strong className="font-semibold">{props.who}</strong>
        </span>
      </span>
      {last ? (
        <span className="rounded-full bg-[var(--color-canvas)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
          {props.interpretations.find((i) => i.id === last.interpretationId)?.label ?? 'unclear answer'}
        </span>
      ) : props.readOnly ? (
        <span className="text-xs text-[var(--color-muted)]">no answer</span>
      ) : (
        <span className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
          <button className="px-3 py-1 text-xs font-medium hover:bg-[var(--color-canvas)] disabled:opacity-50" disabled={busy || !c.answerKey.yes} onClick={() => answer('yes')}>
            Yes
          </button>
          <button className="border-l border-[var(--color-line)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-canvas)] disabled:opacity-50" disabled={busy || !c.answerKey.no} onClick={() => answer('no')}>
            No
          </button>
        </span>
      )}
    </div>
  );
}
