'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { Clarification, Discrepancy, SessionState } from '@uc/core';
import { CodeLink } from '@/components/CodeLink';
import { SlackExcerpt } from '@/components/SlackLink';
import { Badge, Button, Card, CardHeader, CardTitle, Empty, Label, Textarea } from '@/components/ui/primitives';
import { api, type SessionView } from '@/lib/api';
import { useSession } from '@/lib/useSession';
import { CATEGORY_LABEL, STATUS_LABEL, shortSha } from '@/lib/utils';

export default function ClarificationDetail() {
  const { id, did } = useParams<{ id: string; did: string }>();
  const { data, error, apply } = useSession(id);
  if (error) return <Card className="p-6 text-sm">{error}</Card>;
  if (!data) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;
  const d = data.state.discrepancies.find((x) => x.id === did);
  if (!d) return <Card className="p-6 text-sm">This concern does not exist in the session.</Card>;
  const state = data.state;
  const name = (pid: string | null) => state.participants.find((p) => p.id === pid)?.displayName ?? '—';
  const clarifications = state.clarifications.filter((c) => c.discrepancyId === d.id);
  const ended = data.session.status === 'ended';

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link href={`/sessions/${id}`} className="text-xs text-[var(--color-accent)]">
        ← Back to the live session
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{CATEGORY_LABEL[d.category]}</Badge>
          <Badge tone="accent">{STATUS_LABEL[d.status]}</Badge>
          <Badge>impact score {d.impactScore.toFixed(2)}</Badge>
          <Badge>evidence confidence {Math.round(d.confidence * 100)}%</Badge>
        </div>
        <h1 className="mt-2 text-lg font-semibold">{d.title}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{d.description}</p>
        <p className="mt-1 text-sm">
          <span className="font-medium">Why it matters:</span> {d.impact.explanation}
        </p>
        {d.notes.map((n) => (
          <p key={n} className="mt-1 text-xs text-[var(--color-muted)]">
            Note: {n}
          </p>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Evidence from the conversation</CardTitle>
          </CardHeader>
          <ul className="space-y-2 px-4 py-3 text-sm">
            {d.statements.length === 0 && <li className="text-[var(--color-muted)]">No direct quotes.</li>}
            {d.statements.map((s) => (
              <li key={s.segmentId}>
                <span className="font-medium">{name(s.participantId)}:</span> “{s.quote}”
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Evidence from code</CardTitle>
            <span className="text-xs text-[var(--color-muted)]">@ {shortSha(state.commitSha)}</span>
          </CardHeader>
          <div className="space-y-3 px-4 py-3">
            {d.codeRefs.length === 0 && <p className="text-sm text-[var(--color-muted)]">No code involved.</p>}
            {d.codeRefs.map((r) => (
              <CodeRef key={`${r.evidenceId}:${r.startLine}`} state={state} r={r} htmlUrl={data.repo?.htmlUrl} />
            ))}
          </div>
        </Card>
        {d.slackRefs && d.slackRefs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Evidence from Slack</CardTitle>
            </CardHeader>
            <div className="space-y-3 px-4 py-3">
              {d.slackRefs.map((r) => (
                <SlackExcerpt key={r.id} r={r} note={r.note} text={data.slackExcerpts?.find((x) => x.id === r.id)?.text} />
              ))}
            </div>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Competing interpretations</CardTitle>
        </CardHeader>
        <ul className="divide-y divide-[var(--color-line)] text-sm">
          {d.interpretations.map((i) => {
            const holders = latestPositions(d).filter((p) => p.interpretationId === i.id);
            return (
              <li key={i.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {i.id}. {i.label}
                  </span>
                  {holders.map((p) => (
                    <Badge key={p.participantId} tone={p.provenance === 'inferred' ? 'neutral' : 'accent'} title={p.provenance}>
                      {name(p.participantId)}
                      {p.provenance === 'inferred' ? ' (inferred)' : ''}
                    </Badge>
                  ))}
                  {d.resolution?.interpretationId === i.id && <Badge tone="green">decided</Badge>}
                </div>
                <p className="mt-0.5 text-[var(--color-muted)]">{i.behavior}</p>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clarifications &amp; responses</CardTitle>
        </CardHeader>
        {clarifications.length === 0 && <Empty>No clarification drafted yet (not surfaced).</Empty>}
        <div className="divide-y divide-[var(--color-line)]">
          {clarifications.map((c) => (
            <ClarificationBlock key={c.id} c={c} d={d} state={state} sessionId={id} apply={apply} readOnly={ended || c.confirmationStatus === 'superseded'} />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <ol className="space-y-1 px-4 py-3 text-xs text-[var(--color-muted)]">
          {d.history.map((h, i) => (
            <li key={i}>
              <span className="font-mono">#{h.at}</span> {STATUS_LABEL[h.status]} — {h.note}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function latestPositions(d: Discrepancy) {
  const m = new Map<string, Discrepancy['positions'][number]>();
  for (const p of d.positions) {
    const prev = m.get(p.participantId);
    if (!prev || p.provenance !== 'inferred' || prev.provenance === 'inferred') m.set(p.participantId, p);
  }
  return [...m.values()];
}

function CodeRef({ state, r, htmlUrl }: { state: SessionState; r: Discrepancy['codeRefs'][number]; htmlUrl: string | null | undefined }) {
  const ev = state.evidence.find((e) => e.id === r.evidenceId);
  // Show a window around the cited lines rather than the whole symbol.
  const from = ev ? Math.max(ev.startLine, r.startLine - 4) : 0;
  const lines = ev?.snippet.split('\n').slice(from - ev.startLine, r.endLine - ev.startLine + 5) ?? [];
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <CodeLink htmlUrl={htmlUrl} r={r} className="font-mono" />
        <span className="text-[var(--color-muted)]">{r.symbolName}</span>
      </div>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">{r.note}</p>
      {ev && (
        <pre className="mt-1.5 max-h-56 overflow-auto rounded border border-[var(--color-line)] bg-[var(--color-canvas)] py-1.5 text-[11px] leading-5">
          {lines.map((l, i) => {
            const n = from + i;
            const hit = n >= r.startLine && n <= r.endLine;
            return (
              <div key={n} className={hit ? 'bg-amber-100 dark:bg-amber-950' : undefined}>
                <span className="inline-block w-9 select-none pr-2 text-right text-[var(--color-muted)]">{n}</span>
                {l}
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

const PURPOSE: Record<Clarification['purpose'], string> = {
  private_check: 'Private scenario check',
  group_question: 'Question for the group',
  surface_difference: 'Different expectations',
};

function ClarificationBlock(props: { c: Clarification; d: Discrepancy; state: SessionState; sessionId: string; apply: (v: SessionView) => void; readOnly: boolean }) {
  const { c, d, state } = props;
  const name = (pid: string | null) => state.participants.find((p) => p.id === pid)?.displayName ?? '—';
  const eligible = c.targetedParticipantId ? [c.targetedParticipantId] : d.relevantParticipantIds.filter((p) => !p.startsWith('prior:'));
  const [participantId, setParticipantId] = useState(eligible[0] ?? '');
  const [interpretationId, setInterpretationId] = useState<string>('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      props.apply(
        await api<SessionView>(`/api/sessions/${props.sessionId}/clarifications/${c.id}/responses`, {
          body: { participantId, interpretationId: interpretationId || undefined, text },
        }),
      );
      setText('');
      setInterpretationId('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={c.purpose === 'surface_difference' ? 'red' : 'accent'}>{PURPOSE[c.purpose]}</Badge>
        {c.private && <Badge>private · {name(c.targetedParticipantId)}</Badge>}
        <Badge>{c.format.replace('_', ' ')}</Badge>
        <Badge tone={c.confirmationStatus === 'answered' ? 'green' : c.confirmationStatus === 'ambiguous' ? 'amber' : 'neutral'}>{c.confirmationStatus}</Badge>
      </div>
      {c.scenario && <p className="mt-2 text-[var(--color-muted)]">{c.scenario}</p>}
      <p className="mt-1 font-medium">{c.question}</p>
      {c.beforeAfter && (
        <div className="mt-2 grid gap-2 text-xs md:grid-cols-3">
          <div className="rounded border border-[var(--color-line)] p-2">
            <div className="font-medium">Before</div>
            {c.beforeAfter.before}
          </div>
          {Object.entries(c.beforeAfter.after).map(([k, v]) => (
            <div key={k} className="rounded border border-[var(--color-line)] p-2">
              <div className="font-medium">After ({k})</div>
              {v}
            </div>
          ))}
        </div>
      )}
      {c.decisionTable && (
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr>
              {c.decisionTable.columns.map((h) => (
                <th key={h} className="border-b border-[var(--color-line)] py-1 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.decisionTable.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.responses.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {c.responses.map((r, i) => (
            <li key={i}>
              <span className="font-medium">{name(r.participantId)}</span> ({r.source}): “{r.text}” → {r.interpretationId ? d.interpretations.find((x) => x.id === r.interpretationId)?.label : 'unclear, left unresolved'}
            </li>
          ))}
        </ul>
      )}
      {!props.readOnly && (
        <form onSubmit={submit} className="mt-3 space-y-2 rounded-md border border-[var(--color-line)] p-3">
          <div className="flex flex-wrap gap-3">
            <div>
              <Label>Answered by</Label>
              <select className="h-8 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-xs" value={participantId} onChange={(e) => setParticipantId(e.target.value)}>
                {eligible.map((p) => (
                  <option key={p} value={p}>
                    {name(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Label>Their expectation</Label>
              <div className="flex flex-wrap gap-2 text-xs">
                {d.interpretations.map((i) => (
                  <label key={i.id} className="flex items-center gap-1">
                    <input type="radio" name={`interp-${c.id}`} value={i.id} checked={interpretationId === i.id} onChange={() => setInterpretationId(i.id)} />
                    {i.label}
                  </label>
                ))}
                <label className="flex items-center gap-1">
                  <input type="radio" name={`interp-${c.id}`} value="" checked={interpretationId === ''} onChange={() => setInterpretationId('')} />
                  infer from their words
                </label>
              </div>
            </div>
          </div>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What they said (short)" className="font-sans text-sm" />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button size="sm" variant="primary" type="submit" disabled={!participantId || (!interpretationId && !text.trim())}>
            Record response
          </Button>
        </form>
      )}
    </div>
  );
}
