import {
  DEFAULT_CONFIG,
  HeuristicAnalyzer,
  LlmAnalyzer,
  SessionEngine,
  pricesFrom,
  type Analyzer,
  type EngineEvent,
  type PriorDecision,
  type SessionState,
} from '@uc/core';
import { PgSymbolSearch, WorkspaceStore, ensureDemoWorkspace, openDatabase, type SessionRow } from '@uc/db';
import { SAMPLE_REPOS, sampleRepoPath, type RepoName } from '@uc/fixtures';
import { indexDirectory } from '@uc/indexer';
import { createLlmProviderFromEnv } from '@uc/providers';
import { ReplayManager } from './replay';

export type AnalyzerMode = 'heuristic' | 'llm';

export interface ServicesOptions {
  /** PGlite data directory; omit for in-memory (tests). */
  dataDir?: string;
  analyzer?: AnalyzerMode;
}

export interface SessionSnapshot {
  state: SessionState;
  segments: SessionEngine['segments'];
  status: SessionRow['status'];
}

type Listener = (snapshot: SessionSnapshot, events: EngineEvent[]) => void;

/**
 * Process-wide services: database, the workspace store, live session engines and their listeners.
 * Each session's operations run one at a time (segments can arrive concurrently from a live source).
 */
export class Services {
  private engines = new Map<string, SessionEngine>();
  private queues = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<Listener>>();
  readonly replays: ReplayManager;

  private constructor(
    readonly store: WorkspaceStore,
    readonly analyzerMode: AnalyzerMode,
  ) {
    this.replays = new ReplayManager(this, (status, message) => new HttpError(status, message));
  }

  static async create(opts: ServicesOptions = {}): Promise<Services> {
    const { db } = await openDatabase(opts.dataDir);
    const ws = await ensureDemoWorkspace(db);
    const requested = opts.analyzer ?? (process.env.ANALYZER === 'llm' ? 'llm' : 'heuristic');
    const mode: AnalyzerMode = requested === 'llm' && createLlmProviderFromEnv() ? 'llm' : 'heuristic';
    if (requested === 'llm' && mode !== 'llm') console.warn('ANALYZER=llm but OPENAI_API_KEY is not set; using the heuristic analyzer.');
    return new Services(new WorkspaceStore(db, ws.id), mode);
  }

  // ---------------- repositories

  async addSampleRepository(key: RepoName) {
    const repo = await this.store.addSampleRepository(key, SAMPLE_REPOS[key].name);
    if (repo.indexingStatus !== 'ready' && repo.indexingStatus !== 'indexing') void this.indexRepository(repo.id);
    return repo;
  }

  async indexRepository(id: string) {
    const repo = await this.store.getRepository(id);
    if (!repo) throw new Error('Repository not found');
    if (repo.source !== 'sample' || !repo.sampleKey) throw new Error('Only sample repositories can be indexed until the GitHub App is configured');
    await this.store.updateRepository(id, { indexingStatus: 'indexing', indexingError: null, indexingProgress: { done: 0, total: 0 } });
    try {
      let last = 0;
      const result = await indexDirectory(sampleRepoPath(repo.sampleKey as RepoName), {
        onProgress: (done, total) => {
          if (done - last >= 25 || done === total) {
            last = done;
            void this.store.updateRepository(id, { indexingProgress: { done, total } });
          }
        },
      });
      await this.store.replaceSymbols(id, result.commitSha, result.symbols);
      return result;
    } catch (err) {
      await this.store.updateRepository(id, { indexingStatus: 'failed', indexingError: (err as Error).message });
      throw err;
    }
  }

  /** Make sure a sample repo is indexed (used by the one-click demo). */
  async ensureSampleIndexed(key: RepoName) {
    let repo = await this.store.addSampleRepository(key, SAMPLE_REPOS[key].name);
    if (repo.indexingStatus !== 'ready') {
      await this.indexRepository(repo.id);
      repo = (await this.store.getRepository(repo.id))!;
    }
    return repo;
  }

  // ---------------- sessions

