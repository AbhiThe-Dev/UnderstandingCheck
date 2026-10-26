'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import type { TranscriptSegmentInput } from '@uc/core';
import { InputPanel } from '@/components/session/InputPanel';
import { LivePanel } from '@/components/session/LivePanel';
import { PreviewSection } from '@/components/session/PreviewSection';
import { SuggestionCard, type Act, type Respond } from '@/components/session/SuggestionCard';
import { Transcript } from '@/components/session/Transcript';
import { Badge, Button, Card, CardHeader, CardTitle, Empty } from '@/components/ui/primitives';
import { api, type CaptureConfig, type Samples, type SessionView } from '@/lib/api';
import { useSession } from '@/lib/useSession';
import { agoLabel, latestRequest, onScreen } from '@/lib/topic';
import { ROLE_LABEL, formatTime, shortSha } from '@/lib/utils';

export default function SessionPage() {
  return (
    <Suspense>
      <Copilot />
    </Suspense>
  );
}

function Copilot() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { data, error, connected, apply } = useSession(id);
  const [samples, setSamples] = useState<Samples | null>(null);
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig | null>(null);
  const [showQueued, setShowQueued] = useState(false);

  useEffect(() => {
    api<Samples>('/api/samples').then(setSamples, () => undefined);
    api<CaptureConfig>('/api/capture/config').then(setCaptureConfig, () => undefined);
  }, []);

  if (error) return <Card className="p-6 text-sm">Could not load session: {error}</Card>;
  if (!data) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;

  const { state, segments, session, repo, metrics } = data;
  const ended = session.status === 'ended';

  const send = async (seg: TranscriptSegmentInput) => apply(await api<SessionView>(`/api/sessions/${id}/segments`, { body: seg }));
  const act: Act = async (did, action) => apply(await api<SessionView>(`/api/sessions/${id}/discrepancies/${did}/actions`, { body: { action } }));
  const respond: Respond = async (cid, participantId, body) =>
    apply(await api<SessionView>(`/api/sessions/${id}/clarifications/${cid}/responses`, { body: { participantId, ...body } }));
  if (search.get('view') === 'panel') return <LivePanel id={id} data={data} connected={connected} act={act} respond={respond} apply={apply} />;

  const end = async () => {
    apply(await api<SessionView>(`/api/sessions/${id}/end`, { method: 'POST' }));
    router.push(`/sessions/${id}/summary`);
  };

  const live = state.discrepancies.filter((d) => d.visibility === 'live' && !['resolved', 'dismissed', 'unresolved'].includes(d.status));
  const queued = state.discrepancies.filter((d) => d.visibility === 'queued' && !['resolved', 'dismissed'].includes(d.status));
  const done = state.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null && ['resolved', 'unresolved'].includes(d.status));
  const focusEv = state.focus ? state.evidence.find((e) => e.id === state.focus!.evidenceId) : null;
  const current = state.requirements.filter((r) => r.status !== 'superseded');
  const request = latestRequest(state, segments);
  const screen = onScreen(state, segments);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{session.title}</h1>
          <p className="text-xs text-[var(--color-muted)]">
            {repo ? (
              repo.htmlUrl && !state.commitSha.startsWith('content-') ? (
                <a href={`${repo.htmlUrl}/tree/${state.commitSha}`} target="_blank" rel="noreferrer" className="hover:underline">
                  {repo.name} @ {shortSha(state.commitSha)}
                </a>
              ) : (
                `${repo.name} @ ${shortSha(state.commitSha)}`
              )
            ) : (
              'No repository connected'
            )}{' '}
            · analyzer {session.analyzer}
            {session.githubIssue ? (
              <>
                {' · '}
                <a href={session.githubIssue.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">
                  #{session.githubIssue.number} {session.githubIssue.title}
                </a>
              </>
            ) : (
              session.githubIssueReference && ` · ${session.githubIssueReference}`
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data.capture?.status === 'live' ? (
            <Badge tone="red" title="Live capture is running; participants confirmed consent" data-testid="capture-status">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />{' '}
              {data.capture.source === 'recall' ? `Recording ${data.capture.meeting?.title ? `“${data.capture.meeting.title}”` : 'meeting'} via Recall.ai` : `Microphone live · ${data.capture.speaker ?? 'Room'}`}
            </Badge>
          ) : data.capture?.status === 'error' ? (
            <Badge tone="red" title={data.capture.error ?? ''}>
              Capture stopped: {data.capture.error?.slice(0, 60)}
            </Badge>
          ) : ended ? (
            <Badge>Transcription stopped</Badge>
          ) : (
            <Badge tone="neutral" title="Participants confirmed they know the discussion is transcribed and analyzed">
              Not recording · consent confirmed
            </Badge>
          )}
          <Badge tone={connected ? 'green' : 'neutral'}>{connected ? 'live' : 'offline'}</Badge>
          <Link href={`/sessions/${id}/summary`}>
            <Button size="sm">Summary</Button>
          </Link>
          {!ended && (
            <Button size="sm" variant="primary" onClick={end} data-testid="end-session">
              End session
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* Left: transcript */}
        <section className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Transcript</CardTitle>
              <span className="text-xs text-[var(--color-muted)]">{segments.length} segments</span>
            </CardHeader>
            <Transcript
              segments={segments}
              participants={state.participants}
              partial={data.capture?.status === 'live' ? data.capture.partial : null}
              className="max-h-[46vh] overflow-y-auto px-4 py-3"
              empty={<Empty>Replay a transcript or send live input below.</Empty>}
            />
          </Card>
          {!ended && (
            <InputPanel
              sessionId={id}
              send={send}
              samples={samples}
              initialSample={search.get('sample') ?? undefined}
              speakers={state.participants.filter((p) => !p.id.startsWith('prior:')).map((p) => p.displayName)}
              disabled={ended}
              replay={data.replay}
              capture={data.capture}
              captureConfig={captureConfig}
            />
          )}
        </section>

        {/* Center: accumulated understanding */}
        <section className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Current understanding</CardTitle>
              <Badge tone={state.contextStatus === 'sufficient' ? 'green' : state.contextStatus === 'insufficient' ? 'amber' : 'neutral'}>
                code context: {state.contextStatus}
              </Badge>
            </CardHeader>
            <div className="space-y-4 px-4 py-3 text-sm">
              {state.feature.provenance !== 'inferred' && state.feature.description && <Field label="Feature">{state.feature.description}</Field>}
              <Field label="Latest request">
                {request ? (
                  <>
                    “{request.text}”
                    <span className="ml-1.5 text-xs text-[var(--color-muted)]">
                      {state.participants.find((p) => p.id === request.participantId)?.displayName ?? 'Someone'} · {agoLabel(request.agoMs)}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-muted)]">Nothing specific in the last 10 minutes</span>
                )}
              </Field>
              {screen.length > 0 && (
                <Field label="On the shared screen">
                  <ul className="space-y-0.5 font-mono text-xs" data-testid="on-screen">
                    {screen.map((e) => (
                      <li key={e.id}>
                        {e.symbolName} · {e.filePath}:{e.startLine}
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              {focusEv && (
                <Field label="Existing behavior involved">
                  <div className="font-mono text-xs">
                    {focusEv.symbolName} · {focusEv.filePath}:{focusEv.startLine}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-muted)]">
                    {state.existingBehavior
                      .filter((b) => b.evidenceId === focusEv.id)
                      .map((b) => (
                        <li key={b.description}>• {b.description.replace(`${focusEv.symbolName} `, '')}</li>
                      ))}
                  </ul>
                </Field>
              )}
              <Field label="Requirements">
                {current.length === 0 && <span className="text-[var(--color-muted)]">None recorded</span>}
                <ul className="space-y-1.5">
                  {current.map((r) => (
                    <li key={r.id} className="text-[13px]">
                      <Badge tone={r.status === 'confirmed' ? (r.confirmation === 'clarified' ? 'green' : 'blue') : 'amber'} className="mr-1.5">
                        {r.status === 'confirmed' ? (r.confirmation === 'clarified' ? `confirmed v${r.version}` : 'verbal') : 'unconfirmed'}
                      </Badge>
                      {r.description}
                    </li>
                  ))}
                </ul>
              </Field>
              <Field label="Participants">
                <ul className="flex flex-wrap gap-1.5">
                  {state.participants
                    .filter((p) => !p.id.startsWith('prior:'))
                    .map((p) => (
                      <li key={p.id}>
                        <Badge tone={p.ambiguous ? 'amber' : 'neutral'}>
                          {p.displayName} · {ROLE_LABEL[p.role]}
                        </Badge>
                      </li>
                    ))}
                </ul>
              </Field>
              {state.priorDecisions.length > 0 && (
                <Field label="Earlier decisions">
                  <ul className="space-y-0.5 text-xs">
                    {state.priorDecisions.map((p) => (
                      <li key={p.id}>
                        {p.description} <span className="text-[var(--color-muted)]">({p.source})</span>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              <Field label="Engine activity">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-[var(--color-muted)]" data-testid="engine-metrics">
                  <Metric label="Meeting time" value={formatTime(metrics.meetingDurationMs)} />
                  <Metric label="Analyses / skipped turns" value={`${metrics.analysesRun} / ${metrics.analysesSkipped}`} />
                  <Metric label="Retrievals (cached)" value={`${metrics.retrievals} (${metrics.retrievalCacheHits})`} />
                  <Metric label="Rejected by evidence check" value={metrics.rejectedCandidates} />
                  <Metric label="Suggestions shown" value={metrics.suggestions} />
                  <Metric label="Duplicates suppressed" value={state.metrics.duplicatesSuppressed + metrics.duplicateSegments} />
                  <Metric label="Latency p50 / p95" value={metrics.latencyMs ? `${metrics.latencyMs.p50} / ${metrics.latencyMs.p95} ms` : '—'} />
                  <Metric label="Median time to resolve" value={metrics.medianTimeToResolveMs === null ? '—' : formatTime(metrics.medianTimeToResolveMs)} />
                </dl>
              </Field>
            </div>
          </Card>
        </section>

        {/* Right: private suggestions */}
        <section className="order-first space-y-3 lg:order-none" aria-live="polite">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Private suggestions</h2>
            <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
              <Lock className="size-3" aria-hidden /> only you see these
            </span>
          </div>
          {live.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--color-line)]">
              <Empty>Nothing worth interrupting for. The copilot stays quiet unless people may expect different behavior.</Empty>
            </div>
          )}
          {live.map((d) => (
            <SuggestionCard
              key={d.id}
              sessionId={id}
              d={d}
              clarifications={state.clarifications.filter((c) => c.discrepancyId === d.id)}
              participants={state.participants}
              act={act}
              respond={respond}
              readOnly={ended}
              htmlUrl={repo?.htmlUrl}
            />
          ))}
          <PreviewSection sessionId={id} state={state} segments={segments} ended={ended} htmlUrl={repo?.htmlUrl} apply={apply} />
          {queued.length > 0 && (
            <div>
              <button className="text-xs text-[var(--color-muted)] hover:underline" onClick={() => setShowQueued((v) => !v)}>
                {showQueued ? 'Hide' : 'Show'} saved for later ({queued.length})
              </button>
              {showQueued &&
                queued.map((d) => (
                  <div key={d.id} className="mt-2">
                    <SuggestionCard sessionId={id} d={d} clarifications={state.clarifications.filter((c) => c.discrepancyId === d.id)} participants={state.participants} act={act} respond={respond} readOnly={ended} htmlUrl={repo?.htmlUrl} />
                  </div>
                ))}
            </div>
          )}
          {done.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="text-xs font-medium text-[var(--color-muted)]">Settled</h3>
              {done.map((d) => (
                <SuggestionCard
                  key={d.id}
                  sessionId={id}
                  d={d}
                  clarifications={state.clarifications.filter((c) => c.discrepancyId === d.id)}
                  participants={state.participants}
                  act={act}
                  respond={respond}
                  readOnly
                  canRate={!ended}
                  htmlUrl={repo?.htmlUrl}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums text-[var(--color-ink)]">{value}</dd>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div>{children}</div>
    </div>
  );
}
