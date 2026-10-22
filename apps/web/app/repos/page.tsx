'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, CardTitle, Empty } from '@/components/ui/primitives';
import { api, type RepoRow, type Samples } from '@/lib/api';
import { shortSha } from '@/lib/utils';

export default function ReposPage() {
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [samples, setSamples] = useState<Samples | null>(null);
  const [github, setGithub] = useState<{ configured: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRepos(await api<RepoRow[]>('/api/repos'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    api<Samples>('/api/samples').then(setSamples, () => undefined);
    api<{ configured: boolean; message: string }>('/api/github/status').then(setGithub, () => undefined);
  }, [load]);

  // Poll while anything is indexing so progress stays visible.
  useEffect(() => {
    if (!repos.some((r) => r.indexingStatus === 'indexing' || r.indexingStatus === 'pending')) return;
    const t = setInterval(load, 800);
    return () => clearInterval(t);
  }, [repos, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Repositories</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Indexed repositories</CardTitle>
          </CardHeader>
          {repos.length === 0 && <Empty>No repositories connected.</Empty>}
          <ul className="divide-y divide-[var(--color-line)]">
            {repos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm" data-testid={`repo-${r.sampleKey}`}>
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {r.source === 'sample' ? 'Sample repository' : 'GitHub'} · TypeScript/JavaScript via Tree-sitter
                    {r.indexingStatus === 'ready' && ` · ${r.symbolCount} symbols at ${shortSha(r.indexedCommitSha)}`}
                  </div>
                  {r.indexingStatus === 'failed' && <div className="mt-1 text-xs text-red-600">{r.indexingError}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.indexingStatus === 'ready' ? 'green' : r.indexingStatus === 'failed' ? 'red' : 'amber'}>
                    {r.indexingStatus}
                    {r.indexingStatus === 'indexing' && r.indexingProgress?.total ? ` ${r.indexingProgress.done}/${r.indexingProgress.total}` : ''}
                  </Badge>
                  <Button size="sm" onClick={() => run(() => api(`/api/repos/${r.id}/index`, { method: 'POST' }))}>
                    Re-index
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => confirm(`Delete ${r.name} and its index?`) && run(() => api(`/api/repos/${r.id}`, { method: 'DELETE' }))}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Load a sample repository</CardTitle>
            </CardHeader>
            <ul className="divide-y divide-[var(--color-line)]">
              {samples?.repos.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="text-sm">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-[var(--color-muted)]">{s.description}</div>
                  </div>
                  <Button size="sm" onClick={() => run(() => api('/api/repos/sample', { body: { sampleKey: s.key } }))} data-testid={`load-${s.key}`}>
                    Load
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">Connect GitHub</span>
              <Badge>{github?.configured ? 'configured' : 'not configured'}</Badge>
            </div>
            <p className="mt-2 text-xs text-[var(--color-muted)]">{github?.message}</p>
            <Button className="mt-3 w-full" disabled>
              Install GitHub App (Phase 3)
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