  private analyzerFor(sessionId: string): Analyzer {
    if (this.analyzerMode === 'llm') {
      const provider = createLlmProviderFromEnv();
      if (provider) {
        return new LlmAnalyzer({ provider, sessionId, usage: this.store.usageSink(sessionId), limits: DEFAULT_CONFIG.llm, prices: pricesFrom(process.env.UC_MODEL_PRICES_JSON) });
      }
    }
    return new HeuristicAnalyzer();
  }

  private async depsFor(row: SessionRow) {
    const repo = row.repositoryId ? await this.store.getRepository(row.repositoryId) : null;
    const ws = await this.store.workspace();
    const search = repo?.indexedCommitSha ? new PgSymbolSearch(this.store.db, repo.id, row.commitSha ?? repo.indexedCommitSha) : null;
    return {
      analyzer: this.analyzerFor(row.id),
      search,
      usage: this.store.usageSink(row.id),
      config: { budget: { workspaceLimitUsd: ws.monthlyBudgetUsd } },
    };
  }

  async createSession(input: {
    title: string;
    repositoryId: string | null;
    featureDescription?: string | null;
    githubIssueReference?: string | null;
    consentConfirmed: boolean;
    priorDecisions?: PriorDecision[];
  }) {
    if (input.repositoryId) {
      const repo = await this.store.getRepository(input.repositoryId);
      if (!repo) throw new HttpError(404, 'Repository not found');
      if (repo.indexingStatus !== 'ready') throw new HttpError(409, 'Repository is not indexed yet');
    }
    const row = await this.store.createSession({ ...input, analyzer: this.analyzerMode });
    const deps = await this.depsFor(row);
    const { engine } = await SessionEngine.create(
      { sessionId: row.id, featureDescription: input.featureDescription ?? undefined, priorDecisions: input.priorDecisions },
      deps,
    );
    this.engines.set(row.id, engine);
    await this.store.saveSessionState(row.id, engine.state, engine.segments);
    return row;
  }

  private async engineFor(id: string): Promise<{ engine: SessionEngine; row: SessionRow }> {
    const row = await this.store.getSession(id);
    if (!row) throw new HttpError(404, 'Session not found');
    let engine = this.engines.get(id);
    if (!engine) {
      engine = SessionEngine.restore(row.state as SessionState, await this.store.loadSegments(id), await this.depsFor(row));
      this.engines.set(id, engine);
    }
    return { engine, row };
  }

  /** Run one engine operation for a session, serialized, then persist and notify listeners. */
  async run<T extends EngineEvent[]>(id: string, op: (engine: SessionEngine, row: SessionRow) => Promise<T>, opts: { ended?: boolean } = {}) {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const { engine, row } = await this.engineFor(id);
      if (row.status === 'ended' && !opts.ended) throw new HttpError(409, 'Session has ended');
      const events = await op(engine, row);
      await this.store.saveSessionState(id, engine.state, engine.segments, opts);
      const snapshot: SessionSnapshot = { state: engine.state, segments: engine.segments, status: opts.ended ? 'ended' : row.status };
      for (const l of this.listeners.get(id) ?? []) l(snapshot, events);
      return { events, snapshot };
    });
    this.queues.set(id, next);
    return next;
  }

  async snapshot(id: string): Promise<SessionSnapshot & { row: SessionRow }> {
    const { engine, row } = await this.engineFor(id);
    return { state: engine.state, segments: engine.segments, status: row.status, row };
  }

  /** Re-broadcast the current snapshot (e.g. replay paused or sped up) without running the engine. */
  notify(id: string) {
    const set = this.listeners.get(id);
    const engine = this.engines.get(id);
    if (!set?.size || !engine) return;
    const snapshot: SessionSnapshot = { state: engine.state, segments: engine.segments, status: engine.state.ended ? 'ended' : 'active' };
    for (const l of set) l(snapshot, []);
  }

  subscribe(id: string, l: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(l);
    return () => set!.delete(l);
  }

  async deleteSession(id: string) {
    this.replays.forget(id);
    await this.store.deleteSession(id);
    this.engines.delete(id);
    this.listeners.delete(id);
  }

  forget(id: string) {
    this.engines.delete(id);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}
