import { keywords, splitIdentifier, type EngineEvent, type SessionState, type SlackObservation } from '@uc/core';
import type { SessionRow } from '@uc/db';
import { SlackAccessError, SlackRateLimited, SlackUnavailable, type SlackMessage } from '@uc/providers';
import type { SlackLink } from './slack';

export interface SlackContextOptions {
  /** Searches per minute across all sessions; Slack allows about 10 per user. */
  perMinute: number;
  /** Minimum gap between searches for one session. */
  sessionGapMs: number;
  /** Searches per session, prefetch included. */
  sessionBudget: number;
  /** Search again after this many new segments without a focus change. */
  segmentsPerQuery: number;
  now: () => number;
}

const DEFAULTS: SlackContextOptions = { perMinute: 6, sessionGapMs: 20_000, sessionBudget: 30, segmentsPerQuery: 6, now: Date.now };
const RESULTS_PER_SEARCH = 6;

interface SessionSlack {
  mode: 'public' | 'all';
  used: number;
  lastAt: number;
  lastFocus: string | null;
  segmentsSince: number;
  queries: Set<string>;
  inFlight: boolean;
  stopped: boolean;
}

type Observe = (sessionId: string, messages: SlackObservation[]) => Promise<void>;

/**
 * Searches Slack for one session's topic: once at start (title, feature, linked issue), then when
 * the code in focus changes or the discussion moves on. Results go to the engine, which keeps
 * their text in memory only. Searches are throttled well under Slack's per-user limit and stop for
 * good when the token is revoked or search is unavailable.
 */
export class SlackContext {
  private sessions = new Map<string, SessionSlack>();
  private recent: number[] = [];
  private pausedUntil = 0;
  private opts: SlackContextOptions;

  constructor(
    private link: SlackLink,
    private observe: Observe,
    opts: Partial<SlackContextOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Called once a session exists. Never blocks session start. */
  async prefetch(row: SessionRow): Promise<void> {
    if (!row.slackMode || row.slackMode === 'off') return;
    const s = this.session(row.id, row.slackMode);
    const issue = row.githubIssue?.title ?? '';
    const queries = [keywords(`${row.title} ${issue}`, 6), keywords(row.featureDescription ?? '', 8)].filter((q) => q.length > 0);
    for (const q of queries) await this.search(row.id, s, q.join(' '), { force: true });
  }

  /** Called after every engine run for the session. */
  onRun(row: SessionRow, events: EngineEvent[], state: SessionState): void {
    if (!row.slackMode || row.slackMode === 'off') return;
    const s = this.session(row.id, row.slackMode);
    const added = events.filter((e): e is Extract<EngineEvent, { type: 'segment_added' }> => e.type === 'segment_added');
    if (added.length === 0) return;
    s.segmentsSince += added.length;
    const focus = state.focus?.symbolName ?? null;
    const latest = added.map((e) => e.segment.text).join(' ');
    let query: string[] = [];
    if (focus && focus !== s.lastFocus) {
      s.lastFocus = focus;
      query = [...splitIdentifier(focus), ...keywords(latest, 4)];
    } else if (s.segmentsSince >= this.opts.segmentsPerQuery) {
      query = keywords(state.claims.slice(-this.opts.segmentsPerQuery).map((c) => c.text).join(' '), 6);
    }
    if (query.length > 0) void this.search(row.id, s, [...new Set(query)].join(' '));
  }

  forget(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private session(id: string, mode: 'public' | 'all'): SessionSlack {
    let s = this.sessions.get(id);
    if (!s) {
      s = { mode, used: 0, lastAt: 0, lastFocus: null, segmentsSince: 0, queries: new Set(), inFlight: false, stopped: false };
      this.sessions.set(id, s);
    }
    return s;
  }

  private allowed(s: SessionSlack, force: boolean): boolean {
    const now = this.opts.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (s.stopped || s.used >= this.opts.sessionBudget || now < this.pausedUntil) return false;
    if (this.recent.length >= this.opts.perMinute) return false;
    return force || (!s.inFlight && now - s.lastAt >= this.opts.sessionGapMs);
  }

  private async search(sessionId: string, s: SessionSlack, query: string, opts: { force?: boolean } = {}) {
    const key = query.toLowerCase();
    if (!key || s.queries.has(key) || !this.allowed(s, !!opts.force)) return;
    const creds = await this.link.credentials();
    if (!creds) return;
    const scope = s.mode === 'all' && creds.maxScope === 'all' ? 'all' : 'public';
    s.queries.add(key);
    s.used++;
    s.lastAt = this.opts.now();
    s.segmentsSince = 0;
    s.inFlight = true;
    // A full search is two Slack calls (public, then private conversations).
    this.recent.push(s.lastAt);
    if (scope === 'all') this.recent.push(s.lastAt);
    let results: SlackMessage[];
    try {
      results = await this.link.client.search(creds.token, { query, scope, limit: RESULTS_PER_SEARCH });
    } catch (err) {
      if (err instanceof SlackAccessError) {
        await this.link.markRevoked(err.message.replace(/^Slack denied access: /, ''));
        for (const x of this.sessions.values()) x.stopped = true;
      } else if (err instanceof SlackRateLimited) {
        this.pausedUntil = this.opts.now() + err.retryAfterMs;
      } else if (err instanceof SlackUnavailable) {
        this.link.problem = err.message;
        for (const x of this.sessions.values()) x.stopped = true;
      } else {
        console.error(`[slack] search failed: ${(err as Error).message}`);
      }
      return;
    } finally {
      s.inFlight = false;
    }
    if (results.length === 0) return;
    await this.observe(
      sessionId,
      results.map((m) => ({ permalink: m.permalink, channelName: m.channelName, channelKind: m.channelKind, authorName: m.authorName, ts: m.ts, text: m.text })),
    ).catch(() => undefined);
  }
}
