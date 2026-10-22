import type { CodeSymbol, DiscrepancyCategory } from '@uc/core';
import type { FixtureCase } from '@uc/fixtures';
import { loadSampleRepo, runCase, surfaced, type CaseRun } from './runner';

export interface CaseResult {
  id: string;
  heldOut: boolean;
  expected: DiscrepancyCategory[];
  actual: DiscrepancyCategory[];
  truePositives: number;
  falsePositives: number;
  missed: number;
  forbiddenSurfaced: DiscrepancyCategory[];
  evidenceRefs: number;
  invalidEvidenceRefs: number;
  suggestions: number;
  duplicatesSuppressed: number;
  rejectedCandidates: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface EvalReport {
  cases: CaseResult[];
  precision: number;
  recall: number;
  falsePositiveRate: number;
  silentCasesCorrect: string;
  evidenceValidity: number;
  totalCostUsd: number;
}

/** Re-check every surfaced code reference against the raw index (independent of the engine's validator). */
function countInvalidRefs(run: CaseRun, symbols: CodeSymbol[]): { total: number; invalid: number } {
  let total = 0;
  let invalid = 0;
  for (const d of surfaced(run.engine)) {
    for (const r of d.codeRefs) {
      total++;
      const ok = symbols.some(
        (s) => s.filePath === r.filePath && s.commitSha === r.commitSha && s.startLine <= r.startLine && r.endLine <= s.endLine,
      );
      if (!ok) invalid++;
    }
  }
  return { total, invalid };
}

export async function evaluate(cases: FixtureCase[], run: (c: FixtureCase) => Promise<CaseRun> = (c) => runCase(c)): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await run(c);
    const actual = surfaced(r.engine).map((d) => d.category);
    const remaining = [...actual];
    let tp = 0;
    for (const cat of c.expected.surfaced) {
      const i = remaining.indexOf(cat);
      if (i >= 0) {
        tp++;
        remaining.splice(i, 1);
      }
    }
    const symbols = c.repo ? (await loadSampleRepo(c.repo)).symbols : [];
    const refs = countInvalidRefs(r, symbols);
    results.push({
      id: c.id,
      heldOut: Boolean(c.heldOut),
      expected: c.expected.surfaced,
      actual,
      truePositives: tp,
      falsePositives: remaining.length,
      missed: c.expected.surfaced.length - tp,
      forbiddenSurfaced: actual.filter((a) => c.expected.notSurfaced?.includes(a)),
      evidenceRefs: refs.total,
      invalidEvidenceRefs: refs.invalid,
      suggestions: actual.length,
      duplicatesSuppressed: r.engine.state.metrics.duplicatesSuppressed,
      rejectedCandidates: r.engine.state.metrics.candidatesRejected,
      inputTokens: r.usage.records.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: r.usage.records.reduce((s, u) => s + u.outputTokens, 0),
      costUsd: r.usage.spentUsd(),
    });
  }
  const tp = results.reduce((s, r) => s + r.truePositives, 0);
  const fp = results.reduce((s, r) => s + r.falsePositives, 0);
  const fn = results.reduce((s, r) => s + r.missed, 0);
  const silent = results.filter((r) => r.expected.length === 0);
  const refs = results.reduce((s, r) => s + r.evidenceRefs, 0);
  const bad = results.reduce((s, r) => s + r.invalidEvidenceRefs, 0);
  return {
    cases: results,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    falsePositiveRate: tp + fp === 0 ? 0 : fp / (tp + fp),
    silentCasesCorrect: `${silent.filter((r) => r.actual.length === 0).length}/${silent.length}`,
    evidenceValidity: refs === 0 ? 1 : (refs - bad) / refs,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
  };
}
