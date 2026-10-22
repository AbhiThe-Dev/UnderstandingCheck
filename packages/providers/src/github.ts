import { createHash, createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export interface RepoRef {
  installationId: number;
  owner: string;
  name: string;
}

export interface HostRepo extends RepoRef {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  htmlUrl: string;
}

export interface TreeEntry {
  path: string;
  /** Git blob SHA: equal SHAs mean identical content. */
  sha: string;
  size: number;
}

export interface IssueSnapshot {
  number: number;
  title: string;
  state: string;
  url: string;
  body: string;
  comments: { author: string; body: string }[];
}

/** The app can no longer read this repository (uninstalled, repo removed from the installation, or deleted). */
export class RepoAccessError extends Error {
  readonly code = 'repo_access_revoked';
}

/**
 * Read-only access to hosted repositories. Implemented for GitHub Apps; a fake implementation backs
 * tests. Nothing here can write to a repository.
 */
export interface RepoHost {
  readonly name: string;
  appInfo(): Promise<{ id: number; slug: string; owner: string; installUrl: string }>;
  listRepositories(): Promise<HostRepo[]>;
  headCommit(ref: RepoRef, branch: string): Promise<string>;
  tree(ref: RepoRef, commitSha: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, blobSha: string): Promise<string>;
  /** Materialize the files of one commit into `dir` (shallow, read-only). */
  checkout(ref: RepoRef, commitSha: string, dir: string): Promise<void>;
  issue(ref: RepoRef, number: number): Promise<IssueSnapshot>;
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  /** Base for git clone URLs; tests point this at a local directory. */
  gitBaseUrl?: string;
  fetch?: typeof fetch;
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * GitHub App client. Every request for repository data uses an installation token narrowed to that
 * single repository and to read-only permissions; tokens live only in memory until shortly before expiry.
 */
export class GitHubAppHost implements RepoHost {
  readonly name = 'github';
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly api: string;
  private readonly gitBase: string;
  private readonly http: typeof fetch;

  constructor(private readonly opts: GitHubAppOptions) {
    this.api = opts.apiUrl ?? 'https://api.github.com';
    this.gitBase = opts.gitBaseUrl ?? 'https://github.com';
    this.http = opts.fetch ?? fetch;
  }

  private appJwt(): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    // Backdated a minute for clock drift; GitHub allows at most 10 minutes.
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: this.opts.appId })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(this.opts.privateKey, 'base64url')}`;
  }

  private async request<T>(path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http(`${this.api}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${auth}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'understanding-check',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const rateLimited = res.headers.get('x-ratelimit-remaining') === '0';
    if (!rateLimited && (res.status === 404 || res.status === 403 || res.status === 401)) {
      throw new RepoAccessError(`GitHub denied access (${res.status}): ${body.message ?? res.statusText}`);
    }
    throw new Error(`GitHub API ${res.status} on ${path}: ${body.message ?? res.statusText}`);
  }

  /** Installation token scoped to one repository with read-only permissions. */
  private async token(ref: RepoRef, permissions: Record<string, 'read'> = { contents: 'read', metadata: 'read' }): Promise<string> {
    const key = `${ref.installationId}:${ref.owner}/${ref.name}:${Object.keys(permissions).sort().join(',')}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
    const res = await this.request<{ token: string; expires_at: string }>(`/app/installations/${ref.installationId}/access_tokens`, this.appJwt(), {
      method: 'POST',
      body: { repositories: [ref.name], permissions },
    });
    this.tokens.set(key, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  async appInfo() {
    const app = await this.request<{ id: number; slug: string; owner: { login: string }; html_url: string }>('/app', this.appJwt());
    return { id: app.id, slug: app.slug, owner: app.owner.login, installUrl: `${app.html_url}/installations/new` };
  }

  async listRepositories(): Promise<HostRepo[]> {
    const installs = await this.request<{ id: number }[]>('/app/installations', this.appJwt());
    const out: HostRepo[] = [];
    for (const inst of installs) {
      // Listing needs a token for the installation as a whole, but only metadata.
      const { token } = await this.request<{ token: string }>(`/app/installations/${inst.id}/access_tokens`, this.appJwt(), {
        method: 'POST',
        body: { permissions: { metadata: 'read' } },
      });
      for (let page = 1; page < 20; page++) {
        const res = await this.request<{ repositories: GhRepo[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
        out.push(...res.repositories.map((r) => toHostRepo(inst.id, r)));
        if (res.repositories.length < 100) break;
      }
    }
    return out;
  }

  async headCommit(ref: RepoRef, branch: string) {
    const c = await this.request<{ sha: string }>(`/repos/${ref.owner}/${ref.name}/commits/${encodeURIComponent(branch)}`, await this.token(ref));
    return c.sha;
  }

  async tree(ref: RepoRef, commitSha: string): Promise<TreeEntry[]> {
    const t = await this.request<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean }>(
      `/repos/${ref.owner}/${ref.name}/git/trees/${commitSha}?recursive=1`,
      await this.token(ref),
    );
    if (t.truncated) throw new Error('Repository tree is too large for the GitHub tree API; full re-index required');
    return t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
  }

  async blob(ref: RepoRef, blobSha: string) {
    const b = await this.request<{ content: string; encoding: string }>(`/repos/${ref.owner}/${ref.name}/git/blobs/${blobSha}`, await this.token(ref));
    return Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }

  async checkout(ref: RepoRef, commitSha: string, dir: string) {
    const token = await this.token(ref);
    // The token goes in an env-provided git config header, not the URL or argv, so it never lands in
    // .git/config, shell history or the process list.
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    };
    const git = (args: string[]) => promisify(execFile)('git', args, { cwd: dir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    await mkdir(dir, { recursive: true });
    await git(['init', '-q']);
    await git(['remote', 'add', 'origin', `${this.gitBase}/${ref.owner}/${ref.name}.git`]);
    await git(['fetch', '-q', '--depth', '1', '--no-tags', 'origin', commitSha]);
    await git(['checkout', '-q', 'FETCH_HEAD']);
  }

  async issue(ref: RepoRef, number: number): Promise<IssueSnapshot> {
    const token = await this.token(ref, { issues: 'read', metadata: 'read' });
    const i = await this.request<{ number: number; title: string; state: string; html_url: string; body: string | null; pull_request?: unknown }>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}`,
      token,
    );
    const comments = await this.request<{ user: { login: string } | null; body: string | null }[]>(`/repos/${ref.owner}/${ref.name}/issues/${number}/comments?per_page=20`, token);
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      body: i.body ?? '',
      comments: comments.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '' })),
    };
  }
}

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  html_url: string;
  owner: { login: string };
}

