import { buildSummary, parseTranscript, summaryToMarkdown, type Discrepancy } from '@uc/core';
import { SEEDED_DEMO, SEEDED_DEMO_RESOLUTION } from '@uc/fixtures';
import { participantId, runCase } from './runner';

/**
 * `pnpm demo` — the Phase 1 milestone end to end, without credentials:
 * transcript replay → code-aware false-alignment suspicion → private scenario checks →
 * confirmed difference → resolution in conversation → agreed requirement + summary.
 */
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const { engine, usage } = await runCase(SEEDED_DEMO);
const name = (id: string) => engine.state.participants.find((p) => p.id === id)?.displayName ?? id;

console.log(bold('\n1. Transcript replay'));
for (const s of engine.segments) console.log(`   ${name(s.participantId)}: ${s.text}`);

const show = (d: Discrepancy) => {
  console.log(`   ${bold(d.title)}  ${dim(`[${d.category} · ${d.status} · score ${d.impactScore}]`)}`);
  console.log(`   ${d.description}`);
  for (const r of d.codeRefs) console.log(dim(`   ↳ ${r.filePath}:${r.startLine} @ ${r.commitSha.slice(0, 18)} — ${r.note}`));
  for (const i of d.interpretations) console.log(`   ${i.id}. ${i.label}: ${dim(i.behavior)}`);
};

const live = engine.state.discrepancies.filter((d) => d.visibility === 'live');
console.log(bold(`\n2. Private suggestions (${live.length})`));
live.forEach(show);
const d = live[0];
if (!d) throw new Error('Expected a live suggestion');

const checks = engine.state.clarifications.filter((c) => c.discrepancyId === d.id && c.purpose === 'private_check');
console.log(bold('\n3. Private scenario checks (asked separately, nothing claimed about disagreement yet)'));
for (const c of checks) console.log(`   → ${name(c.targetedParticipantId!)}: ${c.scenario} ${bold(c.question)}`);

const answers: Record<string, string> = {
  Priya: 'No. Once the approval is undone they should lose access right away.',
  Sam: 'Yes, they keep access, I was only going to change the status.',
};
for (const c of checks) {
  const who = name(c.targetedParticipantId!);
  await engine.respond(c.id, c.targetedParticipantId!, { text: answers[who]! });
  console.log(`   ← ${who}: "${answers[who]}" ${dim(`→ interpretation ${c.responses.at(-1)?.interpretationId ?? '(ambiguous)'}`)}`);
}

console.log(bold('\n4. Comparison'));
show(d);
const surfaceQ = engine.state.clarifications.find((c) => c.discrepancyId === d.id && c.purpose === 'surface_difference');
if (surfaceQ) console.log(`   Suggest asking: ${bold(surfaceQ.question)}\n   ${dim(surfaceQ.scenario ?? '')}`);

console.log(bold('\n5. The team discusses it'));
for (const seg of parseTranscript(SEEDED_DEMO_RESOLUTION)) {
  await engine.ingest(seg);
  console.log(`   ${seg.speaker}: ${seg.text}`);
}
console.log(`   status: ${d.status}; decision: ${d.resolution?.summary ?? '(none)'}`);
console.log(dim(`   confirmed by ${d.resolution?.confirmedBy.map(name).join(', ') ?? '-'}`));
void participantId;

await engine.finalize();
console.log(bold('\n6. Meeting summary (GitHub issue markdown)\n'));
console.log(summaryToMarkdown(buildSummary(engine.state), { commitSha: engine.state.commitSha }));

const m = engine.state.metrics;
console.log(bold('\n7. Cost & activity'));
console.log(
  `   analyzer ${dim('heuristic-v1 (no model calls)')} · segments ${m.segmentsSeen} · analyses ${m.analysesRun} (skipped ${m.analysesSkipped}) · retrievals ${m.retrievals} (cache hits ${m.retrievalCacheHits})`,
);
console.log(`   model calls ${usage.records.length} · tokens ${usage.records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0)} · est. cost $${usage.spentUsd().toFixed(4)}\n`);
