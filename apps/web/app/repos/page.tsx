'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, CardTitle, Empty, buttonVariants } from '@/components/ui/primitives';
import { API_URL, api, type RepoRow, type Samples, type SlackStatus } from '@/lib/api';
import { shortSha } from '@/lib/utils';

interface GitHubStatus {
  configured: boolean;
  message: string;
  error?: string;
  app?: { slug: string; owner: string; installUrl: string };
}

interface HostedRepo {
  fullName: string;
  private: boolean;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  connectedRepositoryId: string | null;
}

const STATUS_TONE: Record<RepoRow['indexingStatus'], 'green' | 'red' | 'amber' | 'neutral'> = {
  ready: 'green',
  failed: 'red',
  revoked: 'red',
  indexing: 'amber',
  pending: 'amber',
};

const SLACK_ERRORS: Record<string, string> = {
  access_denied: 'Slack access was not granted.',
  state_mismatch: 'That Slack sign-in link expired or was not started here. Try Connect again.',
  exchange_failed: 'Slack did not accept the sign-in. Check the client ID, secret and redirect URL.',
  not_configured: 'Slack is not configured on the server.',
};

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

export default function ReposPage() {
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [samples, setSamples] = useState<Samples | null>(null);
  const [github, setGithub] = useState<GitHubStatus | null>(null);
  const [hosted, setHosted] = useState<HostedRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [slack, setSlack] = useState<SlackStatus | null>(null);

  const loadSlack = useCallback(() => api<SlackStatus>('/api/slack/status').then(setSlack, () => undefined), []);

  const load = useCallback(async () => {
    try {
      setRepos(await api<RepoRow[]>('/api/repos'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadHosted = useCallback(async () => {
    try {
      setHosted(await api<HostedRepo[]>('/api/github/repositories'));
    } catch {
      setHosted(null);
    }
  }, []);

  // Slack sends the browser back here with ?slack=connected or ?slack=error&reason=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const result = q.get('slack');
    if (!result) return;
    if (result === 'connected') setNotice('Slack connected.');
    else setError(SLACK_ERRORS[q.get('reason') ?? ''] ?? `Slack connection failed (${q.get('reason') ?? 'unknown'}).`);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    void loadSlack();
    void load();
    api<Samples>('/api/samples').then(setSamples, () => undefined);
    api<GitHubStatus>('/api/github/status').then((s) => {
      setGithub(s);
      if (s.configured) void loadHosted();
    }, () => undefined);
  }, [load, loadHosted, loadSlack]);

  // Poll while anything is indexing so progress stays visible.
  useEffect(() => {
    if (!repos.some((r) => r.indexingStatus === 'indexing' || r.indexingStatus === 'pending')) return;
    const t = setInterval(load, 800);
    return () => clearInterval(t);
  }, [repos, load]);

  const run = async (fn: () => Promise<unknown>, done?: (r: unknown) => string | null) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      setNotice(done?.(r) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
    if (github?.configured) await loadHosted();
  };

  const syncNotice = (r: unknown) => {
    const s = r as { mode: string; fetched: number; files: number };
    if (s.mode === 'unchanged') return 'Already up to date.';
    if (s.mode === 'revoked') return 'The app no longer has access; cached code was deleted.';
    return `Synced (${s.mode}): ${s.fetched} of ${s.files} files downloaded.`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Repositories</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-muted)]" data-testid="repo-notice">{notice}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader>
            <CardTitle>Indexed repositories</CardTitle>
          </CardHeader>
          {repos.length === 0 && <Empty>No repositories connected.</Empty>}
          <ul className="divide-y divide-[var(--color-line)]">
            {repos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm" data-testid={`repo-${r.sampleKey ?? r.name}`}>
                <div className="min-w-0">
                  <div className="font-medium">
                    {r.htmlUrl ? (
                      <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {r.name}
                      </a>
                    ) : (
                      r.name
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {r.source === 'sample' ? 'Sample repository' : `GitHub · ${r.defaultBranch}`} · TypeScript/JavaScript via Tree-sitter
                    {r.indexingStatus === 'ready' && ` · ${r.symbolCount} symbols at ${shortSha(r.indexedCommitSha)}`}
                  </div>
                  {r.source === 'github' && r.indexingStatus !== 'revoked' && (
                    <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                      Last checked {ago(r.lastSyncedAt)}
                      {r.lastSync && r.lastSync.mode !== 'unchanged' && ` · last change: ${r.lastSync.mode}, ${r.lastSync.fetched}/${r.lastSync.files} files downloaded`}
                    </div>
                  )}
                  {(r.indexingStatus === 'failed' || r.indexingStatus === 'revoked') && <div className="mt-1 text-xs text-red-600">{r.indexingError}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[r.indexingStatus]}>
                    {r.indexingStatus === 'revoked' ? 'access revoked' : r.indexingStatus}
                    {r.indexingStatus === 'indexing' && r.indexingProgress?.total ? ` ${r.indexingProgress.done}/${r.indexingProgress.total}` : ''}
                  </Badge>
                  {r.source === 'github' && r.indexingStatus !== 'indexing' && (
                    <Button size="sm" onClick={() => run(() => api(`/api/repos/${r.id}/sync`, { method: 'POST' }), syncNotice)} data-testid={`sync-${r.name}`}>
                      Sync now
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" title="Download and parse everything again" onClick={() => run(() => api(`/api/repos/${r.id}/index`, { method: 'POST' }))}>
                    Re-index
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => confirm(`Disconnect ${r.name} and delete its cached code and index?`) && run(() => api(`/api/repos/${r.id}`, { method: 'DELETE' }))}
                  >
                    {r.source === 'github' ? 'Disconnect' : 'Delete'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Connect GitHub</CardTitle>
              <Badge tone={github?.configured ? 'green' : 'neutral'}>{github?.configured ? 'app connected' : 'not configured'}</Badge>
            </CardHeader>
            <div className="space-y-3 px-4 py-3 text-sm">
              <p className="text-xs text-[var(--color-muted)]">{github?.message ?? 'Checking…'}</p>
              {github?.error && <p className="text-xs text-red-600">{github.error}</p>}
              {github?.configured && (
                <>
                  {hosted === null && <p className="text-xs text-[var(--color-muted)]">Loading repositories…</p>}
                  {hosted?.length === 0 && <p className="text-xs text-[var(--color-muted)]">The app is not installed on any repository yet.</p>}
                  <ul className="divide-y divide-[var(--color-line)] rounded border border-[var(--color-line)]" data-testid="github-repos">
                    {hosted?.map((h) => (
                      <li key={h.fullName} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{h.fullName}</div>
                          <div className="text-xs text-[var(--color-muted)]">
                            {h.private ? 'private' : 'public'} · {h.language ?? 'no language detected'} · {h.defaultBranch}
                          </div>
                        </div>
                        {h.connectedRepositoryId ? (
                          <Badge tone="green">connected</Badge>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => run(() => api('/api/repos/github', { body: { fullName: h.fullName } }), () => `Connecting ${h.fullName}: indexing in the background.`)}
                            data-testid={`connect-${h.fullName}`}
                          >
                            Connect
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {github.app && (
                    <a href={github.app.installUrl} target="_blank" rel="noreferrer" className="block text-xs text-[var(--color-accent)]">
                      Install the app on more repositories ↗
                    </a>
                  )}
                  <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
                    Read-only: code is fetched with short-lived tokens limited to one repository. New commits are picked up every few minutes, downloading only changed files.
                    Removing a repository from the app’s installation deletes its cached code here on the next check.
                  </p>
                </>
              )}
            </div>
          </Card>

          <Card data-testid="slack-card">
            <CardHeader>
              <CardTitle>Connect Slack</CardTitle>
              <Badge tone={slack?.connected ? 'green' : slack?.problem ? 'red' : 'neutral'}>
                {slack?.connected ? 'connected' : slack?.configured ? 'not connected' : 'not configured'}
              </Badge>
            </CardHeader>
            <div className="space-y-3 px-4 py-3 text-sm">
              {!slack && <p className="text-xs text-[var(--color-muted)]">Checking…</p>}
              {slack && !slack.configured && <p className="text-xs text-[var(--color-muted)]">{slack.message}</p>}
              {slack?.connected && (
                <p className="text-xs">
                  {slack.source === 'env' ? 'Using the token from SLACK_USER_TOKEN.' : `Connected to ${slack.team} as ${slack.user}.`}{' '}
                  Searches {slack.privateAccess ? 'public channels, private channels you are in, and your DMs' : 'public channels'}.
                </p>
              )}
              {slack?.problem && <p className="text-xs text-red-600">{slack.problem}</p>}
              {slack?.configured && slack.canConnect && (
                <div className="flex gap-2">
                  <a href={`${API_URL}/api/slack/connect`} className={buttonVariants({ size: 'sm' })} data-testid="slack-connect">
                    {slack.connected && slack.source === 'oauth' ? 'Reconnect' : 'Connect Slack'}
                  </a>
                  {slack.source === 'oauth' && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => confirm('Disconnect Slack? The token is revoked and deleted.') && run(() => api('/api/slack', { method: 'DELETE' }), () => 'Slack disconnected.').then(loadSlack)}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              )}
              {slack?.configured && (
                <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
                  During meetings the copilot searches Slack for the topic under discussion and links what it finds. Message text is sent to the analyzer (OpenAI when the AI
                  analyzer is on) but is never stored here: suggestions, summaries and records keep only links. Messages from private channels and DMs are shown without
                  channel or author names, and their excerpts stay hidden until you reveal them.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sample repositories</CardTitle>
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
        </div>
      </div>
    </div>
  );
}
