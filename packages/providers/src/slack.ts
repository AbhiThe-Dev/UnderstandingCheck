/**
 * Slack as meeting context: one user's OAuth token, searched on demand with Slack's Real-time
 * Search API (`assistant.search.context`). Slack's terms forbid storing what search returns, so
 * nothing here caches or persists messages; callers keep them in memory only.
 */

/** User scopes requested at Connect. Search only ever sees what the connecting user can see. */
export const SLACK_USER_SCOPES = ['search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim'] as const;

export type SlackChannelKind = 'public' | 'private' | 'dm';
/** Which conversations a search may look in. */
export type SlackSearchScope = 'public' | 'all';

export interface SlackMessage {
  permalink: string;
  teamId: string;
  channelId: string;
  channelName: string;
  channelKind: SlackChannelKind;
  authorId: string;
  authorName: string;
  /** Slack message timestamp ("1730000000.000100"). */
  ts: string;
  text: string;
  /** Neighbouring messages in the same conversation, oldest first. */
  context: string[];
}

export interface SlackIdentity {
  teamId: string;
  teamName: string;
  userId: string;
  userName: string;
  scopes: string[];
}

/** The token no longer works (revoked, expired, app removed) or lacks a scope it needs. */
export class SlackAccessError extends Error {
  readonly code = 'slack_access_revoked';
}

/** Slack asked us to slow down; `retryAfterMs` comes from its Retry-After header. */
export class SlackRateLimited extends Error {
  readonly code = 'slack_rate_limited';
  constructor(readonly retryAfterMs: number) {
    super(`Slack rate limited the search; retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}

/** Real-time Search is not available to this workspace or app (plan, admin setting, app type). */
export class SlackUnavailable extends Error {
  readonly code = 'slack_search_unavailable';
}

export interface SlackSearchOptions {
  query: string;
  scope: SlackSearchScope;
  /** At most 20 per Slack call. */
  limit?: number;
  /** Only messages after this time (ms since epoch). */
  after?: number;
}

export interface SlackClient {
  readonly name: string;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<SlackIdentity & { token: string }>;
  search(token: string, opts: SlackSearchOptions): Promise<SlackMessage[]>;
  revoke(token: string): Promise<void>;
}

export interface SlackApiOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiUrl?: string;
  authorizeUrl?: string;
  fetch?: typeof fetch;
}

const ACCESS_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'account_inactive',
  'missing_scope',
  'no_permission',
  'team_access_not_granted',
  'not_allowed_token_type',
  'access_denied',
]);
const UNAVAILABLE_ERRORS = new Set(['feature_not_enabled', 'assistant_search_context_disabled', 'enterprise_is_restricted', 'deprecated_endpoint', 'method_deprecated']);

interface RtsMessage {
  author_name?: string;
  author_user_id?: string;
  team_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  permalink?: string;
  context_messages?: { before?: { text?: string }[]; after?: { text?: string }[] };
}

/** DMs have D ids; group DMs keep the legacy "mpdm-" name. Everything else from a private search is a private channel. */
export function channelKindOf(channelId: string, channelName: string, fromPrivateSearch: boolean): SlackChannelKind {
  if (channelId.startsWith('D') || channelName.startsWith('mpdm-')) return 'dm';
  return fromPrivateSearch ? 'private' : 'public';
}

export class SlackApiClient implements SlackClient {
  readonly name = 'slack';
  private readonly api: string;
  private readonly authorize: string;
  private readonly http: typeof fetch;

  constructor(private readonly opts: SlackApiOptions) {
    this.api = opts.apiUrl ?? 'https://slack.com/api';
    this.authorize = opts.authorizeUrl ?? 'https://slack.com/oauth/v2/authorize';
    this.http = opts.fetch ?? fetch;
  }

  private async request<T>(method: string, init: { token?: string; json?: unknown; form?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = { 'user-agent': 'understanding-check' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await this.http(`${this.api}/${method}`, { method: 'POST', headers, body });
    const retryAfter = () => Math.max(1, Number(res.headers.get('retry-after') ?? 30)) * 1000;
    if (res.status === 429) throw new SlackRateLimited(retryAfter());
    const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string } & T;
    if (data.ok) return data;
    const error = data.error ?? 'unknown_error';
    if (error === 'ratelimited' || error === 'rate_limited') throw new SlackRateLimited(retryAfter());
    if (ACCESS_ERRORS.has(error)) throw new SlackAccessError(`Slack denied access: ${error}`);
    if (UNAVAILABLE_ERRORS.has(error)) throw new SlackUnavailable(`Slack search is not available: ${error}`);
    throw new Error(`Slack ${method} failed: ${error}`);
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.opts.clientId, user_scope: SLACK_USER_SCOPES.join(','), redirect_uri: this.opts.redirectUri, state });
    return `${this.authorize}?${q}`;
  }

  async exchangeCode(code: string) {
    const r = await this.request<{ authed_user?: { id: string; scope?: string; access_token?: string }; team?: { id: string; name?: string } }>('oauth.v2.access', {
      form: { client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code, redirect_uri: this.opts.redirectUri },
    });
    const token = r.authed_user?.access_token;
    if (!token || !r.authed_user) throw new Error('Slack did not return a user token');
    const me = await this.request<{ team: string; user: string; team_id: string; user_id: string }>('auth.test', { token });
    return {
      token,
      teamId: r.team?.id ?? me.team_id,
      teamName: r.team?.name ?? me.team,
      userId: r.authed_user.id,
      userName: me.user,
      scopes: (r.authed_user.scope ?? '').split(',').filter(Boolean),
    };
  }

  /**
   * Public and private results come from separate calls: Slack's response does not say whether a
   * channel is private, and the caller treats private results differently.
   */
  async search(token: string, opts: SlackSearchOptions): Promise<SlackMessage[]> {
    const one = async (channelTypes: string[], isPrivate: boolean) => {
      const r = await this.request<{ results?: { messages?: RtsMessage[] } }>('assistant.search.context', {
        token,
        json: {
          query: opts.query.slice(0, 500),
          channel_types: channelTypes,
          content_types: ['messages'],
          include_context_messages: true,
          limit: Math.min(opts.limit ?? 10, 20),
          ...(opts.after ? { after: Math.floor(opts.after / 1000) } : {}),
        },
      });
      return (r.results?.messages ?? []).flatMap((m): SlackMessage[] => {
        if (!m.permalink || !m.channel_id || !m.message_ts || !m.content) return [];
        const channelName = m.channel_name ?? m.channel_id;
        return [
          {
            permalink: m.permalink,
            teamId: m.team_id ?? '',
            channelId: m.channel_id,
            channelName,
            channelKind: channelKindOf(m.channel_id, channelName, isPrivate),
            authorId: m.author_user_id ?? '',
            authorName: m.author_name ?? m.author_user_id ?? 'someone',
            ts: m.message_ts,
            text: m.content,
            context: [...(m.context_messages?.before ?? []), ...(m.context_messages?.after ?? [])].flatMap((c) => (c.text ? [c.text] : [])),
          },
        ];
      });
    };
    const pub = await one(['public_channel'], false);
    if (opts.scope === 'public') return pub;
    const priv = await one(['private_channel', 'mpim', 'im'], true);
    return [...pub, ...priv];
  }

  async revoke(token: string) {
    await this.request('auth.revoke', { token, form: {} });
  }
}

/** In-memory Slack for tests and offline demos: naive word-overlap search, revocable tokens. */
export class FakeSlack implements SlackClient {
  readonly name = 'fake-slack';
  readonly calls: { method: string; query?: string; scope?: SlackSearchScope }[] = [];
  private messages: SlackMessage[] = [];
  private codes = new Map<string, string>();
  private tokens = new Set<string>();
  private seq = 0;
  identity: Omit<SlackIdentity, 'scopes'> = { teamId: 'T0FAKE', teamName: 'Fake team', userId: 'U0ME', userName: 'me' };
  scopes: string[] = [...SLACK_USER_SCOPES];
  unavailable = false;
  rateLimited = false;

  addMessage(m: Partial<SlackMessage> & { text: string }): SlackMessage {
    const n = ++this.seq;
    const channelKind = m.channelKind ?? 'public';
    const channelId = m.channelId ?? `${channelKind === 'dm' ? 'D' : 'C'}0${n}`;
    const ts = m.ts ?? `${1_760_000_000 + n}.000100`;
    const msg: SlackMessage = {
      teamId: this.identity.teamId,
      channelId,
      channelName: m.channelName ?? (channelKind === 'dm' ? 'U0OTHER' : 'general'),
      channelKind,
      authorId: m.authorId ?? 'U0OTHER',
      authorName: m.authorName ?? 'Dana',
      ts,
      context: [],
      ...m,
      permalink: m.permalink ?? `https://fake.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
    };
    this.messages.push(msg);
    return msg;
  }

