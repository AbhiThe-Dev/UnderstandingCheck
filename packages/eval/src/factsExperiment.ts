/**
 * Does the fact sheet pay off? Same turns, five arms, real model calls (costs money; capped).
 *
 *   pnpm eval:facts [--meeting meeting.txt --from 330 --to 390] [--max-usd 2]
 *
 * A: today's prompt, gpt-5 low · B: fact sheet, gpt-5 low · C: fact sheet, gpt-5-mini low ·
 * D: fact sheet, gpt-5-mini minimal · E: the cheapest passing arm with one planted false fact
 * (an unmentioned effect marked as discussed) on four cases.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  LlmAnalyzer,
  LlmOutputError,
  type LlmProvider,
  type Analyzer,
  type CandidateInput,
  type EngineEvent,
  type ModelTier,
  type ReasoningEffort,
} from '@uc/core';
import { CASES, type FixtureCase } from '@uc/fixtures';
import { createLlmProviderFromEnv } from '@uc/providers';
import { evaluate } from './metrics';
import { MemoryUsage, runCase, surfaced, type CaseRun } from './runner';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const inner = createLlmProviderFromEnv();
if (!inner) throw new Error('OPENAI_API_KEY is required');
/** Why answers were unusable, by arm: cut off at the output cap, or other. */
const unusable: Record<string, string[]> = {};
let currentArm = '';
const provider: LlmProvider = {
  name: inner.name,
  async complete(req) {
    try {
      return await inner.complete(req);
    } catch (e) {
      if (e instanceof LlmOutputError) (unusable[currentArm] ??= []).push(`${req.operation}: ${e.finishReason === 'length' ? `cut off at ${req.maxOutputTokens} tokens` : e.message.slice(0, 120)}`);
      throw e;
    }
  },
};

const CAP = Number(opt('max-usd') ?? 2);
let spent = 0;

const ISSUE_CASES = ['demo-undo-approval', 'f2-hidden-assumption', 'f3-codebase-conflict', 'f4-missing-specification', 'f5-false-alignment', 'e7-historical-conflict', 'h1-cancel-refund', 'h2-reuse-receipt'];
const SILENT_CASES = ['e3-genuine-agreement', 'h4-genuine-agreement', 's3-slack-agrees'];
const PLANT_CASES = ['demo-undo-approval', 'f3-codebase-conflict', 'f5-false-alignment', 'h1-cancel-refund'];
const pick = (ids: string[]) => ids.map((id) => CASES.find((c) => c.id === id)!).filter(Boolean);

const meetingFile = opt('meeting');
const meeting: FixtureCase | null =
  meetingFile && existsSync(meetingFile)
    ? {
        id: 'meeting-consent-window',
        title: 'Recorded meeting, consent discussion',
        repo: 'approvals',
        transcript: readFileSync(meetingFile, 'utf8')
          .split('\n')
          .slice(Number(opt('from') ?? 330), Number(opt('to') ?? 390))
          .join('\n'),
        expected: { surfaced: [] },
      }
    : null;

interface Arm {
  name: string;
  style: 'raw' | 'facts';
  tier: ModelTier;
  effort: ReasoningEffort;
  plant?: boolean;
}

/** Wraps the LLM analyzer to plant one false fact: an unmentioned effect in focus marked as discussed in the first turn. */
function planting(inner: LlmAnalyzer, planted: { factId: string; segmentId: string }[]): Analyzer {
  return {
    name: inner.name,
    analyzeSegment: (ctx) => inner.analyzeSegment(ctx),
    draftClarification: (...a) => inner.draftClarification(...a),
    interpretResponse: (...a) => inner.interpretResponse(...a),
    generateCandidates: (input: CandidateInput) => {
      const facts = input.facts;
      const target = facts?.effects.find((f) => f.inFocus && f.matchingTurns.length === 0 && f.category !== 'data');
      if (facts && target) {
        const first = input.ctx.state.claims.find((c) => !c.participantId.startsWith('prior:'));
        if (first) {
          const speaker = input.ctx.state.participants.find((p) => p.id === first.participantId)?.displayName ?? 'someone';
          target.matchingTurns = [{ segmentId: first.segmentId, speaker }];
          if (!planted.some((p) => p.factId === target.id)) planted.push({ factId: target.id, segmentId: first.segmentId });
        }
      }
      return inner.generateCandidates(input);
    },
  };
}

