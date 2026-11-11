'use client';

import { BookOpen, ChevronDown, CircleCheck, Gauge, GitCompareArrows, Lightbulb, LoaderCircle, Network, RefreshCw, ShieldAlert, ThumbsDown, ThumbsUp, Wrench, X, Zap, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { DecisionFinding, QualityDimension, Segment, SessionState, TechnicalDecision } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { SlackLink } from '@/components/SlackLink';
import { AskBlock } from '@/components/session/SuggestionCard';
import { Button } from '@/components/ui/primitives';
import { api, type SessionView } from '@/lib/api';
import { cn } from '@/lib/utils';

type FindingAction = 'dismiss' | 'restore' | 'mark_useful' | 'mark_not_useful';

/** One icon and color per quality, so the kind of risk reads at a glance during a call. */
const DIMENSION_STYLE: Record<QualityDimension, { label: string; icon: LucideIcon; text: string; bar: string }> = {
  performance: { label: 'Performance', icon: Zap, text: 'text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
  scalability: { label: 'Scalability', icon: Gauge, text: 'text-orange-700 dark:text-orange-300', bar: 'bg-orange-500' },
  reliability: { label: 'Reliability', icon: Network, text: 'text-sky-700 dark:text-sky-300', bar: 'bg-sky-500' },
  security: { label: 'Security', icon: ShieldAlert, text: 'text-red-700 dark:text-red-300', bar: 'bg-red-500' },
  maintainability: { label: 'Maintainability', icon: Wrench, text: 'text-teal-700 dark:text-teal-300', bar: 'bg-teal-500' },
  compatibility: { label: 'Compatibility', icon: GitCompareArrows, text: 'text-violet-700 dark:text-violet-300', bar: 'bg-violet-500' },
};

const KIND_LABEL: Record<DecisionFinding['kind'], string> = {
  risk: 'risk',
  overlooked_dependency: 'overlooked dependency',
  better_alternative: 'better option exists',
};

/** Live findings about technical decisions, for the suggestions list. Each decision shows at most one. */
export function liveDecisionFindings(state: SessionState): { d: TechnicalDecision; f: DecisionFinding }[] {
  return (state.decisions ?? []).flatMap((d) => d.findings.filter((f) => f.visibility === 'live').map((f) => ({ d, f })));
}

export function useDecisionActions(sessionId: string, apply: (v: SessionView) => void) {
  return {
    act: async (d: TechnicalDecision, f: DecisionFinding, action: FindingAction) =>
      apply(await api<SessionView>(`/api/sessions/${sessionId}/decisions/${d.id}/findings/${f.id}/actions`, { body: { action } })),
    reevaluate: async (d: TechnicalDecision) => apply(await api<SessionView>(`/api/sessions/${sessionId}/decisions/${d.id}/evaluate`, { method: 'POST' })),
    dismiss: async (d: TechnicalDecision) => apply(await api<SessionView>(`/api/sessions/${sessionId}/decisions/${d.id}/dismiss`, { method: 'POST' })),
  };
}

/**
 * A consequence of a decision the team just adopted, shown privately: what was decided, what would go
 * wrong, the code, docs or Slack it rests on, and one sentence to raise it.
 */
export function DecisionCard(props: {
  d: TechnicalDecision;
  f: DecisionFinding;
  segments: Segment[];
  htmlUrl?: string | null;
  readOnly: boolean;
  act: (action: FindingAction) => Promise<void>;
  onReevaluate?: () => void;
}) {
  const { d, f, htmlUrl } = props;
  const style = DIMENSION_STYLE[f.dimension];
  const Icon = style.icon;
  const moved = d.newSegmentIds.length > 0;
  return (
    <article className="settle-in relative overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-sm" data-testid="decision-finding">
      <span className={cn('absolute inset-y-0 left-0 w-1', style.bar)} aria-hidden />
      <div className="space-y-3 py-3.5 pr-4 pl-5">
        <header className="flex items-center justify-between gap-2">
          <span className={cn('flex items-center gap-1.5 text-xs font-semibold', style.text)}>
            <Icon className="size-3.5" aria-hidden />
            {style.label} {KIND_LABEL[f.kind]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
              f.severity === 'high' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
            )}
          >
            Decision check · {f.severity}
          </span>
        </header>

        <p className="text-xs leading-snug text-[var(--color-muted)]" data-testid="decision-summary">
          Decided: {d.summary}
        </p>

        <div>
          <h3 className="text-[15px] leading-snug font-semibold text-[var(--color-ink)]">{f.title}</h3>
          <p className="mt-1 text-[13px] leading-snug text-[var(--color-muted)]">{f.impact}</p>
        </div>

        {f.alternative && (
          <p className="flex gap-2 rounded-lg bg-[var(--color-canvas)] px-3 py-2 text-[13px] leading-snug">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-[var(--color-muted)]" aria-hidden />
            <span>
              <span className="font-medium">Better option: </span>
              {f.alternative}
            </span>
          </p>
        )}

        {f.ask && !props.readOnly && <AskBlock question={f.ask} context={null} label="Raise it" />}

        <Evidence f={f} htmlUrl={htmlUrl} />

        {moved && (
          <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            The discussion has moved on since this was checked.
            {props.onReevaluate && !props.readOnly && (
              <button className="flex items-center gap-1 font-medium text-[var(--color-accent)] hover:underline" onClick={props.onReevaluate}>
                <RefreshCw className="size-3" aria-hidden /> Check again
              </button>
            )}
          </p>
        )}

        <footer className="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-line)] pt-3">
          {!props.readOnly && (
            <Button size="sm" variant="ghost" onClick={() => props.act('dismiss')} data-testid="dismiss-finding">
              Dismiss
            </Button>
          )}
          <span className="ml-auto flex items-center gap-0.5 text-[11px] text-[var(--color-muted)]" aria-label="Was this useful?">
            {f.feedback ? (
              <span>{f.feedback === 'useful' ? 'Marked useful' : 'Marked not useful'}</span>
            ) : (
              !props.readOnly && (
                <>
                  <Button size="sm" variant="ghost" className="px-1.5" onClick={() => props.act('mark_useful')} aria-label="Useful" title="Useful">
                    <ThumbsUp className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="px-1.5" onClick={() => props.act('mark_not_useful')} aria-label="Not useful" title="Not useful">
                    <ThumbsDown className="size-3.5" />
                  </Button>
                </>
              )
            )}
          </span>
        </footer>
      </div>
    </article>
  );
}

function Evidence({ f, htmlUrl }: { f: DecisionFinding; htmlUrl?: string | null }) {
  if (f.refs.length === 0 && f.slackRefs.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Evidence">
      {f.refs.slice(0, 4).map((r) => (
        <li key={`${r.evidenceId}:${r.startLine}`} className="flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5" title={r.note}>
          {/\.mdx?$/i.test(r.filePath) && <BookOpen className="size-3 text-[var(--color-muted)]" aria-label="Documentation" />}
          <CodeLink htmlUrl={htmlUrl} r={r} className="font-mono text-[11px]" />
        </li>
      ))}
      {f.slackRefs.slice(0, 2).map((r) => (
        <li key={r.id} className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5">
          <SlackLink r={r} note={r.note} className="text-[11px]" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Every technical decision the copilot tracked, quietly: being checked, fine, noted findings that did
 * not interrupt, turned down, or not checkable. Collapsed by default; nothing here interrupts.
 */
export function DecisionLog(props: { sessionId: string; state: SessionState; segments: Segment[]; ended: boolean; htmlUrl?: string | null; apply: (v: SessionView) => void; defaultOpen?: boolean }) {
  const { state, ended, htmlUrl } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [error, setError] = useState<string | null>(null);
  const actions = useDecisionActions(props.sessionId, props.apply);
  const decisions = (state.decisions ?? []).filter((d) => d.status !== 'dismissed');
  if (decisions.length === 0) return null;
  const checking = decisions.filter((d) => d.status === 'evaluating' || d.status === 'adopted').length;
  const guard = (fn: () => Promise<void>) => () => {
    setError(null);
    fn().catch((e: Error) => setError(e.message));
  };
  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3" data-testid="decision-log" aria-label="Technical decisions">
      <button className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={cn('size-3.5 text-[var(--color-muted)] transition-transform', !open && '-rotate-90')} aria-hidden />
        <h2 className="text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">Technical decisions ({decisions.length})</h2>
        {checking > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> checking {checking}
          </span>
        )}
      </button>
      {open && (
        <ul className="mt-2.5 space-y-3">
          {decisions.map((d) => (
            <li key={d.id} className="space-y-1.5 text-[13px]" data-testid="decision-entry">
              <div className="flex items-start gap-2">
                <StatusDot d={d} />
                <div className="min-w-0 flex-1">
                  <p className={cn('leading-snug', d.status === 'rejected' && 'text-[var(--color-muted)] line-through')}>{d.summary}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                    {statusLabel(d)}
                    {d.topics.length > 0 && ` · ${d.topics.join(', ')}`}
                    {d.usage.calls > 0 && ` · ${d.usage.calls} model call${d.usage.calls === 1 ? '' : 's'}, ~$${d.usage.costUsd.toFixed(4)}`}
                  </p>
                  {d.verdict && <p className="mt-1 text-xs text-[var(--color-muted)]">{d.verdict}</p>}
                  {d.error && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{d.error}</p>}
                </div>
                {!ended && ['evaluated', 'skipped', 'failed'].includes(d.status) && (
                  <button className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]" onClick={guard(() => actions.reevaluate(d))} title="Check again with the latest discussion" aria-label="Check again">
                    <RefreshCw className="size-3.5" />
                  </button>
                )}
                {!ended && (
                  <button className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]" onClick={guard(() => actions.dismiss(d))} title="Not a decision worth tracking" aria-label="Dismiss decision">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              {d.findings
                .filter((f) => f.visibility === 'noted')
                .map((f) => (
                  <div key={f.id} className="ml-4 space-y-1 border-l-2 border-[var(--color-line)] pl-3" data-testid="noted-finding">
                    <p className={cn('text-xs font-semibold', DIMENSION_STYLE[f.dimension].text)}>
                      {DIMENSION_STYLE[f.dimension].label} {KIND_LABEL[f.kind]} · {f.severity}
                    </p>
                    <p className="text-[13px] leading-snug font-medium">{f.title}</p>
                    <p className="text-xs leading-snug text-[var(--color-muted)]">{f.impact}</p>
                    {f.alternative && <p className="text-xs leading-snug">Better option: {f.alternative}</p>}
                    <Evidence f={f} htmlUrl={htmlUrl} />
                    {!ended && (
                      <button className="text-xs font-medium text-[var(--color-accent)] hover:underline" onClick={guard(() => actions.act(d, f, 'restore'))}>
                        Show as a suggestion
                      </button>
                    )}
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}

function StatusDot({ d }: { d: TechnicalDecision }) {
  if (d.status === 'evaluating' || d.status === 'adopted') return <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-[var(--color-muted)]" aria-hidden />;
  if (d.status === 'evaluated' && d.findings.some((f) => f.visibility !== 'hidden')) return <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />;
  if (d.status === 'evaluated') return <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />;
  return <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--color-line)]" aria-hidden />;
}

function statusLabel(d: TechnicalDecision): string {
  switch (d.status) {
    case 'proposed':
      return 'Proposed';
    case 'adopted':
    case 'evaluating':
      return 'Checking';
    case 'rejected':
      return 'Turned down';
    case 'evaluated': {
      const n = d.findings.filter((f) => f.visibility !== 'hidden').length;
      return n === 0 ? 'Checked' : `Checked · ${n} finding${n === 1 ? '' : 's'}`;
    }
    case 'skipped':
      return 'Not checked';
    case 'failed':
      return 'Check failed';
    default:
      return d.status;
  }
}

/** The live decision cards, with their actions wired to the API. */
export function LiveDecisionCards(props: { sessionId: string; state: SessionState; segments: Segment[]; ended: boolean; htmlUrl?: string | null; apply: (v: SessionView) => void }) {
  const actions = useDecisionActions(props.sessionId, props.apply);
  return (
    <>
      {liveDecisionFindings(props.state).map(({ d, f }) => (
        <DecisionCard key={f.id} d={d} f={f} segments={props.segments} htmlUrl={props.htmlUrl} readOnly={props.ended} act={(a) => actions.act(d, f, a)} onReevaluate={() => void actions.reevaluate(d)} />
      ))}
    </>
  );
}