  /** A code the OAuth callback can exchange once. */
  issueCode(): string {
    const code = `code-${++this.seq}`;
    this.codes.set(code, `xoxp-fake-${this.seq}`);
    return code;
  }

  revokeAll() {
    this.tokens.clear();
  }

  authorizeUrl(state: string) {
    return `https://fake.slack.com/oauth/v2/authorize?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string) {
    this.calls.push({ method: 'oauth.v2.access' });
    const token = this.codes.get(code);
    if (!token) throw new Error('Slack oauth.v2.access failed: invalid_code');
    this.codes.delete(code);
    this.tokens.add(token);
    return { token, ...this.identity, scopes: this.scopes };
  }

  /** Accept a token minted outside OAuth (the SLACK_USER_TOKEN path). */
  acceptToken(token: string) {
    this.tokens.add(token);
  }

  async search(token: string, opts: SlackSearchOptions) {
    this.calls.push({ method: 'assistant.search.context', query: opts.query, scope: opts.scope });
    if (!this.tokens.has(token)) throw new SlackAccessError('Slack denied access: token_revoked');
    if (this.unavailable) throw new SlackUnavailable('Slack search is not available: feature_not_enabled');
    if (this.rateLimited) throw new SlackRateLimited(30_000);
    const words = new Set(opts.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const scored = this.messages
      .filter((m) => opts.scope === 'all' || m.channelKind === 'public')
      .filter((m) => !opts.after || Number(m.ts) * 1000 > opts.after)
      .map((m) => ({ m, score: (m.text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => words.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? 10).map((x) => x.m);
  }

  async revoke(token: string) {
    this.calls.push({ method: 'auth.revoke' });
    this.tokens.delete(token);
  }
}
