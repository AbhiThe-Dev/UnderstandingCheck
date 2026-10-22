import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForwardQueue } from '../src/backend';

const cfg = { apiUrl: 'http://api.test', webUrl: 'http://web.test' };
const final = (text: string) => ({ event: 'transcript.data', data: { text } });
const partial = (text: string) => ({ event: 'transcript.partial_data', data: { text } });

afterEach(() => vi.unstubAllGlobals());

describe('ForwardQueue (desktop → API transcript delivery)', () => {
  it('delivers events in order, in batches, and keeps only the newest partial caption', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });
    const q = new ForwardQueue(cfg, () => undefined, 10_000);
    q.enqueue('s1', partial('Admins'));
    q.enqueue('s1', partial('Admins need'));
    q.enqueue('s1', final('Admins need to undo approvals.'));
    await q.flush();
    expect(bodies).toEqual([[partial('Admins need'), final('Admins need to undo approvals.')]]);
  });

  it('keeps events through an outage and retries until the API is back', async () => {
    let up = false;
    const delivered: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (!up) throw new Error('ECONNREFUSED');
      delivered.push(...JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });
    const stats: { pending: number; failures: number }[] = [];
    const q = new ForwardQueue(cfg, (s) => stats.push(s), 10_000);
    q.enqueue('s1', final('one'));
    q.enqueue('s1', final('two'));
    await q.flush();
    expect(delivered).toEqual([]);
    expect(stats.at(-1)).toMatchObject({ pending: 2, failures: 1 });
    up = true;
    await q.flush();
    expect(delivered).toEqual([final('one'), final('two')]);
    expect(stats.at(-1)).toMatchObject({ pending: 0, sent: 2 });
  });

  it('caps the backlog so a long outage cannot exhaust memory', () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    let pending = 0;
    const q = new ForwardQueue(cfg, (s) => (pending = s.pending), 10_000);
    for (let i = 0; i < ForwardQueue.MAX_BACKLOG + 50; i++) q.enqueue('s1', final(`u${i}`));
    expect(pending).toBe(ForwardQueue.MAX_BACKLOG);
  });
});
