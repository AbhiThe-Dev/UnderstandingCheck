import { FakeSlack } from '@uc/providers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { SecretBox } from '../src/secrets';
import { Services } from '../src/services';

let app: ReturnType<typeof createApp>;
let slack: FakeSlack;
let services: Services;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), body: text ? (JSON.parse(text) as any) : null };
};

/** Run the Connect flow the way a browser would: /connect → Slack → /callback. */
async function connect() {
  const start = await call('GET', '/api/slack/connect');
  const state = new URL(start.location!).searchParams.get('state')!;
  return call('GET', `/api/slack/oauth/callback?code=${slack.issueCode()}&state=${encodeURIComponent(state)}`);
}

beforeEach(async () => {
  slack = new FakeSlack();
  services = await Services.create({ analyzer: 'heuristic', host: null, recall: null, transcriber: null, slack, slackUserToken: '', secrets: SecretBox.ephemeral() });
  app = createApp(services, { webOrigin: 'http://localhost:3000' });
});

describe('Slack connection', () => {
  it('reports not connected, then connects through OAuth and stores only an encrypted token', async () => {
    expect((await call('GET', '/api/slack/status')).body).toMatchObject({ configured: true, canConnect: true, connected: false });

    const start = await call('GET', '/api/slack/connect');
    expect(start.status).toBe(302);
    expect(start.location).toContain('fake.slack.com/oauth/v2/authorize?state=');

    const done = await connect();
    expect(done.status).toBe(302);
    expect(done.location).toBe('http://localhost:3000/repos?slack=connected');
    expect((await call('GET', '/api/slack/status')).body).toMatchObject({ connected: true, source: 'oauth', team: 'Fake team', user: 'me', privateAccess: true, problem: null });

    const row = await services.store.slackConnection();
    expect(row!.tokenCiphertext).not.toContain('xoxp-');
    expect((await services.slack!.credentials())!.token).toMatch(/^xoxp-fake-/);
  });

  it('rejects a callback whose state it did not issue, and reports a cancelled consent', async () => {
    const forged = await call('GET', `/api/slack/oauth/callback?code=${slack.issueCode()}&state=forged`);
    expect(forged.location).toBe('http://localhost:3000/repos?slack=error&reason=state_mismatch');
    const cancelled = await call('GET', '/api/slack/oauth/callback?error=access_denied&state=x');
    expect(cancelled.location).toBe('http://localhost:3000/repos?slack=error&reason=access_denied');
    expect(await services.store.slackConnection()).toBeNull();
  });

  it('a state works only once', async () => {
    const start = await call('GET', '/api/slack/connect');
    const state = new URL(start.location!).searchParams.get('state')!;
    await call('GET', `/api/slack/oauth/callback?code=${slack.issueCode()}&state=${state}`);
    const again = await call('GET', `/api/slack/oauth/callback?code=${slack.issueCode()}&state=${state}`);
    expect(again.location).toContain('reason=state_mismatch');
  });

  it('disconnect revokes the token at Slack and forgets it', async () => {
    await connect();
    expect((await call('DELETE', '/api/slack')).status).toBe(200);
    expect(slack.calls.map((c) => c.method)).toContain('auth.revoke');
    expect(await services.store.slackConnection()).toBeNull();
    expect((await call('GET', '/api/slack/status')).body.connected).toBe(false);
  });

  it('only public-scope tokens narrow sessions to public channels; off stays off', async () => {
    slack.scopes = ['search:read.public'];
    await connect();
    const a = (await call('POST', '/api/sessions', { title: 'a', repositoryId: null, consentConfirmed: true })).body.id;
    const b = (await call('POST', '/api/sessions', { title: 'b', repositoryId: null, consentConfirmed: true, slackMode: 'all' })).body.id;
    const c = (await call('POST', '/api/sessions', { title: 'c', repositoryId: null, consentConfirmed: true, slackMode: 'off' })).body.id;
    const mode = async (id: string) => (await services.store.getSession(id))!.slackMode;
    expect([await mode(a), await mode(b), await mode(c)]).toEqual(['public', 'public', 'off']);
  });

  it('without Slack configured, sessions have Slack off and status says how to configure it', async () => {
    const plain = await Services.create({ analyzer: 'heuristic', host: null, recall: null, transcriber: null, slack: null });
    const plainApp = createApp(plain);
    const status = (await (await plainApp.request('/api/slack/status')).json()) as any;
    expect(status).toMatchObject({ configured: false, connected: false });
    expect((await plainApp.request('/api/slack/connect')).status).toBe(503);
  });
});