async function runArm(arm: Arm, cases: FixtureCase[]) {
  currentArm = arm.name;
  const usages: MemoryUsage[] = [];
  const disputes: { caseId: string; factId: string; reason: string }[] = [];
  const planted: Record<string, { factId: string; segmentId: string }[]> = {};
  const runs: CaseRun[] = [];
  const report = await evaluate(cases, async (c) => {
    if (spent >= CAP) throw new Error(`Experiment cap of $${CAP} reached`);
    const usage = new MemoryUsage();
    usages.push(usage);
    const llm = new LlmAnalyzer({
      provider: provider!,
      sessionId: c.id,
      usage,
      limits: { ...DEFAULT_CONFIG.llm, effort: { ...DEFAULT_CONFIG.llm.effort, candidates: arm.effort } },
      promptStyle: arm.style,
      candidatesTier: arm.tier,
    });
    const analyzer = arm.plant ? planting(llm, (planted[c.id] = [])) : llm;
    const r = await runCase(c, { analyzer, config: { budget: { workspaceLimitUsd: 1 } } });
    spent += usage.spentUsd();
    for (const e of r.events.filter((x): x is Extract<EngineEvent, { type: 'fact_disputed' }> => x.type === 'fact_disputed')) {
      disputes.push({ caseId: c.id, factId: e.factId, reason: e.reason });
    }
    const out = { ...r, usage };
    runs.push(out);
    return out;
  });
  const records = usages.flatMap((u) => u.records);
  const cand = records.filter((r) => r.operation === 'candidates');
  return {
    arm,
    report,
    runs,
    disputes,
    planted,
    cost: records.reduce((s, r) => s + r.estimatedCostUsd, 0),
    candCalls: cand.length,
    failed: records.filter((r) => r.failed).length,
    reasoning: cand.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0),
    output: cand.reduce((s, r) => s + r.outputTokens, 0),
  };
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const consentRaised = (r: CaseRun) => surfaced(r.engine).some((d) => /consent|privacy/i.test(`${d.title} ${d.description} ${d.interpretations.map((i) => i.behavior).join(' ')}`));

const cases = [...pick(ISSUE_CASES), ...pick(SILENT_CASES), ...(meeting ? [meeting] : [])];
const ALL_ARMS: Arm[] = [
  { name: 'A raw · gpt-5 low', style: 'raw', tier: 'reasoning', effort: 'low' },
  { name: 'B facts · gpt-5 low', style: 'facts', tier: 'reasoning', effort: 'low' },
  { name: 'C facts · gpt-5-mini low', style: 'facts', tier: 'cheap', effort: 'low' },
  { name: 'D facts · gpt-5-mini minimal', style: 'facts', tier: 'cheap', effort: 'minimal' },
];
// --arms C,D runs a subset (letters); --plant-arm C picks the arm for the planted-fact test.
const only = opt('arms')?.split(',');
const arms = only ? ALL_ARMS.filter((a) => only.includes(a.name[0]!)) : ALL_ARMS;

