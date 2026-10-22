'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, CardTitle, Empty } from '@/components/ui/primitives';
import { api, type RepoRow } from '@/lib/api';
import { shortSha, usd } from '@/lib/utils';

interface Dashboard {
  analyzer: 'heuristic' | 'llm';
  repos: RepoRow[];
  sessions: { id: string; title: string; status: string; startedAt: string; segmentCount: number; live: number }[];
  counts: { open: number; resolved: number; activeRequirements: number };
  budget: { spentUsd: number; limitUsd: number };
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api<Dashboard>('/api/dashboard').then(setData, (e: Error) => setError(e.message));
  }, []);

  const startDemo = async () => {
    setStarting(true);
    try {
      const { id } = await api<{ id: string }>('/api/demo', { method: 'POST' });
      router.push(`/sessions/${id}?sample=demo-undo-approval`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  if (error) {
    return (
      <Card className="p-6 text-sm">
        <p className="font-medium">Cannot reach the analysis service.</p>
        <p className="mt-1 text-[var(--color-muted)]">{error}. Start it with <code>pnpm dev</code> (runs the API on port 4000 and this app on 3000).</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Catch misunderstandings before they become code</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Connect a repository, replay or stream a discussion, and get quiet, evidence-backed clarification questions when people may expect different behavior.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Badge tone={data.analyzer === 'llm' ? 'accent' : 'neutral'} title="Set OPENAI_API_KEY and ANALYZER=llm to use the model-backed analyzer">
              Analyzer: {data.analyzer === 'llm' ? 'OpenAI' : 'heuristic (no API key)'}
            </Badge>
          )}
          <Button variant="primary" onClick={startDemo} disabled={starting} data-testid="start-demo">
            {starting ? 'Preparing demo…' : 'Try the demo'}
          </Button>
          <Link href="/sessions/new">
            <Button>New session</Button>
          </Link>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-5">
        <Stat label="Repositories" value={data?.repos.length} />
        <Stat label="Agreed requirements" value={data?.counts.activeRequirements} href="/requirements" />
        <Stat label="Open discrepancies" value={data?.counts.open} />
        <Stat label="Resolved misunderstandings" value={data?.counts.resolved} />
        <Stat label="Model spend this month" value={data ? `${usd(data.budget.spentUsd)} / ${usd(data.budget.limitUsd)}` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent sessions</CardTitle>
          </CardHeader>
          {data && data.sessions.length === 0 && <Empty>No sessions yet. Try the demo to see the seeded scenario.</Empty>}
          <ul className="divide-y divide-[var(--color-line)]">
            {data?.sessions.map((s) => (
              <li key={s.id}>
                <Link href={`/sessions/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-[var(--color-canvas)]">
                  <span className="truncate">{s.title}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--color-muted)]">
                    {s.live > 0 && <Badge tone="amber">{s.live} open</Badge>}
                    {s.segmentCount} segments · {s.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Connected repositories</CardTitle>
            <Link href="/repos" className="text-xs text-[var(--color-accent)]">
              Manage
            </Link>
          </CardHeader>
          {data && data.repos.length === 0 && <Empty>No repositories yet. Load a sample repository to begin.</Empty>}
          <ul className="divide-y divide-[var(--color-line)]">
            {data?.repos.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>{r.name}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {r.indexingStatus === 'ready' ? `${r.symbolCount} symbols @ ${shortSha(r.indexedCommitSha)}` : r.indexingStatus}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string | number | undefined; href?: string }) {
  const body = (
    <Card className="px-4 py-3">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value ?? '—'}</div>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
