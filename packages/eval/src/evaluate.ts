import { CASES } from '@uc/fixtures';
import { evaluate } from './metrics';

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const report = await evaluate(CASES);
console.log(`Analyzer: ${process.env.ANALYZER === 'llm' ? 'llm (OpenAI)' : 'heuristic-v1 (no credentials)'}\n`);
console.log('case'.padEnd(28), 'held-out', 'expected'.padEnd(26), 'surfaced'.padEnd(26), 'tp fp miss  refs');
for (const r of report.cases) {
  console.log(
    r.id.padEnd(28),
    (r.heldOut ? 'yes' : '').padEnd(8),
    (r.expected.join(',') || '(silent)').padEnd(26),
    (r.actual.join(',') || '(silent)').padEnd(26),
    `${r.truePositives}  ${r.falsePositives}  ${r.missed}    ${r.evidenceRefs - r.invalidEvidenceRefs}/${r.evidenceRefs}`,
    r.forbiddenSurfaced.length ? `FORBIDDEN: ${r.forbiddenSurfaced.join(',')}` : '',
  );
}
console.log(`
precision ${pct(report.precision)} · recall ${pct(report.recall)} · false-positive rate ${pct(report.falsePositiveRate)}
silent cases correct ${report.silentCasesCorrect} · evidence validity ${pct(report.evidenceValidity)} · cost $${report.totalCostUsd.toFixed(4)}`);
const heldOut = report.cases.filter((r) => r.heldOut);
console.log(`held-out: ${heldOut.filter((r) => r.missed === 0 && r.falsePositives === 0).length}/${heldOut.length} exactly as labeled`);
