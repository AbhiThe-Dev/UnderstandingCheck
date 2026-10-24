import { HeuristicAnalyzer, SCREEN_WINDOW_MS, SessionEngine, parseTranscript } from '@uc/core';
import { describe, expect, it } from 'vitest';
import { loadSampleRepo } from '../src/runner';

// Nobody names the code: "this" is whatever is on the shared screen.
const DEICTIC = `Priya (PO): We need a way to undo this when someone gets it wrong.
Sam (Developer): Easy enough, I'll just set the status back to pending.
Priya (PO): Sounds good.`;

const APPROVE_ON_SCREEN = {
  identifiers: ['approveApplication', 'findApplication', 'grantPortalAccess'],
  files: [{ path: 'src/applications/approve.ts', line: 17 }],
};

async function session() {
  const repo = await loadSampleRepo('approvals');
  const { engine } = await SessionEngine.create({ sessionId: 'screen' }, { analyzer: new HeuristicAnalyzer(), search: repo.search });
  return engine;
}

async function say(engine: SessionEngine, transcript: string, startMs = 0) {
  for (const [i, seg] of parseTranscript(transcript).entries()) await engine.ingest({ ...seg, timestamp: startMs + i * 4000 });
}

const live = (engine: SessionEngine) => engine.state.discrepancies.filter((d) => d.visibility === 'live');

describe('code on the shared screen', () => {
  it('is what "this" refers to, so the copilot can check the proposal against it', async () => {
    const engine = await session();
    await engine.observeScreen(APPROVE_ON_SCREEN);
    expect(engine.state.focus).toMatchObject({ symbolName: 'approveApplication' });
    expect(engine.state.screen?.files).toEqual(['src/applications/approve.ts']);

    await say(engine, DEICTIC);
    const [d] = live(engine);
    expect(d).toBeDefined();
    expect(d!.codeRefs.map((r) => r.filePath)).toContain('src/applications/approve.ts');
  });

  it('without the screen, the same conversation stays silent', async () => {
    const engine = await session();
    await say(engine, DEICTIC);
    expect(live(engine)).toEqual([]);
  });

  it('only keeps code that exists in the repository, and clears when the screen shows none', async () => {
    const engine = await session();
    await engine.observeScreen({ identifiers: ['notInThisRepo', 'useState'], files: [{ path: 'src/other/thing.ts' }] });
    expect(engine.state.screen).toBeNull();
    await engine.observeScreen(APPROVE_ON_SCREEN);
    expect(engine.state.screen).not.toBeNull();
    await engine.observeScreen({ identifiers: [], files: [] });
    expect(engine.state.screen).toBeNull();
  });

  it('stops counting once it is older than the screen window', async () => {
    const engine = await session();
    await say(engine, 'Lee (Developer): Morning, everyone.');
    await engine.observeScreen(APPROVE_ON_SCREEN);
    await say(engine, `Lee (Developer): Unrelated chat for a while.`, SCREEN_WINDOW_MS + 60_000);
    // A new topic after the window: the old screen no longer stands in for "this".
    engine.state.focus = null;
    await say(engine, DEICTIC, SCREEN_WINDOW_MS + 120_000);
    expect(live(engine)).toEqual([]);
  });
});
