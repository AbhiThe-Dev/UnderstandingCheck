/**
 * Compare analyzer modes on cost and on what they catch.
 *
 *   pnpm eval:compare                                   # fixture cases, heuristic + tiered
 *   pnpm eval:compare --modes heuristic,tiered,llm      # add the per-turn model analyzer
 *   pnpm eval:compare --blind                           # blind cases (packages/fixtures/blind)
 *   pnpm eval:compare --transcript meeting.txt --repo approvals --max-usd 4
 *   pnpm eval:compare --modes tiered --no-rules         # AI layers alone: rules pace the screen but raise nothing
 *   pnpm eval:compare --modes llm,llm-facts             # per-turn, today's prompt vs the fact sheet on gpt-5-mini
 *
 * The AI modes need OPENAI_API_KEY and spend real money. `--max-usd` caps spend per run (per case
 * for case sets, per transcript otherwise); a run that hits it stops calling the model, and the
 * report says how far it got.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTranscript } from '@uc/core';
import { CASES, loadBlindCases, type FixtureCase, type RepoName } from '@uc/fixtures';
import { evaluate } from './metrics';
import { runCase, surfaced, type CaseRun } from './runner';

type Mode = 'heuristic' | 'tiered' | 'llm' | 'llm-facts';

/** Set the environment the runner reads for one mode (llm-facts: per-turn with the fact sheet on the small model). */
function useMode(mode: Mode) {
  process.env.ANALYZER = mode === 'llm-facts' ? 'llm' : mode;
  if (mode === 'llm-facts') {
    process.env.UC_PROMPT_STYLE = 'facts';
    process.env.UC_CANDIDATES_TIER = 'cheap';
  } else {
    delete process.env.UC_PROMPT_STYLE;
    delete process.env.UC_CANDIDATES_TIER;
  }
}

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// The API loads .env itself; this script runs outside it.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const modes = (opt('modes') ?? 'heuristic,tiered').split(',').map((m) => m.trim()) as Mode[];
const maxUsd = Number(opt('max-usd') ?? 4);
if (flag('no-rules')) process.env.UC_TIERED_RULES = 'off';
const config = { budget: { workspaceLimitUsd: maxUsd } };

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function byOperation(runs: CaseRun[]) {
  const rows = new Map<string, { calls: number; input: number; cached: number; output: number; reasoning: number; cost: number; failures: Map<string, number> }>();
  for (const u of runs.flatMap((r) => r.usage.records)) {
    const k = `${u.operation} (${u.model})`;
    const row = rows.get(k) ?? { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0, failures: new Map() };
    row.calls++;
    row.reasoning += u.reasoningTokens ?? 0;
    if (u.failed) row.failures.set(u.failure ?? 'unknown', (row.failures.get(u.failure ?? 'unknown') ?? 0) + 1);
    row.input += u.inputTokens;
    row.cached += u.cachedInputTokens ?? 0;
    row.output += u.outputTokens;
    row.cost += u.estimatedCostUsd;
    rows.set(k, row);
  }
  return [...rows.entries()].sort((a, b) => b[1].cost - a[1].cost);
}

function printOperations(runs: CaseRun[]) {
  for (const [op, r] of byOperation(runs)) {
    const unusable = [...r.failures.values()].reduce((s, n) => s + n, 0);
    console.log(
      `   ${op.padEnd(34)} ${String(r.calls).padStart(5)} calls (${unusable} unusable)  in ${r.input.toLocaleString().padStart(9)} (cached ${r.cached.toLocaleString()})  out ${r.output.toLocaleString().padStart(8)} (reasoning ${r.reasoning.toLocaleString()})  ${usd(r.cost)}`,
    );
    for (const [why, n] of r.failures) console.log(`      unusable ×${n}: ${why}`);
  }
}

