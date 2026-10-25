import {
  DEFAULT_CONFIG,
  HeuristicAnalyzer,
  LlmAnalyzer,
  SessionEngine,
  TieredAnalyzer,
  effortFrom,
  pricesFrom,
  type Analyzer,
  type EngineEvent,
  type LlmProvider,
  type PriorDecision,
  type SessionState,
} from '@uc/core';
import { PgSymbolSearch, WorkspaceStore, ensureDemoWorkspace, openDatabase, type SessionRow } from '@uc/db';
import { SAMPLE_REPOS, sampleRepoPath, type RepoName } from '@uc/fixtures';
import { indexDirectory } from '@uc/indexer';
import {
  OpenAiLiveTranscriber,
  RepoAccessError,
  createLlmProviderFromEnv,
  createRecallClientFromEnv,
  createRepoHostFromEnv,
  createSlackFromEnv,
  type LiveTranscriber,
  type RecallClient,
  type RepoHost,
  type SlackClient,
} from '@uc/providers';
import { CaptureManager } from './capture';
import { GitHubSync, issueToFeature, parseIssueRef, refOf } from './github';
import { ReplayManager } from './replay';
import { SecretBox } from './secrets';
import { SlackLink } from './slack';
import { SlackContext, type SlackContextOptions } from './slackContext';

/** heuristic: rules only (free). llm: the model on every meaningful turn. tiered: rules, a cheap screen each minute, the large model on flags. */
export type AnalyzerMode = 'heuristic' | 'llm' | 'tiered';

export interface ServicesOptions {
  /** PGlite data directory; omit for in-memory (tests). */
  dataDir?: string;
  analyzer?: AnalyzerMode;
  /** Model provider for llm/tiered; defaults to OpenAI from OPENAI_API_KEY (tests pass a scripted one). */
  llm?: LlmProvider | null;
  /** Repository host; defaults to the GitHub App from the environment (null = not configured). */
  host?: RepoHost | null;
  /** Recall.ai client for meeting capture; defaults to RECALL_API_KEY/RECALL_REGION. */
  recall?: RecallClient | null;
  /** Live transcription for microphone capture; defaults to OpenAI when OPENAI_API_KEY is set. */
  transcriber?: (() => LiveTranscriber) | null;
  /** Slack search client; defaults to SLACK_CLIENT_ID/SECRET (or SLACK_USER_TOKEN) from the environment. */
  slack?: SlackClient | null;
  /** Token for search without OAuth; defaults to SLACK_USER_TOKEN. */
  slackUserToken?: string;
  /** Encrypts stored secrets; defaults to UC_SECRET_KEY or a key file next to the data directory. */
  secrets?: SecretBox;
  /** Throttles for Slack searches (tests shorten them). */
  slackContext?: Partial<SlackContextOptions>;
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
  readonly github: GitHubSync | null;
  readonly capture: CaptureManager;
  readonly slack: SlackLink | null;
  readonly slackContext: SlackContext | null;

  private constructor(
    readonly store: WorkspaceStore,
    readonly analyzerMode: AnalyzerMode,
    readonly host: RepoHost | null,
    capture: { recall: RecallClient | null; transcriber: (() => LiveTranscriber) | null },
    slack: SlackLink | null,
    slackOpts: Partial<SlackContextOptions> = {},
    private llm: LlmProvider | null = null,
  ) {
    this.slack = slack;
    this.slackContext = slack
      ? new SlackContext(
          slack,
          async (id, messages) => {
            await this.run(id, async (engine) => engine.observeSlack(messages));
          },
          slackOpts,
        )
      : null;
    this.replays = new ReplayManager(this, (status, message) => new HttpError(status, message));
    this.github = host ? new GitHubSync(store, host) : null;
    this.capture = new CaptureManager(this, capture, (status, message) => new HttpError(status, message));
  }

