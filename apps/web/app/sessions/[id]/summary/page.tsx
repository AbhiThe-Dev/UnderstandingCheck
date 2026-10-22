'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { MeetingSummary, Participant } from '@uc/core';
import { Badge, Button, Card, CardHeader, CardTitle, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';

export default function SummaryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<{ summary: MeetingSummary; markdown: string; participants: Participant[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<{ summary: MeetingSummary; markdown: string; participants: Participant[] }>(`/api/sessions/${id}/summary`).then(setData, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <Card className="p-6 text-sm">{error}</Card>;
  if (!data) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;
  const { summary: s } = data;

  const download = () => {
    const url = URL.createObjectURL(new Blob([data.markdown], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'agreement.md' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const remove = async () => {
    if (!confirm('Delete this session, its transcript and everything derived from it?')) return;
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    router.push('/');
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/sessions/${id}`} className="text-xs text-[var(--color-accent)]">
            ← Back to session
          </Link>
          <h1 className="mt-1 text-lg font-semibold">Agreement: {s.feature}</h1>
        </div>
        <Button variant="danger" size="sm" onClick={remove}>
          Delete session &amp; transcript
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Agreed behavior changes" testId="agreed">
          {s.agreedChanges.length === 0 && <Muted>None confirmed.</Muted>}
          {s.agreedChanges.map((a) => (
            <li key={a.requirement.id}>
              {a.requirement.description}{' '}
              <Badge tone={a.requirement.confirmation === 'clarified' ? 'green' : 'blue'}>
                v{a.requirement.version} · {a.how}
              </Badge>
              <span className="ml-1 text-xs text-[var(--color-muted)]">{a.confirmedBy.join(', ')}</span>
            </li>
          ))}
          {s.unconfirmedProposals.map((r) => (
            <li key={r.id} className="text-[var(--color-muted)]">
              {r.description} <Badge tone="amber">proposed, not confirmed</Badge>
            </li>
          ))}
        </Section>
        <Section title="Resolved misunderstandings">
          {s.resolvedMisunderstandings.length === 0 && <Muted>None.</Muted>}
          {s.resolvedMisunderstandings.map((m) => (
            <li key={m.discrepancy.id}>
              <span className="font-medium">{m.discrepancy.title}</span> → {m.resolution}
              {m.hadDifferentExpectations && <Badge tone="red" className="ml-1">expectations differed</Badge>}
            </li>
          ))}
        </Section>
        <Section title="Open questions">
          {s.openQuestions.length === 0 && <Muted>None.</Muted>}
          {s.openQuestions.map((q, i) => (
            <li key={i}>{q.text}</li>
          ))}
        </Section>
        <Section title="Suggested acceptance criteria">
          {s.acceptanceCriteria.length === 0 && <Muted>None yet.</Muted>}
          {s.acceptanceCriteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </Section>
        <Section title="Relevant existing behavior">
          {s.existingBehavior.length === 0 && <Muted>No relevant code located.</Muted>}
          {s.existingBehavior.map((b) => (
            <li key={b} className="font-mono text-xs">
              {b}
            </li>
          ))}
        </Section>
        <Section title="Affected code">
          {s.codeRefs.length === 0 && <Muted>None.</Muted>}
          {s.codeRefs.map((r) => (
            <li key={`${r.filePath}:${r.startLine}`}>
              <span className="font-mono text-xs">
                {r.filePath}:{r.startLine}
              </span>{' '}
              <span className="text-[var(--color-muted)]">{r.note}</span>
            </li>
          ))}
        </Section>
      </div>
      <p className="text-xs text-[var(--color-muted)]">{s.disclaimer}</p>

      <Card>
        <CardHeader>
          <CardTitle>Export as a GitHub issue</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(data.markdown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy markdown'}
            </Button>
            <Button size="sm" onClick={download}>
              Download .md
            </Button>
            <Button size="sm" disabled title="Requires the GitHub App (Phase 3)">
              Create issue
            </Button>
          </div>
        </CardHeader>
        <div className="p-3">
          <Textarea readOnly rows={16} value={data.markdown} data-testid="summary-markdown" />
        </div>
      </Card>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <ul className="space-y-1.5 px-4 py-3 text-sm" data-testid={testId}>
        {children}
      </ul>
    </Card>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <li className="text-[var(--color-muted)]">{children}</li>;
}
