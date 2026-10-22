import { getCase } from '@uc/fixtures';
import { runCase } from './runner';

/** `pnpm tsx packages/eval/src/trace.ts <case-id>` — print the engine's view of one fixture, turn by turn. */
const id = process.argv[2] ?? 'demo-undo-approval';
const { engine, events } = await runCase(getCase(id));
const name = (pid: string) => engine.state.participants.find((p) => p.id === pid)?.displayName ?? pid;
for (const e of events) {
  switch (e.type) {
    case 'segment_added':
      console.log(`\n[${e.segment.id}] ${name(e.segment.participantId)}: ${e.segment.text}`);
      break;
    case 'context_retrieved':
      console.log(`   retrieved ${e.evidenceIds.join(',') || '-'} sufficient=${e.sufficient}`);
      break;
    case 'discrepancy_created':
      console.log(`   + ${e.discrepancy.id} ${e.discrepancy.category} key=${e.discrepancy.key} status=${e.discrepancy.status}`);
      break;
    case 'discrepancy_updated':
      console.log(`   ~ ${e.discrepancy.id} ${e.discrepancy.category} ${e.note} → ${e.discrepancy.status}/${e.discrepancy.visibility} score=${e.discrepancy.impactScore}`);
      break;
    case 'clarification_created':
      console.log(`   ? ${e.clarification.id} ${e.clarification.purpose}${e.clarification.targetedParticipantId ? `→${name(e.clarification.targetedParticipantId)}` : ''}: ${e.clarification.scenario ?? ''} ${e.clarification.question}`);
      break;
    case 'candidate_rejected':
      console.log(`   ✗ rejected ${e.reason}: ${e.detail}`);
      break;
    case 'requirement_recorded':
      console.log(`   ✓ requirement v${e.requirement.version} [${e.requirement.status}/${e.requirement.confirmation}] ${e.requirement.description}`);
      break;
    case 'analysis_skipped':
      console.log(`   (skipped: ${e.reason})`);
      break;
  }
}
console.log('\nfocus:', engine.state.focus?.symbolName, engine.state.focus?.reversal ? '(reversal)' : '');
for (const d of engine.state.discrepancies) {
  console.log(`${d.id} ${d.category} ${d.status}/${d.visibility} score=${d.impactScore} relevant=${d.relevantParticipantIds.map(name).join(',')}`);
  console.log(`   ${d.title}`);
  for (const p of d.positions) console.log(`   position ${name(p.participantId)} → ${p.interpretationId} (${p.provenance})`);
}
