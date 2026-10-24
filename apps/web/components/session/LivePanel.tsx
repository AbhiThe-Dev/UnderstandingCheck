'use client';

import Link from 'next/link';
import { ChevronDown, Ear, Lock, Maximize2, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SLACK_WINDOW_MS, type Discrepancy } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { SlackExcerpt } from '@/components/SlackLink';
import { Avatar } from '@/components/ui/Avatar';
import { SuggestionCard, type Act, type Respond } from '@/components/session/SuggestionCard';
import { Transcript } from '@/components/session/Transcript';
import type { SessionResponse } from '@/lib/api';
import { TOPIC_WINDOW_MS, agoLabel, latestRequest, onScreen } from '@/lib/topic';
import { cn } from '@/lib/utils';

/**
 * The side panel shown next to a call (the desktop app opens `?view=panel`): suggestions first and
 * large, then what is being discussed, then the last few lines of the conversation. Setup, replay
 * controls and engine statistics stay in the full view.
 */
export function LivePanel(props: { id: string; data: SessionResponse; connected: boolean; act: Act; respond: Respond }) {
  const { id, data, act, respond } = props;
  const { state, segments, session, repo } = data;
  const ended = session.status === 'ended';
  const live = state.discrepancies.filter((d) => d.visibility === 'live' && !['resolved', 'dismissed', 'unresolved'].includes(d.status));
  const queued = state.discrepancies.filter((d) => d.visibility === 'queued' && !['resolved', 'dismissed'].includes(d.status));
  const settled = state.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null && ['resolved', 'unresolved'].includes(d.status));
  // Both follow the conversation: the latest substantial request, and the code it last touched.
  const request = latestRequest(state, segments);
  const lastAt = segments.at(-1)?.timestamp ?? 0;
  const focusAt = segments.find((s) => s.id === state.focus?.segmentId)?.timestamp;
  const focusCurrent = state.focus && (focusAt === undefined || lastAt - focusAt <= TOPIC_WINDOW_MS);
  const focusEv = focusCurrent ? state.evidence.find((e) => e.id === state.focus!.evidenceId) : null;
  const feature = state.feature.provenance !== 'inferred' ? state.feature.description : null;
  const screen = onScreen(state, segments);
  // Slack results still counting as context, newest search first.
  const slackNow =
    state.slack && lastAt - state.slack.at <= SLACK_WINDOW_MS
      ? state.slack.refIds.flatMap((rid) => state.slackRefs?.filter((r) => r.id === rid) ?? []).slice(0, 3)
      : [];
  const speaker = (pid: string) => state.participants.find((p) => p.id === pid);
  const card = (d: Discrepancy, readOnly = ended, canRate?: boolean) => (
    <SuggestionCard
      key={d.id}
      sessionId={id}
      d={d}
      clarifications={state.clarifications.filter((c) => c.discrepancyId === d.id)}
      participants={state.participants}
      act={act}
      respond={respond}
      readOnly={readOnly}
      canRate={canRate}
      htmlUrl={repo?.htmlUrl}
    />
  );

  return (
    <div data-view="panel" className="mx-auto max-w-xl space-y-4">
      <header className="sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/95 px-4 py-2.5 backdrop-blur">
        <Status data={data} connected={props.connected} />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]" title={session.title}>
          {session.title}
          {repo && ` · ${repo.name}`}
        </span>
        <Link href={`/sessions/${id}`} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]" title="Open the full view" aria-label="Open the full view">
          <Maximize2 className="size-4" />
        </Link>
      </header>

      <section className="space-y-3" aria-live="polite" aria-label="Private suggestions">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Suggestions{live.length > 0 && <span className="ml-1.5 rounded-full bg-[var(--color-accent)] px-1.5 py-px text-[11px] text-white">{live.length}</span>}
          </h2>
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
            <Lock className="size-3" aria-hidden /> only you see these
          </span>
        </div>
        {live.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--color-line)] px-4 py-5 text-sm text-[var(--color-muted)]">
            <Ear className="size-5 shrink-0" aria-hidden />
            <span>{ended ? 'The session has ended.' : 'Listening. Nothing needs your attention right now.'}</span>
          </div>
        ) : (
          live.map((d) => card(d))
        )}
        {queued.length > 0 && <Collapsible label={`Saved for later (${queued.length})`}>{queued.map((d) => card(d))}</Collapsible>}
        {settled.length > 0 && <Collapsible label={`Settled (${settled.length})`}>{settled.map((d) => card(d, true, !ended))}</Collapsible>}
      </section>

      {(feature || request || focusEv || screen.length > 0) && (
        <section className="space-y-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3" data-testid="now-discussing">
          <h2 className="text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">Now discussing</h2>
          {feature && (
            <p className="text-sm leading-snug">
              <span className="text-[var(--color-muted)]">Feature: </span>
              {feature}
            </p>
          )}
          {request && (
            <div className="flex gap-2.5">
              <Avatar
                name={speaker(request.participantId)?.displayName ?? '?'}
                index={state.participants.findIndex((p) => p.id === request.participantId)}
                unknown={speaker(request.participantId)?.ambiguous}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <p className="text-sm leading-snug">“{request.text}”</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                  {speaker(request.participantId)?.displayName ?? 'Someone'} · {agoLabel(request.agoMs)}
                </p>
              </div>
            </div>
          )}
          {screen.length > 0 && (
            <div className="flex gap-2 text-xs" data-testid="on-screen">
              <Monitor className="mt-0.5 size-3.5 shrink-0 text-[var(--color-muted)]" aria-label="On screen" />
              <div className="min-w-0">
                <span className="text-[var(--color-muted)]">On screen: </span>
                {screen.slice(0, 3).map((e, i) => (
                  <span key={e.id}>
                    {i > 0 && ', '}
                    <span className="font-mono font-medium">{e.symbolName}</span>{' '}
                    <CodeLink htmlUrl={repo?.htmlUrl} r={e} className="font-mono text-[11px]" />
                  </span>
                ))}
              </div>
            </div>
          )}
          {focusEv && (
            <div className="space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-mono font-medium">{focusEv.symbolName}</span>
                <CodeLink htmlUrl={repo?.htmlUrl} r={{ ...focusEv, commitSha: focusEv.commitSha }} className="font-mono text-[11px]" />
              </p>
              <ul className="space-y-0.5 text-xs text-[var(--color-muted)]">
                {state.existingBehavior
                  .filter((b) => b.evidenceId === focusEv.id)
                  .slice(0, 5)
                  .map((b) => (
                    <li key={b.description} className="flex gap-1.5">
                      <span aria-hidden>·</span>
                      {b.description.replace(`${focusEv.symbolName} `, '').replace(/ \([^)]*\)$/, '')}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {slackNow.length > 0 && (
        <section className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3" data-testid="from-slack">
          <h2 className="text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">From Slack</h2>
          {slackNow.map((r) => (
            <SlackExcerpt key={r.id} r={r} text={data.slackExcerpts?.find((x) => x.id === r.id)?.text} />
          ))}
        </section>
      )}

      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">Conversation</h2>
        <Transcript
          segments={segments}
          participants={state.participants}
          partial={data.capture?.status === 'live' ? data.capture.partial : null}
          limit={8}
          className="max-h-80 overflow-y-auto"
          empty={<p className="py-2 text-sm text-[var(--color-muted)]">Nothing said yet.</p>}
        />
      </section>
    </div>
  );
}

function Status({ data, connected }: { data: SessionResponse; connected: boolean }) {
  const capture = data.capture;
  const recording = capture?.status === 'live';
  const elapsed = useElapsed(recording ? capture.startedAt : null);
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        recording ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-[var(--color-surface)] text-[var(--color-muted)]',
      )}
      data-testid="capture-status"
      title={connected ? 'Connected to the copilot' : 'Reconnecting to the copilot…'}
    >
      <span className={cn('size-2 rounded-full', recording ? 'animate-pulse bg-red-500' : connected ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />
      {recording ? `Live · ${elapsed}` : capture?.status === 'error' ? 'Capture stopped' : data.session.status === 'ended' ? 'Ended' : 'Not recording'}
      {recording && capture.screen && <Monitor className="size-3" aria-label="Reading the screen for code" />}
    </span>
  );
}

function useElapsed(since: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex items-center gap-1 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
        {label}
      </button>
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  );
}
