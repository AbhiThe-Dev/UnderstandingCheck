import {
  HeuristicAnalyzer,
  LlmAnalyzer,
  SessionEngine,
  TieredAnalyzer,
  effortFrom,
  parseTranscript,
  DEFAULT_CONFIG,
  type Analyzer,
  type CodeSymbol,
  type DeepPartial,
  type EngineConfig,
  type EngineEvent,
  type UsageRecord,
  type UsageSink,
} from '@uc/core';
import { sampleRepoPath, type FixtureCase, type RepoName } from '@uc/fixtures';
import { InMemorySymbolIndex, indexDirectory } from '@uc/indexer';
import { createLlmProviderFromEnv } from '@uc/providers';

const repoCache = new Map<RepoName, Promise<{ search: InMemorySymbolIndex; symbols: CodeSymbol[]; commitSha: string }>>();

export function loadSampleRepo(repo: RepoName) {
  let p = repoCache.get(repo);
  if (!p) {
    p = indexDirectory(sampleRepoPath(repo)).then((r) => ({
      search: new InMemorySymbolIndex(r.symbols, r.commitSha),
      symbols: r.symbols,
      commitSha: r.commitSha,
    }));
    repoCache.set(repo, p);
  }
  return p;
}

export class MemoryUsage implements UsageSink {
  records: UsageRecord[] = [];
  record(u: UsageRecord) {
    this.records.push(u);
  }
  spentUsd() {
    return this.records.reduce((s, r) => s + r.estimatedCostUsd, 0);
  }
}

/** `ANALYZER=llm` with OPENAI_API_KEY uses the model; anything else uses the credential-free heuristic analyzer. */
export function analyzerFromEnv(sessionId: string, usage: UsageSink, config: EngineConfig = DEFAULT_CONFIG): Analyzer {
  const mode = process.env.ANALYZER;
  if (mode === 'llm' || mode === 'tiered') {
    const provider = createLlmProviderFromEnv();
    if (!provider) throw new Error(`ANALYZER=${mode} requires OPENAI_API_KEY`);
    const llm = new LlmAnalyzer({ provider, sessionId, usage, limits: { ...config.llm, effort: effortFrom(process.env.UC_LLM_EFFORT_JSON, config.llm.effort) } });
    // UC_TIERED_RULES=off: rules still pace the screen, but only the AI layers can raise anything.
    return mode === 'tiered' ? new TieredAnalyzer(llm, { ruleCandidates: process.env.UC_TIERED_RULES !== 'off' }) : llm;
  }
  return new HeuristicAnalyzer();
}

export interface CaseRun {
  engine: SessionEngine;
  events: EngineEvent[];
  usage: MemoryUsage;
}

export async function runCase(
  c: FixtureCase,
  opts: { analyzer?: Analyzer; config?: DeepPartial<EngineConfig>; transcript?: string; finalize?: boolean } = {},
): Promise<CaseRun> {
  const repo = c.repo ? await loadSampleRepo(c.repo) : null;
  const usage = new MemoryUsage();
  const analyzer = opts.analyzer ?? analyzerFromEnv(c.id, usage);
  const { engine, events } = await SessionEngine.create(
    { sessionId: c.id, featureDescription: c.featureDescription, priorDecisions: c.priorDecisions },
    { analyzer, search: repo?.search ?? null, config: opts.config, usage },
  );
  if (c.slack) {
    events.push(
      ...engine.observeSlack(
        c.slack.map((m, i) => ({
          permalink: `https://example.slack.com/archives/C0${i}/p17600000000${i}`,
          channelName: m.channelName,
          channelKind: m.channelKind ?? 'public',
          authorName: m.authorName,
          ts: `${1_760_000_000 + i * 3600}.000100`,
          text: m.text,
        })),
      ),
    );
  }
  // Screens run between turns, as the API schedules them (no-ops for analyzers without a screen).
  for (const seg of parseTranscript(opts.transcript ?? c.transcript)) {
    events.push(...(await engine.ingest(seg)));
    events.push(...(await engine.screenIfDue()));
  }
  events.push(...(await engine.screenIfDue({ force: true })));
  if (opts.finalize) events.push(...(await engine.finalize()));
  return { engine, events, usage };
}

export function surfaced(engine: SessionEngine) {
  return engine.state.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null);
}

export function participantId(engine: SessionEngine, name: string): string {
  const p = engine.state.participants.find((x) => x.displayName === name);
  if (!p) throw new Error(`No participant ${name}`);
  return p.id;
}