console.log(`Cases: ${ISSUE_CASES.length} with an expected issue, ${SILENT_CASES.length} that should stay silent${meeting ? ', plus the recorded-meeting consent window' : ''}. Cap $${CAP}.\n`);
type ArmResult = Awaited<ReturnType<typeof runArm>>;
const results: ArmResult[] = [];
for (const arm of arms) {
  const r = await runArm(arm, cases);
  results.push(r);
  const issues = r.report.cases.filter((c) => ISSUE_CASES.includes(c.id));
  const silent = r.report.cases.filter((c) => SILENT_CASES.includes(c.id));
  const meetingRun = r.runs.find((x) => x.engine.state.sessionId === 'meeting-consent-window');
  console.log(
    `${arm.name.padEnd(30)} caught ${issues.filter((c) => c.truePositives > 0).length}/${issues.length} · false alarms on silent ${silent.reduce((s, c) => s + c.suggestions, 0)}` +
      (meetingRun ? ` · consent raised ${consentRaised(meetingRun) ? 'yes' : 'no'}` : '') +
      ` · ${r.candCalls} calls (${r.failed} unusable) · output ${r.output.toLocaleString()} (reasoning ${r.reasoning.toLocaleString()}) · ${usd(r.cost)} · disputes ${r.disputes.length}`,
  );
  for (const c of issues.filter((x) => x.truePositives === 0)) console.log(`   missed ${c.id}: got ${c.actual.join(',') || '(silent)'}`);
  for (const c of silent.filter((x) => x.suggestions > 0)) console.log(`   false alarm ${c.id}: ${c.actual.join(',')}`);
  for (const d of r.disputes) console.log(`   disputed ${d.caseId} ${d.factId}: ${d.reason}`);
  const why = Object.entries((unusable[arm.name] ?? []).reduce<Record<string, number>>((m, w) => ((m[w] = (m[w] ?? 0) + 1), m), {}));
  for (const [w, n] of why) console.log(`   unusable ×${n}: ${w}`);
}

// Gate: the cheapest fact-sheet arm that matches A on catches, adds no false alarms, and keeps the consent catch.
const a = results.find((r) => r.arm.style === 'raw');
const factArms = results.filter((r) => r.arm.style === 'facts');
const caught = (x: ArmResult) => x.report.cases.filter((c) => ISSUE_CASES.includes(c.id) && c.truePositives > 0).length;
const alarms = (x: ArmResult) => x.report.cases.filter((c) => SILENT_CASES.includes(c.id)).reduce((s, c) => s + c.suggestions, 0);
const consent = (x: ArmResult) => !meeting || consentRaised(x.runs.find((r) => r.engine.state.sessionId === 'meeting-consent-window')!);
const passing = a ? factArms.filter((x) => caught(x) >= caught(a) && alarms(x) <= alarms(a) && (!consent(a) || consent(x))).sort((x, y) => x.cost - y.cost) : [];
if (a) console.log(`\nPassing arms (cheapest first): ${passing.map((x) => x.arm.name).join(' | ') || 'none'}`);

const plantArm = opt('plant-arm');
const best = (plantArm ? ALL_ARMS.find((x) => x.name.startsWith(plantArm)) : undefined) ?? passing[0]?.arm ?? factArms[0]!.arm;
const e = await runArm({ ...best, name: `E planted · ${best.name.slice(2)}`, plant: true }, pick(PLANT_CASES));
const plantedTotal = Object.values(e.planted).reduce((s, p) => s + p.length, 0);
const disputedPlanted = e.disputes.filter((d) => e.planted[d.caseId]?.some((p) => p.factId === d.factId)).length;
console.log(
  `${e.arm.name}: planted ${plantedTotal} false facts, disputed ${disputedPlanted} · still caught ${e.report.cases.filter((c) => c.truePositives > 0).length}/${PLANT_CASES.length} · ${e.failed} unusable calls · ${usd(e.cost)}`,
);
for (const d of e.disputes) console.log(`   disputed ${d.caseId} ${d.factId}: ${d.reason}`);
for (const [id, p] of Object.entries(e.planted)) for (const x of p) console.log(`   planted ${id} ${x.factId} as discussed in ${x.segmentId}`);
console.log(`\nTotal spent: ${usd(spent)}`);
