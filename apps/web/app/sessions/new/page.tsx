'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, Input, Label, Textarea } from '@/components/ui/primitives';
import { api, type RepoRow, type Samples } from '@/lib/api';
import { shortSha } from '@/lib/utils';

export default function NewSessionPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [samples, setSamples] = useState<Samples | null>(null);
  const [title, setTitle] = useState('');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [feature, setFeature] = useState('');
  const [issue, setIssue] = useState('');
  const [sampleId, setSampleId] = useState('');
  const [consent, setConsent] = useState(false);
  const [includeRecords, setIncludeRecords] = useState(true);
  const [activeRecords, setActiveRecords] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<RepoRow[]>('/api/repos').then((r) => {
      setRepos(r);
      const ready = r.find((x) => x.indexingStatus === 'ready');
      if (ready) setRepositoryId(ready.id);
    }, (e: Error) => setError(e.message));
    api<Samples>('/api/samples').then(setSamples, () => undefined);
  }, []);

  const sample = samples?.transcripts.find((t) => t.id === sampleId);

  useEffect(() => {
    if (!repositoryId) return setActiveRecords(null);
    api<unknown[]>(`/api/requirements?status=active&repositoryId=${repositoryId}`).then((r) => setActiveRecords(r.length), () => setActiveRecords(null));
  }, [repositoryId]);

  const pickSample = (id: string) => {
    setSampleId(id);
    const t = samples?.transcripts.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title);
    setFeature(t.featureDescription);
    const repo = repos.find((r) => r.sampleKey === t.repo && r.indexingStatus === 'ready');
    if (repo) setRepositoryId(repo.id);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>('/api/sessions', {
        body: {
          title: title || 'Untitled discussion',
          repositoryId: repositoryId || null,
          featureDescription: feature || null,
          githubIssueReference: issue || null,
          consentConfirmed: consent,
          priorDecisions: sample?.priorDecisions.length ? sample.priorDecisions : undefined,
          includeRecords,
        },
      });
      router.push(`/sessions/${id}${sampleId ? `?sample=${sampleId}` : ''}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const needsRepo = sample?.repo && !repos.some((r) => r.sampleKey === sample.repo && r.indexingStatus === 'ready');

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">New discussion session</h1>
      <Card className="space-y-4 p-5">
        <div>
          <Label htmlFor="sample">Start from a sample conversation (optional)</Label>
          <select id="sample" className="h-9 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-sm" value={sampleId} onChange={(e) => pickSample(e.target.value)}>
            <option value="">— none —</option>
            {samples?.transcripts.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          {needsRepo && <p className="mt-1 text-xs text-amber-700">Load the “{sample?.repo}” sample repository first (Repositories page).</p>}
        </div>
        <div>
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Undo approvals" />
        </div>
        <div>
          <Label htmlFor="repo">Repository</Label>
          <select id="repo" className="h-9 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-sm" value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
            <option value="">No repository (conversation-only analysis)</option>
            {repos
              .filter((r) => r.indexingStatus === 'ready')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} @ {shortSha(r.indexedCommitSha)}
                </option>
              ))}
          </select>
        </div>
        <div>
          <Label htmlFor="feature">Change being discussed (optional)</Label>
          <Textarea id="feature" rows={2} value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="Allow administrators to undo an approval" className="font-sans text-sm" />
        </div>
        <div>
          <Label htmlFor="issue">GitHub issue (optional)</Label>
          <Input id="issue" value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="org/repo#123" />
        </div>
        {repositoryId && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={includeRecords} onChange={(e) => setIncludeRecords(e.target.checked)} className="mt-0.5" />
            <span>
              Check the discussion against this repository’s agreed requirements
              <span className="text-[var(--color-muted)]"> ({activeRecords ?? '…'} active)</span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" data-testid="consent" />
          <span>
            Everyone in this discussion knows it is being transcribed and analyzed. Only transcript text is stored (no audio), and it can be deleted at any time.
          </span>
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!consent || busy} type="submit">
            {busy ? 'Creating…' : 'Start session'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
