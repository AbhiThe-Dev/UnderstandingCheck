import { DEFAULT_CONFIG, HeuristicAnalyzer, SessionEngine, parseTranscript, retrieveContext } from '@uc/core';
import { PgSymbolSearch, WorkspaceStore, ensureDemoWorkspace, openDatabase, schema } from '@uc/db';
import { SEEDED_DEMO, sampleRepoPath } from '@uc/fixtures';
import { indexDirectory } from '@uc/indexer';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

let store: WorkspaceStore;
let other: WorkspaceStore;
let repoId: string;
let commitSha: string;

beforeAll(async () => {
  const { db } = await openDatabase();
  const ws = await ensureDemoWorkspace(db);
  store = new WorkspaceStore(db, ws.id);
  const [ws2] = await db.insert(schema.workspaces).values({ name: 'Other' }).returning();
  other = new WorkspaceStore(db, ws2!.id);
  const repo = await store.addSampleRepository('approvals', 'demo/approvals');
  repoId = repo.id;
  const idx = await indexDirectory(sampleRepoPath('approvals'));
  commitSha = idx.commitSha;
  await store.replaceSymbols(repoId, commitSha, idx.symbols);
});

describe('Postgres full-text retrieval', () => {
  it('recalls the same operation as the in-memory index, with tests and callees', async () => {
    const search = new PgSymbolSearch(store.db, repoId, commitSha);
    const r = await retrieveContext({ terms: ['undo', 'approv'], words: ['undo', 'approval'] }, search, DEFAULT_CONFIG.retrieval);
    expect(r.evidence[0]!.symbolName).toBe('approveApplication');
    expect(r.evidence.map((e) => e.symbolName)).toEqual(expect.arrayContaining(['grantAccess', 'approve.test.ts']));
  });

  it('marks context insufficient when nothing matches', async () => {
    const search = new PgSymbolSearch(store.db, repoId, commitSha);
    const r = await retrieveContext({ terms: ['csv', 'export'], words: ['csv', 'export'] }, search, DEFAULT_CONFIG.retrieval);
    expect(r.sufficient).toBe(false);
  });
});

describe('session persistence', () => {
  it('runs the seeded demo against Postgres search, persists, and restores the engine', async () => {
    const session = await store.createSession({ title: 'Undo approval', repositoryId: repoId, analyzer: 'heuristic-v1', consentConfirmed: true });
    const search = new PgSymbolSearch(store.db, repoId, commitSha);
    const deps = { analyzer: new HeuristicAnalyzer(), search, usage: store.usageSink(session.id) };
    const { engine } = await SessionEngine.create({ sessionId: session.id, featureDescription: SEEDED_DEMO.featureDescription }, deps);
    for (const seg of parseTranscript(SEEDED_DEMO.transcript)) await engine.ingest(seg);
    await store.saveSessionState(session.id, engine.state, engine.segments);

    const rows = await store.db.select().from(schema.discrepancies).where(eq(schema.discrepancies.sessionId, session.id));
    expect(rows.map((r) => [r.category, r.visibility])).toContainEqual(['false_alignment', 'live']);

    const saved = (await store.getSession(session.id))!;
    const restored = SessionEngine.restore(saved.state as typeof engine.state, await store.loadSegments(session.id), deps);
    expect(restored.segments).toHaveLength(4);
    await restored.ingest({ speaker: 'Priya', text: 'Actually, wait.' });
    expect(restored.segments.at(-1)!.id).toBe('s5');
    expect(await store.dashboardCounts()).toMatchObject({ open: 1 });
  });

  it('isolates workspaces', async () => {
    const s = await store.createSession({ title: 'private', repositoryId: null, analyzer: 'heuristic-v1', consentConfirmed: true });
    expect(await other.getSession(s.id)).toBeNull();
    expect(await other.getRepository(repoId)).toBeNull();
    await expect(other.saveSessionState(s.id, {} as never, [])).rejects.toThrow('Session not found');
    await other.deleteSession(s.id); // no effect across workspaces
    expect(await store.getSession(s.id)).not.toBeNull();
  });

  it('deletes a session with its transcript and derived rows', async () => {
    const s = await store.createSession({ title: 'to delete', repositoryId: null, analyzer: 'heuristic-v1', consentConfirmed: true });
    const { engine } = await SessionEngine.create({ sessionId: s.id }, { analyzer: new HeuristicAnalyzer(), search: null });
    await engine.ingest({ speaker: 'A', text: 'We should do X.' });
    await store.saveSessionState(s.id, engine.state, engine.segments);
    await store.deleteSession(s.id);
    const left = await store.db.select().from(schema.transcriptSegments).where(eq(schema.transcriptSegments.sessionId, s.id));
    expect(left).toHaveLength(0);
  });

  it('tracks usage and monthly spend per workspace', async () => {
    const s = await store.createSession({ title: 'usage', repositoryId: null, analyzer: 'llm', consentConfirmed: true });
    await store.usageSink(s.id).record({ sessionId: s.id, model: 'gpt-5-mini', operation: 'extraction', inputTokens: 1000, outputTokens: 100, estimatedCostUsd: 0.25 });
    expect(await store.spentThisMonthUsd()).toBeCloseTo(0.25);
    expect(await other.spentThisMonthUsd()).toBe(0);
  });
});