  static async create(opts: ServicesOptions = {}): Promise<Services> {
    const { db } = await openDatabase(opts.dataDir);
    const ws = await ensureDemoWorkspace(db);
    const env = process.env.ANALYZER;
    const requested: AnalyzerMode = opts.analyzer ?? (env === 'llm' || env === 'tiered' ? env : 'heuristic');
    const llm = opts.llm !== undefined ? opts.llm : createLlmProviderFromEnv();
    const mode: AnalyzerMode = requested !== 'heuristic' && llm ? requested : 'heuristic';
    if (requested !== mode) console.warn(`ANALYZER=${requested} but OPENAI_API_KEY is not set; using the heuristic analyzer.`);
    let host = opts.host;
    if (host === undefined) {
      try {
        host = createRepoHostFromEnv();
      } catch (err) {
        console.warn(`GitHub App not configured: ${(err as Error).message}`);
        host = null;
      }
    }
    const recall = opts.recall !== undefined ? opts.recall : createRecallClientFromEnv();
    const apiKey = process.env.OPENAI_API_KEY;
    const transcriber = opts.transcriber !== undefined ? opts.transcriber : apiKey ? () => new OpenAiLiveTranscriber({ apiKey }) : null;
    const store = new WorkspaceStore(db, ws.id);
    const slackClient = opts.slack !== undefined ? opts.slack : createSlackFromEnv();
    const envToken = opts.slackUserToken ?? process.env.SLACK_USER_TOKEN;
    const canConnect = opts.slack !== undefined ? !!opts.slack : !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
    const slack = slackClient ? new SlackLink(store, slackClient, opts.secrets ?? SecretBox.fromEnv(opts.dataDir), { canConnect, envToken }) : null;
    return new Services(store, mode, host, { recall, transcriber }, slack, opts.slackContext, llm);
  }

  // ---------------- GitHub

  /** Connect a repository the GitHub App can see, then index it in the background. */
  async connectGitHubRepository(fullName: string) {
    if (!this.host || !this.github) throw new HttpError(503, 'GitHub App is not configured');
    const repo = (await this.host.listRepositories()).find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    if (!repo) throw new HttpError(404, `The GitHub App cannot see ${fullName}. Install it on that repository first.`);
    const row = await this.store.addGitHubRepository({
      installationId: repo.installationId,
      githubRepositoryId: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      htmlUrl: repo.htmlUrl,
    });
    void this.github.sync(row.id, { force: true }).catch(() => undefined);
    return row;
  }

