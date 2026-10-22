'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { wordDiff } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { Badge, Button, Card, CardHeader, CardTitle, Input } from '@/components/ui/primitives';
import { api, type RecordDetail, type RecordVersion } from '@/lib/api';

export default function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => api<RecordDetail>(`/api/requirements/${id}`).then(setData, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Card className="p-6 text-sm">{error}</Card>;
  if (!data) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;
  const { record, versions } = data;
  const current = versions.find((v) => v.version === record.currentVersion) ?? versions.at(-1)!;

  const setStatus = async (status: 'active' | 'retired') => {
    await api(`/api/requirements/${id}/status`, { body: { status, reason: reason || undefined } });
    setReason('');
    await load();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/requirements" className="text-xs text-[var(--color-accent)]">
        ← All requirements
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-[var(--color-muted)]">{data.label}</span>
          <Badge tone={record.status === 'active' ? 'green' : 'neutral'} data-testid="record-status">
            {record.status}
          </Badge>
          <Badge>v{record.currentVersion}</Badge>
          {data.repositoryName && <Badge>{data.repositoryName}</Badge>}
        </div>
        <h1 className="mt-2 text-lg font-semibold">{record.title}</h1>
        {record.status === 'retired' && <p className="mt-1 text-sm text-[var(--color-muted)]">Retired{record.retiredReason ? `: ${record.retiredReason}` : ''}. Retired records are not used to check new sessions.</p>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current agreement (v{current.version})</CardTitle>
          <span className="text-xs text-[var(--color-muted)]">last confirmed {new Date(record.lastConfirmedAt).toLocaleString()}</span>
        </CardHeader>
        <div className="space-y-3 px-4 py-3 text-sm">
          <p data-testid="record-current">{current.description}</p>
          {current.acceptanceCriteria.length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Acceptance criteria</div>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {current.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {current.codeRefs.length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Code</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {current.codeRefs.map((r) => (
                  <li key={`${r.filePath}:${r.startLine}`}>
                    <CodeLink htmlUrl={data.repositoryUrl} r={r} />{' '}
                    <span className="text-[var(--color-muted)]">{r.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <span className="text-xs text-[var(--color-muted)]">versions are never edited</span>
        </CardHeader>
        <ol className="divide-y divide-[var(--color-line)]" data-testid="record-history">
          {[...versions].reverse().map((v) => (
            <VersionItem key={v.id} v={v} previous={versions.find((x) => x.version === v.version - 1)} />
          ))}
        </ol>
        {record.reaffirmations.length > 0 && (
          <div className="border-t border-[var(--color-line)] px-4 py-3 text-xs text-[var(--color-muted)]">
            <div className="mb-1 font-medium text-[var(--color-ink)]">Reaffirmed in later meetings</div>
            <ul className="space-y-0.5">
              {record.reaffirmations.map((a, i) => (
                <li key={i}>
                  {new Date(a.at).toLocaleString()} — {a.sessionId ? <Link href={`/sessions/${a.sessionId}/summary`} className="text-[var(--color-accent)]">{a.sessionTitle}</Link> : `${a.sessionTitle} (session deleted)`} · {a.confirmedBy.join(', ')}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="flex flex-wrap items-end gap-2 p-4">
        {record.status === 'active' ? (
          <>
            <div className="min-w-64 flex-1">
              <label className="mb-1 block text-xs text-[var(--color-muted)]" htmlFor="reason">
                Reason for retiring (optional)
              </label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Feature removed" />
            </div>
            <Button variant="danger" onClick={() => setStatus('retired')}>
              Retire requirement
            </Button>
          </>
        ) : (
          <Button onClick={() => setStatus('active')}>Reactivate</Button>
        )}
      </Card>
    </div>
  );
}

function VersionItem({ v, previous }: { v: RecordVersion; previous?: RecordVersion }) {
  const parts = previous ? wordDiff(previous.description, v.description) : null;
  // An inline diff only helps for small edits; a rephrased requirement reads better as before/after.
  const unchanged = parts?.filter((p) => p.op === 'same').reduce((n, p) => n + p.text.trim().length, 0) ?? 0;
  const diff = parts && unchanged / Math.max(1, v.description.length) >= 0.5 ? parts : null;
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="accent">v{v.version}</Badge>
        <Badge>{v.origin === 'created' ? 'created' : 'replaced the previous version'}</Badge>
        <Badge tone={v.confirmation === 'clarified' ? 'green' : 'blue'}>{v.confirmation === 'clarified' ? 'confirmed through clarification' : 'verbal agreement'}</Badge>
        {v.revisedInMeeting && <Badge tone="amber">changed during the meeting</Badge>}
        <span className="text-[var(--color-muted)]">
          {new Date(v.createdAt).toLocaleString()} ·{' '}
          {v.sessionId ? (
            <Link href={`/sessions/${v.sessionId}/summary`} className="text-[var(--color-accent)]">
              {v.sessionTitle}
            </Link>
          ) : (
            `${v.sessionTitle} (session deleted)`
          )}
        </span>
      </div>
      {previous && !diff && (
        <p className="mt-1.5 text-[var(--color-muted)] line-through decoration-red-400" title="Previous wording">
          {previous.description}
        </p>
      )}
      <p className="mt-1.5">
        {diff
          ? diff.map((part, i) => (
              <span
                key={i}
                className={
                  part.op === 'add' ? 'bg-emerald-100 dark:bg-emerald-950' : part.op === 'del' ? 'mr-0.5 bg-red-100 text-[var(--color-muted)] line-through dark:bg-red-950' : undefined
                }
              >
                {part.text}
              </span>
            ))
          : v.description}
      </p>
      {v.concern && <p className="mt-1 text-xs text-[var(--color-muted)]">Raised as: {v.concern}</p>}
      <div className="mt-1.5 text-xs text-[var(--color-muted)]">Confirmed by {v.confirmedBy.join(', ') || '—'}</div>
      {v.evidenceRedacted ? (
        <p className="mt-1 text-xs italic text-[var(--color-muted)]">Quotes removed because the source session was deleted.</p>
      ) : (
        v.evidence.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs">
            {v.evidence.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.speaker}</span>
                {e.kind === 'scenario_answer' ? ' (private scenario answer)' : ''}: “{e.text}”
              </li>
            ))}
          </ul>
        )
      )}
    </li>
  );
}
