'use client';

import { CircleCheck, CircleHelp, Layers, LoaderCircle, RefreshCw, ScanSearch, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { CodeRef, ImplementationPreview, PreviewScenario, Segment, SessionState } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { SlackLink } from '@/components/SlackLink';
import { AskBlock } from '@/components/session/SuggestionCard';
import { Button } from '@/components/ui/primitives';
import { api, type SessionView } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Implementation preview, inline in the panel: a quiet hint when a proposed change touches code with
 * consequences, a button to preview the current discussion on demand, and the opened preview itself.
 * Nothing runs a model until the user asks.
 */
export function PreviewSection(props: { sessionId: string; state: SessionState; segments: Segment[]; ended: boolean; htmlUrl?: string | null; apply: (v: SessionView) => void }) {
  const { sessionId, state, segments, ended, htmlUrl, apply } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = (state.previews ?? []).filter((p) => p.status !== 'dismissed');
  const open = previews.find((p) => p.id === openId) ?? null;
  // Only the newest unopened hint is shown; older ones wait in the list below.
  const hint = [...previews].reverse().find((p) => p.status === 'suggested' && p.trigger === 'auto' && p.id !== openId);
  const earlier = previews.filter((p) => p.id !== openId && p.id !== hint?.id && p.content);
  const text = (id: string | undefined) => segments.find((s) => s.id === id)?.text ?? '';

  const request = async (previewId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SessionView & { previewId: string }>(`/api/sessions/${sessionId}/previews`, { body: previewId ? { previewId } : {} });
      apply(r);
      setOpenId(r.previewId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async (id: string) => {
    if (openId === id) setOpenId(null);
    apply(await api<SessionView>(`/api/sessions/${sessionId}/previews/${id}/dismiss`, { method: 'POST' }));
  };

  if (previews.length === 0 && (ended || segments.length === 0)) return null;
  return (
    <section className="space-y-2" aria-label="Implementation preview" data-testid="preview-section">
      {hint && (
        <div className="settle-in flex items-center gap-2.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" data-testid="preview-hint">
          <Layers className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">Implementation impact worth reviewing</p>
            <p className="truncate text-xs text-[var(--color-muted)]" title={hint.reasons.join('\n')}>
              “{text(hint.segmentIds[0])}”
            </p>
          </div>
          <Button size="sm" variant="primary" onClick={() => request(hint.id)} disabled={busy} data-testid="view-preview">
            View preview
          </Button>
          <button className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]" onClick={() => dismiss(hint.id)} aria-label="Dismiss this hint" title="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {open && <PreviewCard p={open} segments={segments} htmlUrl={htmlUrl} ended={ended} onClose={() => setOpenId(null)} onRefresh={() => request(open.id)} onDismiss={() => dismiss(open.id)} busy={busy} />}

      {!ended && segments.length > 0 && (
        <button
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
          onClick={() => request()}
          disabled={busy}
          data-testid="preview-current"
          title="Look at what the change being discussed would mean for the existing code"
        >
          <ScanSearch className="size-3.5" aria-hidden />
          Preview the current discussion
        </button>
      )}
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}

      {earlier.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Earlier previews">
          {earlier.map((p) => (
            <li key={p.id} className="min-w-0">
              <button className="block w-full truncate text-left text-[var(--color-accent)] hover:underline" onClick={() => setOpenId(p.id)}>
                Preview: {p.content?.proposedChange ?? text(p.segmentIds[0])}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PreviewCard(props: { p: ImplementationPreview; segments: Segment[]; htmlUrl?: string | null; ended: boolean; busy: boolean; onClose: () => void; onRefresh: () => void; onDismiss: () => void }) {
  const { p, htmlUrl } = props;
  const c = p.content;
  const generating = p.status === 'generating';
  const refs = c ? uniqueRefs([...c.currentBehavior.flatMap((f) => f.refs), ...c.impacts.flatMap((i) => i.refs), ...c.scenarios.flatMap((s) => s.current.refs)]) : [];
  return (
    <article className="settle-in overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-sm" data-testid="preview-card" aria-busy={generating}>
      <header className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
        <Layers className="size-4 text-[var(--color-accent)]" aria-hidden />
        <h3 className="text-sm font-semibold">Implementation preview</h3>
        {c && <ContextBadge status={c.contextStatus} />}
        <button className="ml-auto rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]" onClick={props.onClose} aria-label="Close preview" title="Close">
          <X className="size-4" />
        </button>
      </header>

      <div className="space-y-3.5 px-4 py-3">
        {generating && (
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]" data-testid="preview-loading">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {c ? 'Updating with the latest discussion…' : 'Reading the related code…'}
          </p>
        )}
        {p.status === 'failed' && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-900 dark:bg-red-950/60 dark:text-red-200" role="alert">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{p.error ?? 'The preview failed.'}</span>
            {!props.ended && (
              <Button size="sm" onClick={props.onRefresh} disabled={props.busy}>
                Retry
              </Button>
            )}
          </div>
        )}
        {c && !generating && p.newSegmentIds.length > 0 && !props.ended && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[13px]" data-testid="preview-stale">
            <span className="flex-1">
              The discussion continued ({p.newSegmentIds.length} new turn{p.newSegmentIds.length === 1 ? '' : 's'}).
            </span>
            <Button size="sm" onClick={props.onRefresh} disabled={props.busy}>
              <RefreshCw className="size-3" aria-hidden /> Update
            </Button>
          </div>
        )}

        {c && (
          <>
            <div>
              <SectionLabel>Proposed change</SectionLabel>
              <p className="text-[15px] leading-snug font-semibold" data-testid="preview-change">
                {c.proposedChange}
              </p>
              {c.summary && <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">{c.summary}</p>}
            </div>

            {c.noImplications ? (
              <p className="rounded-lg bg-[var(--color-canvas)] px-3 py-2 text-[13px] text-[var(--color-muted)]">No implementation impact found: {c.noImplications}</p>
            ) : (
              <>
                {c.clarification && <AskBlock question={c.clarification} context={null} label="Suggested clarification" />}

                <Block icon={<CircleCheck className="size-3.5 text-emerald-600" aria-hidden />} label="What the code does today" testId="preview-current-behavior">
                  {c.currentBehavior.length === 0 ? (
                    <p className="text-[13px] text-[var(--color-muted)]">Not established from the indexed code.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {c.currentBehavior.map((f, i) => (
                        <li key={i} className="text-[13px] leading-snug">
                          {f.text} <Refs refs={f.refs} htmlUrl={htmlUrl} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Block>

                {c.impacts.length > 0 && (
                  <Block icon={<TriangleAlert className="size-3.5 text-amber-600" aria-hidden />} label="What could happen (predicted)" testId="preview-impacts">
                    <ul className="space-y-1.5">
                      {c.impacts.map((im, i) => (
                        <li key={i} className="text-[13px] leading-snug">
                          <span className="mr-1 rounded bg-amber-100 px-1 py-px text-[10px] font-semibold text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-300">{im.likelihood}</span>
                          {im.text} <Refs refs={im.refs} htmlUrl={htmlUrl} />
                        </li>
                      ))}
                    </ul>
                  </Block>
                )}

                {c.unknowns.length > 0 && (
                  <Block icon={<CircleHelp className="size-3.5 text-[var(--color-muted)]" aria-hidden />} label="Not established">
                    <ul className="space-y-1 text-[13px] text-[var(--color-muted)]">
                      {c.unknowns.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </Block>
                )}

                {c.scenarios.length > 0 && <Scenarios rows={c.scenarios} htmlUrl={htmlUrl} />}

                {c.questions.length > 0 && (
                  <Block icon={<CircleHelp className="size-3.5 text-sky-600" aria-hidden />} label="Decisions still open" testId="preview-questions">
                    <ul className="space-y-1.5">
                      {c.questions.map((q, i) => (
                        <li key={i} className={cn('text-[13px] leading-snug', q.status === 'answered' && 'text-[var(--color-muted)]')} title={q.why}>
                          {q.status === 'answered' ? <CircleCheck className="mr-1 inline size-3.5 text-emerald-600" aria-label="Answered" /> : null}
                          {q.text}
                          {q.answer && <span className="block text-xs italic">Answered: “{q.answer.quote}”</span>}
                        </li>
                      ))}
                    </ul>
                  </Block>
                )}

                {(refs.length > 0 || (p.slackRefs?.length ?? 0) > 0) && (
                  <Block label="Sources">
                    <ul className="flex flex-wrap gap-1.5" data-testid="preview-sources">
                      {refs.map((r) => (
                        <li key={`${r.filePath}:${r.startLine}`} className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5" title={r.note}>
                          <span className="mr-1 font-mono text-[11px] font-medium">{r.symbolName}</span>
                          <CodeLink htmlUrl={htmlUrl} r={r} className="font-mono text-[11px]" />
                        </li>
                      ))}
                      {p.slackRefs?.map((r) => (
                        <li key={r.id} className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5">
                          <SlackLink r={r} note={r.note} className="text-[11px]" />
                        </li>
                      ))}
                    </ul>
                  </Block>
                )}
              </>
            )}
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-line)] px-4 py-2 text-[11px] text-[var(--color-muted)]">
        <span data-testid="preview-cost">{usageLabel(p)}</span>
        {p.removed.length > 0 && (
          <span title={p.removed.map((r) => `${r.reason}: ${r.detail}`).join('\n')}>
            {p.removed.length} unsupported claim{p.removed.length === 1 ? '' : 's'} removed
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </footer>
    </article>
  );
}

const CURRENT_BASIS: Record<PreviewScenario['current']['basis'], { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  inferred: { label: 'Predicted', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  unknown: { label: 'Unknown', cls: 'bg-[var(--color-canvas)] text-[var(--color-muted)]' },
};
const INTENDED_BASIS: Record<PreviewScenario['intended']['basis'], { label: string; cls: string }> = {
  stated: { label: 'Said', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  confirmed: { label: 'Confirmed', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  unspecified: { label: 'Needs clarification', cls: 'border border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300' },
};

function Scenarios({ rows, htmlUrl }: { rows: PreviewScenario[]; htmlUrl?: string | null }) {
  return (
    <Block label="Behavioral scenarios">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[12px] leading-snug" data-testid="preview-scenarios">
          <thead>
            <tr className="text-[11px] text-[var(--color-muted)]">
              <th className="px-1 py-1 font-medium">Scenario</th>
              <th className="px-1 py-1 font-medium">Today</th>
              <th className="px-1 py-1 font-medium">Intended</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={i} className="border-t border-[var(--color-line)] align-top">
                <td className="px-1 py-1.5 font-medium">{s.scenario}</td>
                <td className="px-1 py-1.5">
                  {s.current.text} <Chip {...CURRENT_BASIS[s.current.basis]} />
                  {s.current.refs.length > 0 && (
                    <span className="block">
                      <Refs refs={s.current.refs} htmlUrl={htmlUrl} />
                    </span>
                  )}
                </td>
                <td className="px-1 py-1.5" title={s.intended.quote ? `“${s.intended.quote.quote}”` : undefined}>
                  {s.intended.text !== INTENDED_BASIS[s.intended.basis].label && `${s.intended.text} `}
                  <Chip {...INTENDED_BASIS[s.intended.basis]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={cn('ml-0.5 inline-block rounded px-1 py-px text-[10px] font-medium whitespace-nowrap', cls)}>{label}</span>;
}

function Refs({ refs, htmlUrl }: { refs: CodeRef[]; htmlUrl?: string | null }) {
  return (
    <>
      {refs.map((r) => (
        <span key={`${r.evidenceId}:${r.startLine}`} className="mr-1 whitespace-nowrap" title={r.note}>
          <CodeLink htmlUrl={htmlUrl} r={r} className="font-mono text-[11px]" />
        </span>
      ))}
    </>
  );
}

function Block({ icon, label, testId, children }: { icon?: React.ReactNode; label: string; testId?: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId}>
      <SectionLabel>
        {icon}
        {label}
      </SectionLabel>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">{children}</div>;
}

function ContextBadge({ status }: { status: 'sufficient' | 'partial' | 'insufficient' }) {
  const style = {
    sufficient: ['Backed by code', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'],
    partial: ['Partly backed by code', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'],
    insufficient: ['Code not found', 'bg-[var(--color-canvas)] text-[var(--color-muted)]'],
  }[status];
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', style[1])}>{style[0]}</span>;
}

function uniqueRefs(refs: CodeRef[]) {
  return refs.filter((r, i) => refs.findIndex((x) => x.filePath === r.filePath && x.startLine === r.startLine) === i).slice(0, 8);
}

function usageLabel(p: ImplementationPreview) {
  const u = p.usage;
  const reused = p.cacheHits > 0 ? ` · reused ${p.cacheHits}×` : '';
  if (u.calls === 0) return `Rules only, no model call${reused}`;
  const tokens = u.inputTokens + u.outputTokens;
  const cost = u.costUsd < 0.01 ? `$${u.costUsd.toFixed(4)}` : `$${u.costUsd.toFixed(2)}`;
  return `${u.calls} model call${u.calls === 1 ? '' : 's'} · ${(tokens / 1000).toFixed(1)}k tokens · ~${cost}${reused}`;
}