  /** Background sync of every connected GitHub repository (skips revoked ones). */
  async syncAllGitHub() {
    if (!this.github) return [];
    const repos = (await this.store.listRepositories()).filter((r) => r.source === 'github' && r.indexingStatus !== 'revoked' && r.indexingStatus !== 'indexing');
    const out = [];
    for (const r of repos) {
      try {
        out.push({ id: r.id, ...(await this.github.sync(r.id)) });
      } catch (err) {
        out.push({ id: r.id, error: (err as Error).message });
      }
    }
    return out;
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
    if (repo.source === 'github') {
      if (!this.github) throw new HttpError(503, 'GitHub App is not configured');
      return this.github.sync(id, { force: true });
    }
    if (!repo.sampleKey) throw new Error('Unknown repository source');
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
    if (this.analyzerMode !== 'heuristic' && this.llm) {
      const llm = new LlmAnalyzer({ provider: this.llm, sessionId, usage: this.store.usageSink(sessionId), limits: llmLimits(), prices: pricesFrom(process.env.UC_MODEL_PRICES_JSON) });
      return this.analyzerMode === 'tiered' ? new TieredAnalyzer(llm) : llm;
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
    /** Check the discussion against the repository's active requirement records (default true). */
    includeRecords?: boolean;
    /** Slack conversations to search; defaults to everything the connected token allows. */
    slackMode?: 'off' | 'public' | 'all';
  }) {
    let priors = input.priorDecisions ?? [];
    let featureDescription = input.featureDescription ?? null;
    let githubIssue: SessionRow['githubIssue'] = null;
    if (input.repositoryId) {
      const repo = await this.store.getRepository(input.repositoryId);
      if (!repo) throw new HttpError(404, 'Repository not found');
      if (repo.indexingStatus !== 'ready') throw new HttpError(409, 'Repository is not indexed yet');
      if (input.includeRecords !== false) priors = [...(await this.store.records.priorDecisionsFor(repo.id)), ...priors];
      // A linked issue supplies the feature description when none was typed. Its text is untrusted.
      if (input.githubIssueReference && repo.source === 'github' && this.host) {
        const ref = refOf(repo);
        const n = parseIssueRef(input.githubIssueReference, ref);
        if (n === null) throw new HttpError(422, `"${input.githubIssueReference}" is not an issue in ${repo.name}`);
        try {
          const f = issueToFeature(await this.host.issue(ref, n));
          githubIssue = f.snapshot;
          featureDescription ||= f.featureDescription;
        } catch (err) {
          if (err instanceof RepoAccessError) throw new HttpError(404, `Issue #${n} was not found in ${repo.name}, or the app cannot read issues there`);
          throw err;
        }
      }
    }
    const row = await this.store.createSession({ ...input, featureDescription, githubIssue, analyzer: this.analyzerMode, slackMode: await this.slackModeFor(input.slackMode) });
    const deps = await this.depsFor(row);
    const { engine } = await SessionEngine.create(
      { sessionId: row.id, featureDescription: featureDescription ?? undefined, priorDecisions: priors },
      deps,
    );
    this.engines.set(row.id, engine);
    await this.store.saveSessionState(row.id, engine.state, engine.segments);
    if (this.slackContext) void this.slackContext.prefetch(row).catch(() => undefined);
    return row;
  }

  /** Narrow the requested Slack mode to what the connection allows. */
  private async slackModeFor(requested: 'off' | 'public' | 'all' | undefined): Promise<'off' | 'public' | 'all'> {
    const creds = this.slack ? await this.slack.credentials() : null;
    if (!creds || requested === 'off') return 'off';
    if (requested === 'public' || creds.maxScope === 'public') return 'public';
    return 'all';
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
      if (!opts.ended) this.slackContext?.onRun(row, events, engine.state);
      if (!opts.ended && events.some((e) => e.type === 'segment_added') && engine.screenDue()) this.scheduleScreen(id);
      return { events, snapshot };
    });
    this.queues.set(id, next);
    return next;
  }

  private screening = new Set<string>();

  /**
   * Tiered analyzer: queue the cheap screen behind the current operation instead of running it
   * inside ingestion, so turns keep flowing while the model thinks. At most one queued per session.
   */
  private scheduleScreen(id: string) {
    if (this.screening.has(id)) return;
    this.screening.add(id);
    void this.run(id, (engine) => engine.screenIfDue())
      .catch((err) => {
        if (!(err instanceof HttpError)) console.error(`[api] screen failed for ${id}: ${(err as Error).message}`);
      })
      .finally(() => this.screening.delete(id));
  }

  /** End a meeting: screen whatever the last timer did not cover, then finalize. */
  async endSession(id: string) {
    if (this.analyzerMode === 'tiered') await this.run(id, (engine) => engine.screenIfDue({ force: true }));
    return this.run(id, (engine) => engine.finalize(), { ended: true });
  }

  /** Text of Slack messages the session's engine holds in memory, for the live panel. Never read from the database. */
  slackExcerpts(id: string): { id: string; text: string }[] {
    return this.engines.get(id)?.slackExcerpts() ?? [];
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
    this.capture.stop(id);
    await this.store.deleteSession(id);
    this.slackContext?.forget(id);
    this.engines.delete(id);
    this.listeners.delete(id);
  }

  forget(id: string) {
    this.engines.delete(id);
  }
}

/** Model limits, with per-operation reasoning effort overridable through UC_LLM_EFFORT_JSON. */
function llmLimits() {
  return { ...DEFAULT_CONFIG.llm, effort: effortFrom(process.env.UC_LLM_EFFORT_JSON) };
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}