const DECISION = 'Approved members must keep portal access for at least 30 days after approval.';
const SPOKEN = `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function sessionWithSlack(body: Record<string, unknown> = {}) {
  const repo = await services.ensureSampleIndexed('approvals');
  const { body: created } = await call('POST', '/api/sessions', { title: 'Undo an approval', repositoryId: repo.id, consentConfirmed: true, ...body });
  const id = created.id as string;
  return id;
}

async function speak(id: string, transcript = SPOKEN) {
  let view: any;
  for (const line of transcript.split('\n')) {
    const [speaker, ...rest] = line.split(': ');
    view = (await call('POST', `/api/sessions/${id}/segments`, { speaker: speaker!.replace(/ \(.*\)$/, ''), text: rest.join(': ') })).body;
  }
  return view;
}

/** Everything the app writes about a session: saved state, segments, summary, export, records. */
async function persisted(id: string) {
  const row = await services.store.getSession(id);
  const segments = await services.store.loadSegments(id);
  const summary = (await call('GET', `/api/sessions/${id}/summary`)).body;
  const exported = await (await app.request('/api/requirements/export?format=json')).text();
  return JSON.stringify({ state: row!.state, segments, summary: { ...summary, slackExcerpts: undefined }, exported });
}

describe('Slack as session context', () => {
  it('prefetches at session start and raises a conflict with a Slack decision, citing it by link', async () => {
    slack.addMessage({ text: DECISION, channelName: 'approvals', authorName: 'Dana' });
    await connect();
    const id = await sessionWithSlack();
    await waitFor(async () => (await services.snapshot(id)).state.slackRefs?.length, 'Slack prefetch');
    expect(slack.calls.find((c) => c.method === 'assistant.search.context')).toMatchObject({ scope: 'all' });

    const view = await speak(id);
    const d = view.state.discrepancies.find((x: any) => x.slackRefs?.length);
    expect(d).toBeDefined();
    expect(d.category).toBe('direct_disagreement');
    expect(d.title).toMatch(/earlier Slack decision/);
    expect(d.slackRefs[0]).toMatchObject({ id: 'S1', channelLabel: '#approvals', authorName: 'Dana', private: false, permalink: expect.stringContaining('fake.slack.com') });
    // The live panel gets the excerpt from engine memory…
    expect(view.slackExcerpts).toEqual([{ id: 'S1', text: DECISION }]);
    // …and the summary links the message.
    const summary = (await call('GET', `/api/sessions/${id}/summary`)).body;
    expect(summary.markdown).toContain('### Slack discussion');
    expect(summary.markdown).toContain('fake.slack.com');
  });

  it('never persists Slack message text, and keeps no names for private conversations', async () => {
    slack.addMessage({ text: DECISION, channelKind: 'dm', channelName: 'U0SECRETPARTNER', authorName: 'Morgan Secret' });
    await connect();
    const id = await sessionWithSlack();
    await waitFor(async () => (await services.snapshot(id)).state.slackRefs?.length, 'Slack prefetch');
    const view = await speak(id);
    const d = view.state.discrepancies.find((x: any) => x.slackRefs?.length);
    expect(d.slackRefs[0]).toMatchObject({ channelLabel: 'private conversation', authorName: null, private: true });
    await call('POST', `/api/sessions/${id}/end`);

    const all = await persisted(id);
    expect(all).not.toContain('30 days');
    expect(all).not.toContain('Morgan Secret');
    expect(all).not.toContain('U0SECRETPARTNER');
    expect(all).toContain('Slack private conversation');
  });

  it('after a restart nothing from Slack can be recovered from the database', async () => {
    slack.addMessage({ text: DECISION, channelName: 'approvals' });
    await connect();
    const id = await sessionWithSlack();
    await waitFor(async () => (await services.snapshot(id)).state.slackRefs?.length, 'Slack prefetch');
    services.forget(id);
    const view = (await call('GET', `/api/sessions/${id}`)).body;
    expect(view.state.slackRefs).toHaveLength(1);
    expect(view.slackExcerpts).toEqual([]);
  });

  it('public mode never searches private conversations', async () => {
    slack.addMessage({ text: DECISION, channelKind: 'dm' });
    await connect();
    const id = await sessionWithSlack({ slackMode: 'public' });
    await waitFor(async () => slack.calls.some((c) => c.method === 'assistant.search.context'), 'search');
    expect(slack.calls.filter((c) => c.method === 'assistant.search.context').every((c) => c.scope === 'public')).toBe(true);
    expect((await services.snapshot(id)).state.slackRefs ?? []).toHaveLength(0);
  });

  it('stays off when the session opts out or Slack is not connected', async () => {
    slack.addMessage({ text: DECISION });
    const notConnected = await sessionWithSlack();
    await connect();
    const optedOut = await sessionWithSlack({ slackMode: 'off' });
    await speak(notConnected);
    await speak(optedOut);
    expect(slack.calls.filter((c) => c.method === 'assistant.search.context')).toHaveLength(0);
  });

  it('a revoked token marks the connection revoked and stops searching', async () => {
    slack.addMessage({ text: DECISION });
    await connect();
    slack.revokeAll();
    const id = await sessionWithSlack();
    await waitFor(async () => (await services.store.slackConnection())?.status === 'revoked', 'revocation');
    const before = slack.calls.length;
    await speak(id, 'Priya (PO): approveApplication should also send a receipt email.\nSam (Developer): Approvals will notify billing too.');
    expect(slack.calls.length).toBe(before);
    expect((await call('GET', '/api/slack/status')).body).toMatchObject({ connected: false, problem: expect.stringContaining('Connect again') });
  });
});

describe('Slack search throttling', () => {
  it('limits searches per session gap, per session budget and per minute', async () => {
    let now = 1_000_000;
    slack = new FakeSlack();
    services = await Services.create({
      analyzer: 'heuristic',
      host: null,
      recall: null,
      transcriber: null,
      slack,
      slackUserToken: '',
      secrets: SecretBox.ephemeral(),
      slackContext: { now: () => now, sessionGapMs: 20_000, perMinute: 4, sessionBudget: 3, segmentsPerQuery: 1 },
    });
    app = createApp(services);
    await connect();
    const searches = () => slack.calls.filter((c) => c.method === 'assistant.search.context').length;
    const id = (await call('POST', '/api/sessions', { title: 'Billing receipts', repositoryId: null, consentConfirmed: true })).body.id;
    // The fake records one call per search; the throttle counts a full search as Slack's two calls (public + private).
    await waitFor(async () => searches() >= 1, 'prefetch');

    await speak(id, 'Priya (PO): Receipts need the invoice number.');
    expect(searches()).toBe(1); // inside the 20 s gap

    now += 21_000;
    await speak(id, 'Sam (Developer): Refunds should email the customer.');
    await waitFor(async () => searches() >= 2, 'second search');

    now += 21_000; // 4 Slack calls in the last minute: full until 60 s after the first
    await speak(id, 'Priya (PO): Discounts apply before tax.');
    expect(searches()).toBe(2);

    now += 60_000;
    await speak(id, 'Sam (Developer): Vouchers expire after a year.');
    await waitFor(async () => searches() >= 3, 'third search');

    now += 60_000; // session budget of 3 searches is used up
    await speak(id, 'Priya (PO): Credits roll over monthly.');
    expect(searches()).toBe(3);
  });
});
