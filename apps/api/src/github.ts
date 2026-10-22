import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepositoryRow, WorkspaceStore } from '@uc/db';
import { MAX_FILE_BYTES, indexFiles, shouldIndexPath } from '@uc/indexer';
import { RepoAccessError, type IssueSnapshot, type RepoHost, type RepoRef } from '@uc/providers';

export interface SyncResult {
  mode: 'full' | 'incremental' | 'unchanged' | 'revoked';
  commitSha: string | null;
  changed: number;
  removed: number;
  fetched: number;
  files: number;
  durationMs: number;
}

const BLOB_CONCURRENCY = 4;

export function refOf(repo: RepositoryRow): RepoRef {
  if (repo.source !== 'github' || !repo.githubInstallationId || !repo.githubOwner || !repo.githubName) {
    throw new Error('Not a GitHub repository');
  }
  return { installationId: Number(repo.githubInstallationId), owner: repo.githubOwner, name: repo.githubName };
}

/**
 * Keeps a GitHub repository's index current, read-only:
 * - first sync: shallow checkout of one commit into a private temp directory, deleted afterwards;
 * - later syncs: compare git blob SHAs with the cached file set and download only changed files;
 * - access lost (app uninstalled, repo removed from the installation): delete cached code.
 * Files are re-parsed from the cache on every change; parsing is cheap compared with fetching.
 */
export class GitHubSync {
  private running = new Map<string, Promise<SyncResult>>();

  constructor(
    private store: WorkspaceStore,
    private host: RepoHost,
  ) {}

  sync(repositoryId: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
    const inFlight = this.running.get(repositoryId);
    if (inFlight) return inFlight;
    const p = this.run(repositoryId, opts).finally(() => this.running.delete(repositoryId));
    this.running.set(repositoryId, p);
    return p;
  }

  private async run(repositoryId: string, opts: { force?: boolean }): Promise<SyncResult> {
    const started = Date.now();
    const repo = await this.store.getRepository(repositoryId);
    if (!repo) throw new Error('Repository not found');
    const ref = refOf(repo);
    const done = (r: Omit<SyncResult, 'durationMs'>): SyncResult => ({ ...r, durationMs: Date.now() - started });

    try {
      const head = await this.host.headCommit(ref, repo.defaultBranch);
      const cached = await this.store.repositoryFiles(repositoryId);
      if (!opts.force && head === repo.indexedCommitSha && cached.length > 0 && repo.indexingStatus === 'ready') {
        const r = done({ mode: 'unchanged', commitSha: head, changed: 0, removed: 0, fetched: 0, files: cached.length });
        await this.store.updateRepository(repositoryId, { lastSyncedAt: new Date(), lastSync: { ...r, mode: 'unchanged' } });
        return r;
      }

      await this.store.updateRepository(repositoryId, { indexingStatus: 'indexing', indexingError: null, indexingProgress: { done: 0, total: 0 } });
      const tree = (await this.host.tree(ref, head)).filter((e) => shouldIndexPath(e.path) && e.size <= MAX_FILE_BYTES);
      const bySha = new Map(cached.map((f) => [f.path, f]));
      const full = cached.length === 0 || Boolean(opts.force);
      const files: { path: string; blobSha: string; content: string }[] = [];
      let fetched = 0;

      if (full) {
        const dir = await mkdtemp(join(tmpdir(), 'uc-sync-')); // created with 0700 permissions
        try {
          await this.host.checkout(ref, head, dir);
          for (const e of tree) files.push({ path: e.path, blobSha: e.sha, content: await readFile(join(dir, e.path), 'utf8') });
          fetched = tree.length;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else {
        const toFetch = tree.filter((e) => bySha.get(e.path)?.blobSha !== e.sha);
        const fetchedContent = new Map<string, string>();
        for (let i = 0; i < toFetch.length; i += BLOB_CONCURRENCY) {
          const batch = toFetch.slice(i, i + BLOB_CONCURRENCY);
          const contents = await Promise.all(batch.map((e) => this.host.blob(ref, e.sha)));
          batch.forEach((e, j) => fetchedContent.set(e.path, contents[j]!));
        }
        fetched = toFetch.length;
        for (const e of tree) files.push({ path: e.path, blobSha: e.sha, content: fetchedContent.get(e.path) ?? bySha.get(e.path)!.content });
      }

      const treePaths = new Set(tree.map((e) => e.path));
      const removed = cached.filter((f) => !treePaths.has(f.path)).length;
      const changed = full ? files.length : fetched;

      let lastReported = 0;
      const indexed = await indexFiles(
        files.map((f) => ({ path: f.path, source: f.content })),
        head,
        (n, total) => {
          if (n - lastReported >= 50 || n === total) {
            lastReported = n;
            void this.store.updateRepository(repositoryId, { indexingProgress: { done: n, total } });
          }
        },
      );
      await this.store.replaceRepositoryFiles(repositoryId, files);
      await this.store.replaceSymbols(repositoryId, head, indexed.symbols, await this.store.activeSessionCommits(repositoryId));
      const r = done({ mode: full ? 'full' : 'incremental', commitSha: head, changed, removed, fetched, files: files.length });
      await this.store.updateRepository(repositoryId, { lastSyncedAt: new Date(), lastSync: { ...r, mode: full ? 'full' : 'incremental' } });
      return r;
    } catch (err) {
      if (err instanceof RepoAccessError) {
        // We may no longer hold this code: delete it, keep the repository row so the user sees why.
        await this.store.purgeRepositoryCode(repositoryId);
        await this.store.updateRepository(repositoryId, {
          indexingStatus: 'revoked',
          indexingError: 'The GitHub App no longer has access to this repository. Cached code was deleted. Reinstall the app on it to reconnect.',
          symbolCount: 0,
          indexedCommitSha: null,
          lastSyncedAt: new Date(),
        });
        return done({ mode: 'revoked', commitSha: null, changed: 0, removed: 0, fetched: 0, files: 0 });
      }
      await this.store.updateRepository(repositoryId, { indexingStatus: 'failed', indexingError: (err as Error).message });
      throw err;
    }
  }
}

/** "#12", "12", "owner/name#12" or an issue URL → issue number, if it belongs to this repository. */
export function parseIssueRef(input: string, repo: { owner: string; name: string }): number | null {
  const s = input.trim();
  const url = s.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i);
  const qualified = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  const owner = url?.[1] ?? qualified?.[1];
  const name = url?.[2] ?? qualified?.[2];
  if (owner && name && (owner.toLowerCase() !== repo.owner.toLowerCase() || name.toLowerCase() !== repo.name.toLowerCase())) return null;
  const n = url?.[3] ?? qualified?.[3] ?? s.match(/^#?(\d+)$/)?.[1];
  return n ? Number(n) : null;
}

/** A short, plain feature description from an issue (title + first paragraph). */
export function issueToFeature(issue: IssueSnapshot): { featureDescription: string; snapshot: { number: number; title: string; state: string; url: string; bodyExcerpt: string } } {
  const firstParagraph = issue.body.split(/\n\s*\n/).find((p) => p.trim())?.replace(/\s+/g, ' ').trim() ?? '';
  const excerpt = firstParagraph.length > 300 ? `${firstParagraph.slice(0, 299)}…` : firstParagraph;
  return {
    featureDescription: excerpt ? `${issue.title}. ${excerpt}` : issue.title,
    snapshot: { number: issue.number, title: issue.title, state: issue.state, url: issue.url, bodyExcerpt: issue.body.slice(0, 600) },
  };
}