function toHostRepo(installationId: number, r: GhRepo): HostRepo {
  return {
    installationId,
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    language: r.language,
    htmlUrl: r.html_url,
  };
}

/** Git's blob object id for some content. */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * In-memory stand-in for GitHub, for tests and offline development. Supports pushing new commits,
 * removing access, and counts what was fetched so tests can assert incremental behavior.
 */
export class FakeRepoHost implements RepoHost {
  readonly name = 'fake';
  readonly calls = { blob: 0, checkout: 0, tree: 0 };
  private repos = new Map<string, { repo: HostRepo; commits: Map<string, Record<string, string>>; head: string; revoked: boolean; issues: Map<number, IssueSnapshot> }>();

  addRepo(fullName: string, files: Record<string, string>, opts: { installationId?: number; private?: boolean } = {}) {
    const [owner, name] = fullName.split('/') as [string, string];
    const repo: HostRepo = {
      installationId: opts.installationId ?? 1,
      id: this.repos.size + 1,
      owner,
      name,
      fullName,
      private: opts.private ?? true,
      defaultBranch: 'main',
      language: 'TypeScript',
      htmlUrl: `https://github.com/${fullName}`,
    };
    this.repos.set(fullName, { repo, commits: new Map(), head: '', revoked: false, issues: new Map() });
    return this.push(fullName, files);
  }

  /** Simulate a push: returns the new commit SHA. */
  push(fullName: string, files: Record<string, string>): string {
    const r = this.repos.get(fullName)!;
    const sha = createHash('sha1').update(JSON.stringify(Object.entries(files).sort())).update(String(r.commits.size)).digest('hex');
    r.commits.set(sha, { ...files });
    r.head = sha;
    return sha;
  }

  revoke(fullName: string) {
    this.repos.get(fullName)!.revoked = true;
  }

  addIssue(fullName: string, issue: IssueSnapshot) {
    this.repos.get(fullName)!.issues.set(issue.number, issue);
  }

  private get(ref: RepoRef) {
    const r = this.repos.get(`${ref.owner}/${ref.name}`);
    if (!r || r.revoked || r.repo.installationId !== ref.installationId) throw new RepoAccessError('GitHub denied access (404): Not Found');
    return r;
  }

  async appInfo() {
    return { id: 1, slug: 'fake-app', owner: 'tester', installUrl: 'https://github.com/apps/fake-app/installations/new' };
  }

  async listRepositories() {
    return [...this.repos.values()].filter((r) => !r.revoked).map((r) => r.repo);
  }

  async headCommit(ref: RepoRef) {
    return this.get(ref).head;
  }

  async tree(ref: RepoRef, commitSha: string) {
    this.calls.tree++;
    const files = this.get(ref).commits.get(commitSha);
    if (!files) throw new Error(`No commit ${commitSha}`);
    return Object.entries(files).map(([path, content]) => ({ path, sha: gitBlobSha(content), size: Buffer.byteLength(content) }));
  }

  async blob(ref: RepoRef, blobSha: string) {
    this.calls.blob++;
    for (const files of this.get(ref).commits.values()) {
      for (const content of Object.values(files)) if (gitBlobSha(content) === blobSha) return content;
    }
    throw new Error(`No blob ${blobSha}`);
  }

  async checkout(ref: RepoRef, commitSha: string, dir: string) {
    this.calls.checkout++;
    const files = this.get(ref).commits.get(commitSha);
    if (!files) throw new Error(`No commit ${commitSha}`);
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }

  async issue(ref: RepoRef, number: number) {
    const i = this.get(ref).issues.get(number);
    if (!i) throw new RepoAccessError('GitHub denied access (404): Not Found');
    return i;
  }
}
