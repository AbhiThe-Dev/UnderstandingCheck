import { randomBytes } from 'node:crypto';
import type { SlackConnectionRow, WorkspaceStore } from '@uc/db';
import type { SlackClient, SlackSearchScope } from '@uc/providers';
import type { SecretBox } from './secrets';

const STATE_TTL_MS = 10 * 60_000;
const PRIVATE_SCOPES = ['search:read.private', 'search:read.im', 'search:read.mpim'];

export interface SlackStatus {
  /** A Slack client exists (OAuth app or a SLACK_USER_TOKEN). */
  configured: boolean;
  /** The Connect button can run OAuth (client id and secret are set). */
  canConnect: boolean;
  connected: boolean;
  source: 'oauth' | 'env' | null;
  team: string | null;
  user: string | null;
  scopes: string[];
  /** The token can search private channels and DMs. */
  privateAccess: boolean;
  /** Set when Slack rejected the token or search is unavailable for the workspace. */
  problem: string | null;
}

/**
 * The workspace's Slack connection: OAuth Connect, the encrypted user token, and revocation.
 * A `SLACK_USER_TOKEN` in the environment stands in when no one has connected through OAuth.
 */
export class SlackLink {
  private states = new Map<string, number>();
  /** Last search problem not tied to the token (e.g. Real-time Search not enabled). */
  problem: string | null = null;

  constructor(
    private store: WorkspaceStore,
    readonly client: SlackClient,
    private box: SecretBox,
    private opts: { canConnect: boolean; envToken?: string },
  ) {}

  async status(): Promise<SlackStatus> {
    const row = await this.store.slackConnection();
    if (row) {
      const connected = row.status === 'connected';
      return {
        configured: true,
        canConnect: this.opts.canConnect,
        connected,
        source: 'oauth',
        team: row.teamName,
        user: row.userName,
        scopes: row.scopes,
        privateAccess: hasPrivate(row.scopes),
        problem: connected ? this.problem : `Slack rejected the token (${row.statusDetail ?? 'revoked'}). Connect again.`,
      };
    }
    const env = !!this.opts.envToken;
    return {
      configured: true,
      canConnect: this.opts.canConnect,
      connected: env,
      source: env ? 'env' : null,
      team: null,
      user: null,
      scopes: env ? ['search:read.public', ...PRIVATE_SCOPES] : [],
      privateAccess: env,
      problem: env ? this.problem : null,
    };
  }

  /** The Slack authorize URL; the random state is checked when Slack sends the user back. */
  beginConnect(): string {
    const now = Date.now();
    for (const [s, exp] of this.states) if (exp < now) this.states.delete(s);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, now + STATE_TTL_MS);
    return this.client.authorizeUrl(state);
  }

  async finishConnect(code: string, state: string): Promise<SlackConnectionRow> {
    const exp = this.states.get(state);
    this.states.delete(state);
    if (!exp || exp < Date.now()) throw new Error('state_mismatch');
    const r = await this.client.exchangeCode(code);
    this.problem = null;
    return this.store.saveSlackConnection({
      teamId: r.teamId,
      teamName: r.teamName,
      slackUserId: r.userId,
      userName: r.userName,
      scopes: r.scopes,
      tokenCiphertext: this.box.seal(r.token),
    });
  }

  async disconnect() {
    const row = await this.store.slackConnection();
    if (!row) return;
    if (row.status === 'connected') await this.client.revoke(this.box.open(row.tokenCiphertext)).catch(() => undefined);
    await this.store.deleteSlackConnection();
    this.problem = null;
  }

  /** The token to search with and the widest scope it allows, or null when not connected. */
  async credentials(): Promise<{ token: string; maxScope: SlackSearchScope } | null> {
    const row = await this.store.slackConnection();
    if (row) {
      if (row.status !== 'connected') return null;
      return { token: this.box.open(row.tokenCiphertext), maxScope: hasPrivate(row.scopes) ? 'all' : 'public' };
    }
    return this.opts.envToken ? { token: this.opts.envToken, maxScope: 'all' } : null;
  }

  async markRevoked(detail: string) {
    await this.store.markSlackRevoked(detail);
  }
}

function hasPrivate(scopes: string[]) {
  return PRIVATE_SCOPES.some((s) => scopes.includes(s));
}