async function compareCases(cases: FixtureCase[], label: string) {
  console.log(`\n${label}: ${cases.length} cases\n`);
  const summary: string[] = [];
  for (const mode of modes) {
    useMode(mode);
    const runs: CaseRun[] = [];
    const report = await evaluate(cases, async (c) => {
      const r = await runCase(c, { config });
      runs.push(r);
      return r;
    });
    const tp = report.cases.reduce((s, c) => s + c.truePositives, 0);
    const fp = report.cases.reduce((s, c) => s + c.falsePositives + c.forbiddenSurfaced.length, 0);
    const miss = report.cases.reduce((s, c) => s + c.missed, 0);
    // The misses that matter most: an issue case where nothing at all was raised; and alarms on cases that should stay silent.
    const issueCases = report.cases.filter((c) => c.expected.length > 0);
    const silentMisses = issueCases.filter((c) => c.actual.length === 0).map((c) => c.id);
    const silentAlarms = report.cases.filter((c) => c.expected.length === 0 && c.actual.length > 0).map((c) => c.id);
    console.log(`${mode}: precision ${pct(report.precision)} · recall ${pct(report.recall)} · caught ${tp} · false alarms ${fp} · missed ${miss} · cost ${usd(report.totalCostUsd)}`);
    console.log(
      `   nothing raised on ${silentMisses.length}/${issueCases.length} issue cases${silentMisses.length ? ` (${silentMisses.join(', ')})` : ''} · raised something on ${silentAlarms.length} cases that should stay silent${silentAlarms.length ? ` (${silentAlarms.join(', ')})` : ''}`,
    );
    for (const c of report.cases.filter((x) => x.missed || x.falsePositives || x.forbiddenSurfaced.length)) {
      console.log(`   ${c.id}: expected ${c.expected.join(',') || '(silent)'} · got ${c.actual.join(',') || '(silent)'}`);
    }
    printOperations(runs);
    summary.push(
      `${mode.padEnd(10)} nothing raised on ${String(silentMisses.length).padStart(2)}/${issueCases.length} issue cases · alarms on ${silentAlarms.length} silent cases · category recall ${pct(report.recall).padStart(4)} · cost ${usd(report.totalCostUsd)}`,
    );
  }
  console.log(`\n${summary.join('\n')}`);
}

async function compareTranscript(file: string, repo: RepoName | null) {
  const text = readFileSync(file, 'utf8');
  const segs = parseTranscript(text);
  const stamps = segs.map((s) => s.timestamp).filter((t): t is number => t !== undefined);
  const minutes = stamps.length > 1 ? (stamps.at(-1)! - stamps[0]!) / 60_000 : segs.length * (4 / 60);
  console.log(`\nTranscript ${file}: ${segs.length} turns, ${minutes.toFixed(1)} meeting minutes, repo ${repo ?? 'none'}, cap ${usd(maxUsd)} per mode\n`);
  const c: FixtureCase = { id: 'transcript', title: file, repo, transcript: text, expected: { surfaced: [] } };
  const summary: string[] = [];
  for (const mode of modes) {
    useMode(mode);
    const started = Date.now();
    const r = await runCase(c, { config });
    const cost = r.usage.records.reduce((s, u) => s + u.estimatedCostUsd, 0);
    // Where the budget stopped the model, extrapolate from the part it covered.
    const stopAt = r.events.findIndex((e) => e.type === 'budget_exhausted');
    const coveredTurns = stopAt >= 0 ? r.events.slice(0, stopAt).filter((e) => e.type === 'segment_added').length : segs.length;
    const coveredMinutes = stamps.length > 1 && coveredTurns < segs.length ? (stamps[Math.max(0, coveredTurns - 1)]! - stamps[0]!) / 60_000 : minutes;
    const perHour = coveredMinutes > 0 ? (cost / coveredMinutes) * 60 : 0;
    const found = surfaced(r.engine);
    const m = r.engine.state.metrics;
    console.log(
      `${mode}: ${usd(cost)} for ${coveredMinutes.toFixed(1)} min → ${usd(perHour)} per meeting hour · ${found.length} suggestions · ${((Date.now() - started) / 1000).toFixed(0)} s wall` +
        (stopAt >= 0 ? ` · STOPPED at the ${usd(maxUsd)} cap after ${coveredTurns}/${segs.length} turns` : '') +
        (m.screens ? ` · screens ${m.screens}, flags ${m.screenFlags ?? 0}, deep calls ${m.deepCalls ?? 0}` : ''),
    );
    printOperations([r]);
    for (const d of found) console.log(`   • [${d.category}] ${d.title}`);
    summary.push(`${mode.padEnd(10)} ${usd(perHour).padStart(8)} per hour  ${String(found.length).padStart(3)} suggestions${stopAt >= 0 ? '  (extrapolated)' : ''}`);
  }
  console.log(`\n${summary.join('\n')}`);
}

const transcript = opt('transcript');
if (transcript) await compareTranscript(transcript, (opt('repo') as RepoName | undefined) ?? null);
else if (flag('blind')) {
  const blind = loadBlindCases();
  if (blind.length === 0) console.log('No blind cases yet: add folders to packages/fixtures/blind (see its README).');
  else await compareCases(blind, 'Blind cases');
} else await compareCases(CASES, 'Development cases (written alongside the rules, not blind)');
