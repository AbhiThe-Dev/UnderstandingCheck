import { describe, expect, it } from 'vitest';
import { FakeSlack, SLACK_USER_SCOPES, SlackAccessError, SlackApiClient, SlackRateLimited, SlackUnavailable, channelKindOf } from '../src';

/** A fetch stub that records Slack Web API calls and answers from a routing table keyed by method. */
function stubFetch(routes: Record<string, (body: any) => { status?: number; json: unknown; headers?: Record<string, string> }>) {
  const calls: { method: string; auth: string; body: any; contentType: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const method = new URL(url).pathname.replace('/api/', '');
    const headers = init.headers as Record<string, string>;
    const raw = init.body ? String(init.body) : '';
    const body = headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, auth: String(headers.authorization ?? ''), body, contentType: headers['content-type'] ?? '' });
    const route = routes[method];
    if (!route) return new Response(JSON.stringify({ ok: false, error: 'unknown_method' }), { status: 200 });
    const r = route(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const OPTS = { clientId: '123.456', clientSecret: 'shh', redirectUri: 'http://localhost:4000/api/slack/oauth/callback' };
const rts = (messages: object[]) => () => ({ json: { ok: true, results: { messages }, response_metadata: { next_cursor: '' } } });
const msg = (channel_id: string, content: string, channel_name = 'approvals') => ({
  author_name: 'Dana',
  author_user_id: 'U1',
  team_id: 'T1',
  channel_id,
  channel_name,
  message_ts: '1760000000.000100',
  content,
  permalink: `https://acme.slack.com/archives/${channel_id}/p1760000000000100`,
  context_messages: { before: [{ text: 'earlier' }], after: [{ text: 'later' }] },
});

describe('SlackApiClient', () => {
  it('asks for the four search scopes as user scopes and carries state', () => {
    const url = new URL(new SlackApiClient(OPTS).authorizeUrl('st4te'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(SLACK_USER_SCOPES.join(','));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe(OPTS.redirectUri);
  });

  it('exchanges a code for the user token and identity', async () => {
    const { fn, calls } = stubFetch({
      'oauth.v2.access': () => ({ json: { ok: true, authed_user: { id: 'U1', scope: 'search:read.public,search:read.im', access_token: 'xoxp-1' }, team: { id: 'T1', name: 'Acme' } } }),
      'auth.test': () => ({ json: { ok: true, team: 'Acme', user: 'dana', team_id: 'T1', user_id: 'U1' } }),
    });
    const r = await new SlackApiClient({ ...OPTS, fetch: fn }).exchangeCode('c0de');
    expect(r).toEqual({ token: 'xoxp-1', teamId: 'T1', teamName: 'Acme', userId: 'U1', userName: 'dana', scopes: ['search:read.public', 'search:read.im'] });
    expect(calls[0]!.body).toMatchObject({ client_id: '123.456', client_secret: 'shh', code: 'c0de', redirect_uri: OPTS.redirectUri });
    expect(calls[1]!.auth).toBe('Bearer xoxp-1');
  });

  it('searches public channels only in public scope', async () => {
    const { fn, calls } = stubFetch({ 'assistant.search.context': rts([msg('C1', 'two reviewers')]) });
    const out = await new SlackApiClient({ ...OPTS, fetch: fn }).search('xoxp-1', { query: 'reviewers', scope: 'public', limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ query: 'reviewers', channel_types: ['public_channel'], content_types: ['messages'], include_context_messages: true, limit: 20 });
    expect(calls[0]!.auth).toBe('Bearer xoxp-1');
    expect(out).toEqual([
      {
        permalink: 'https://acme.slack.com/archives/C1/p1760000000000100',
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'approvals',
        channelKind: 'public',
        authorId: 'U1',
        authorName: 'Dana',
        ts: '1760000000.000100',
        text: 'two reviewers',
        context: ['earlier', 'later'],
      },
    ]);
  });

  it('searches private conversations in a separate call and marks them private', async () => {
    const { fn, calls } = stubFetch({
      'assistant.search.context': (b) =>
        b.channel_types.includes('public_channel') ? rts([msg('C1', 'public')])() : rts([msg('C2', 'secret plan', 'leads'), msg('D3', 'dm text', 'U9'), msg('G4', 'group', 'mpdm-a--b-1')])(),
    });
    const out = await new SlackApiClient({ ...OPTS, fetch: fn }).search('xoxp-1', { query: 'plan', scope: 'all', after: 1_760_000_000_000 });
    expect(calls.map((c) => c.body.channel_types)).toEqual([['public_channel'], ['private_channel', 'mpim', 'im']]);
    expect(calls[0]!.body.after).toBe(1_760_000_000);
    expect(out.map((m) => [m.channelId, m.channelKind])).toEqual([
      ['C1', 'public'],
      ['C2', 'private'],
      ['D3', 'dm'],
      ['G4', 'dm'],
    ]);
  });

  it('maps Slack errors to typed errors', async () => {
    const client = (json: unknown, status = 200, headers?: Record<string, string>) =>
      new SlackApiClient({ ...OPTS, fetch: stubFetch({ 'assistant.search.context': () => ({ json, status, headers }) }).fn });
    const q = { query: 'x', scope: 'public' as const };
    await expect(client({ ok: false, error: 'token_revoked' }).search('t', q)).rejects.toBeInstanceOf(SlackAccessError);
    await expect(client({ ok: false, error: 'missing_scope' }).search('t', q)).rejects.toBeInstanceOf(SlackAccessError);
    await expect(client({ ok: false, error: 'feature_not_enabled' }).search('t', q)).rejects.toBeInstanceOf(SlackUnavailable);
    const limited = await client({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '12' }).search('t', q).catch((e) => e);
    expect(limited).toBeInstanceOf(SlackRateLimited);
    expect(limited.retryAfterMs).toBe(12_000);
    await expect(client({ ok: false, error: 'internal_error' }).search('t', q)).rejects.toThrow('internal_error');
  });

  it('drops results without a permalink or text', async () => {
    const { fn } = stubFetch({ 'assistant.search.context': rts([{ ...msg('C1', 'ok') }, { ...msg('C1', ''), content: '' }, { ...msg('C1', 'x'), permalink: undefined }]) });
    expect(await new SlackApiClient({ ...OPTS, fetch: fn }).search('t', { query: 'ok', scope: 'public' })).toHaveLength(1);
  });

  it('derives channel kinds from ids', () => {
    expect(channelKindOf('D1', 'U2', true)).toBe('dm');
    expect(channelKindOf('C1', 'general', false)).toBe('public');
    expect(channelKindOf('C1', 'leads', true)).toBe('private');
    expect(channelKindOf('G1', 'mpdm-a--b-1', true)).toBe('dm');
  });
});

describe('FakeSlack', () => {
  it('honours scope, revocation and one-time codes', async () => {
    const fake = new FakeSlack();
    fake.addMessage({ text: 'Approvals need two reviewers', channelName: 'approvals' });
    fake.addMessage({ text: 'Approvals stay single reviewer', channelKind: 'dm' });
    const code = fake.issueCode();
    const { token } = await fake.exchangeCode(code);
    await expect(fake.exchangeCode(code)).rejects.toThrow('invalid_code');
    expect((await fake.search(token, { query: 'approvals reviewers', scope: 'public' })).map((m) => m.channelKind)).toEqual(['public']);
    expect(await fake.search(token, { query: 'approvals reviewers', scope: 'all' })).toHaveLength(2);
    await fake.revoke(token);
    await expect(fake.search(token, { query: 'approvals', scope: 'all' })).rejects.toBeInstanceOf(SlackAccessError);
  });
});
