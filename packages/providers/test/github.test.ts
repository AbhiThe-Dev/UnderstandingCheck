import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitHubAppHost, RepoAccessError, gitBlobSha } from '../src';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const REF = { installationId: 42, owner: 'acme', name: 'app' };

/** A fetch stub that records requests and answers from a routing table. */
function stubFetch(routes: Record<string, (body: any) => { status?: number; json: unknown; headers?: Record<string, string> }>) {
  const calls: { method: string; path: string; auth: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, auth: String((init.headers as Record<string, string>).authorization), body });
    const route = Object.entries(routes).find(([k]) => `${init.method ?? 'GET'} ${path}`.startsWith(k));
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const r = route[1](body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const tokenRoute = () => ({ json: { token: `ghs_test${Math.random().toString(36).slice(2)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } });

describe('GitHubAppHost', () => {
  it('signs app requests with an RS256 JWT and narrows installation tokens to one repo, read-only', async () => {
    const { fn, calls } = stubFetch({
      'POST /app/installations/42/access_tokens': tokenRoute,
      'GET /repos/acme/app/commits/main': () => ({ json: { sha: 'abc123' } }),
    });
    const host = new GitHubAppHost({ appId: '99', privateKey, fetch: fn });
    expect(await host.headCommit(REF, 'main')).toBe('abc123');

    const mint = calls[0]!;
    expect(mint.body).toEqual({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } });
    const [header, payload] = mint.auth.replace('Bearer ', '').split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe('99');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(calls[1]!.auth).toMatch(/^Bearer ghs_test/);
  });

  it('reuses a token until shortly before it expires', async () => {
    const { fn, calls } = stubFetch({
      'POST /app/installations/42/access_tokens': tokenRoute,
      'GET /repos/acme/app/commits/main': () => ({ json: { sha: 'abc' } }),
    });
    const host = new GitHubAppHost({ appId: '99', privateKey, fetch: fn });
    await host.headCommit(REF, 'main');
    await host.headCommit(REF, 'main');
    expect(calls.filter((c) => c.path.endsWith('access_tokens'))).toHaveLength(1);
  });

  it('maps lost access to RepoAccessError, but not rate limiting', async () => {
    const denied = new GitHubAppHost({ appId: '99', privateKey, fetch: stubFetch({}).fn });
    await expect(denied.headCommit(REF, 'main')).rejects.toBeInstanceOf(RepoAccessError);

    const limited = new GitHubAppHost({
      appId: '99',
      privateKey,
      fetch: stubFetch({ 'POST /app/installations/42/access_tokens': () => ({ status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } }) }).fn,
    });
    const err = await limited.headCommit(REF, 'main').catch((e) => e);
    expect(err).not.toBeInstanceOf(RepoAccessError);
    expect(err.message).toMatch(/rate limit/);
  });

  it('decodes blobs and reads issues with an issues-scoped token', async () => {
    const { fn, calls } = stubFetch({
      'POST /app/installations/42/access_tokens': tokenRoute,
      'GET /repos/acme/app/git/blobs/': () => ({ json: { content: Buffer.from('export const x = 1;\n').toString('base64'), encoding: 'base64' } }),
      'GET /repos/acme/app/issues/5/comments': () => ({ json: [{ user: { login: 'pat' }, body: 'Also handle emails' }] }),
      'GET /repos/acme/app/issues/5': () => ({ json: { number: 5, title: 'Undo', state: 'open', html_url: 'https://github.com/acme/app/issues/5', body: null } }),
    });
    const host = new GitHubAppHost({ appId: '99', privateKey, fetch: fn });
    expect(await host.blob(REF, 'deadbeef')).toBe('export const x = 1;\n');
    expect(await host.issue(REF, 5)).toEqual({ number: 5, title: 'Undo', state: 'open', url: 'https://github.com/acme/app/issues/5', body: '', comments: [{ author: 'pat', body: 'Also handle emails' }] });
    expect(calls.find((c) => c.body?.permissions?.issues)!.body.permissions).toEqual({ issues: 'read', metadata: 'read' });
  });

  describe('shallow checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-gh-test-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('fetches exactly one commit, with the token kept out of the repository config', async () => {
      // A local "remote" laid out like github.com/<owner>/<name>.git
      const work = join(root, 'work');
      mkdirSync(join(work, 'src'), { recursive: true });
      const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      git(['init', '-q', '-b', 'main'], work);
      writeFileSync(join(work, 'src/a.ts'), 'export const a = 1;\n');
      git(['add', '.'], work);
      git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one'], work);
      const first = git(['rev-parse', 'HEAD'], work);
      writeFileSync(join(work, 'src/b.ts'), 'export const b = 2;\n');
      git(['add', '.'], work);
      git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two'], work);
      mkdirSync(join(root, 'remote/acme'), { recursive: true });
      git(['clone', '-q', '--bare', work, join(root, 'remote/acme/app.git')], root);
      git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], join(root, 'remote/acme/app.git'));

      const { fn } = stubFetch({ 'POST /app/installations/42/access_tokens': tokenRoute });
      const host = new GitHubAppHost({ appId: '99', privateKey, fetch: fn, gitBaseUrl: `file://${join(root, 'remote')}` });
      const dir = join(root, 'checkout');
      await host.checkout(REF, first, dir);

      expect(readdirSync(join(dir, 'src'))).toEqual(['a.ts']); // the older commit, not HEAD
      expect(readFileSync(join(dir, '.git/config'), 'utf8')).not.toMatch(/ghs_|extraheader|Authorization/i);
      expect(git(['rev-list', '--count', 'HEAD'], dir)).toBe('1'); // shallow
    });
  });

  it('computes git blob SHAs like git does', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
