'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@/components/ui/primitives';
import { API_URL, api, type RecordListItem } from '@/lib/api';
import { cn } from '@/lib/utils';

type Filter = 'active' | 'retired' | 'all';

export default function RequirementsPage() {
  const [filter, setFilter] = useState<Filter>('active');
  const [rows, setRows] = useState<RecordListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    api<RecordListItem[]>(`/api/requirements${filter === 'all' ? '' : `?status=${filter}`}`).then(setRows, (e: Error) => setError(e.message));
  }, [filter]);

  const exportUrl = (format: 'md' | 'json') => `${API_URL}/api/requirements/export?format=${format}${filter === 'all' ? '' : `&status=${filter}`}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Agreed requirements</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Decisions confirmed in discussions, kept as versioned records. New sessions on the same repository are checked against active records, so a later
            meeting that changes a decision creates a new version instead of silently contradicting it.
          </p>
        </div>
        <div className="flex gap-2">
          <a href={exportUrl('md')} download>
            <Button size="sm">Export Markdown</Button>
          </a>
          <a href={exportUrl('json')} download>
            <Button size="sm">Export JSON</Button>
          </a>
        </div>
      </div>

      <div className="flex gap-1 text-sm" role="tablist">
        {(['active', 'retired', 'all'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn('rounded px-3 py-1 capitalize', filter === f ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-muted)] hover:bg-[var(--color-canvas)]')}
          >
            {f}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <Card>
        {rows && rows.length === 0 && <Empty>No {filter === 'all' ? '' : filter} requirements yet. They are recorded when a session with confirmed decisions ends.</Empty>}
        {!rows && !error && <Empty>Loading…</Empty>}
        <ul className="divide-y divide-[var(--color-line)]" data-testid="requirements">
          {rows?.map((r) => (
            <li key={r.id}>
              <Link href={`/requirements/${r.id}`} className="block px-4 py-3 hover:bg-[var(--color-canvas)]">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-[var(--color-muted)]">{r.label}</span>
                  <span className="font-medium">{r.title}</span>
                  <Badge tone={r.status === 'active' ? 'green' : 'neutral'}>{r.status}</Badge>
                  <Badge>v{r.currentVersion}</Badge>
                  <Badge tone={r.current.confirmation === 'clarified' ? 'accent' : 'blue'}>{r.current.confirmation === 'clarified' ? 'confirmed through clarification' : 'verbal agreement'}</Badge>
                  {r.reaffirmations.length > 0 && <Badge>reaffirmed ×{r.reaffirmations.length}</Badge>}
                </div>
                {r.current.description !== r.title && <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{r.current.description}</p>}
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {r.repositoryName ?? 'No repository'} · confirmed by {r.current.confirmedBy.join(', ') || '—'} · last confirmed {new Date(r.lastConfirmedAt).toLocaleDateString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
