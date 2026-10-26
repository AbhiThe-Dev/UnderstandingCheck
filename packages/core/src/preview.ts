import type { EngineConfig } from './config';
import { CONSEQUENCE_WEIGHT, describeEffect, humanizeCallee, humanizeCondition } from './lexicon';
import type { PreviewInput, RawCodeRef, RawPreview, SegmentAnalysis, SlackContextItem } from './ports';
import { contentTerms, markers, quoteAppearsIn, splitIdentifier, stem, truncate } from './text';
import type {
  CodeEvidence,
  CodeRef,
  Discrepancy,
  Effect,
  ImplementationPreview,
  PreviewContent,
  PreviewScenario,
  PreviewUsage,
  Quote,
  Requirement,
  Segment,
  SlackCitation,
} from './types';

export const EMPTY_PREVIEW_USAGE: PreviewUsage = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, model: null };

// ---------------------------------------------------------------- detection (free, every analysed turn)

export interface PreviewSignal {
  score: number;
  reasons: string[];
  terms: string[];
  symbolIds: string[];
}

/** Talk that proposes changing behavior, as opposed to asking, agreeing or reporting status. */
const CHANGE_KINDS = new Set(['requirement', 'proposal', 'correction']);

/** "Sounds good", but not "great, and they should still get the credit" (agreement plus a requirement). */
export function onlyAgrees(analysis: SegmentAnalysis): boolean {
  return analysis.bareAgreement && !analysis.kinds.some((k) => CHANGE_KINDS.has(k));
}

/**
 * Does the turn propose or require a change? Besides "should/must/I'll", product requests are often
 * imperative ("when a customer downgrades, remove their premium access"), which the concern rules
 * do not count as a requirement: an implementation verb with enough substance counts here.
 */
export function proposesChange(text: string, analysis: SegmentAnalysis): boolean {
  if (onlyAgrees(analysis) || analysis.terms.length < 2) return false;
  if (analysis.kinds.some((k) => CHANGE_KINDS.has(k)) || analysis.reversalWord !== null || analysis.reuseTarget !== null) return true;
  const m = markers(text);
  return m.has('implementation') && !m.has('question') && analysis.terms.length >= 3;
}

/**
 * Is this turn a proposed change whose consequences depend on existing code? Rules only: the turn
 * must propose or require something, and either touch code with consequential side effects or have
 * just produced a code-backed concern. Most technical talk scores below the hint threshold.
 */
export function previewSignal(input: { text: string; analysis: SegmentAnalysis; evidence: CodeEvidence[]; touched: Discrepancy[] }): PreviewSignal | null {
  const { analysis, evidence, touched } = input;
  if (!proposesChange(input.text, analysis)) return null;

  const code = evidence.filter((e) => !e.isTest);
  const primary = code.filter((e) => e.reason.startsWith('matches') || e.reason === 'on screen');
  const concerns = touched.filter((d) => d.codeRefs.length > 0);
  if (primary.length === 0 && concerns.length === 0) return null;

  const reasons: string[] = [];
  let top: { e: CodeEvidence; eff: Effect; w: number } | null = null;
  for (const e of code) for (const eff of e.effects) if (!top || CONSEQUENCE_WEIGHT[eff.category] > top.w) top = { e, eff, w: CONSEQUENCE_WEIGHT[eff.category] };

  let score = 0.2;
  if (top) {
    score += 0.5 * top.w;
    reasons.push(`${top.e.symbolName} (${top.e.filePath}) ${describeEffect(top.eff)}`);
  }
  // The change reaches past the code it names: what that code calls has its own consequences.
  if (code.some((e) => e.reason.startsWith('called by') && e.effects.length > 0)) score += 0.1;
  if (analysis.kinds.includes('requirement')) score += 0.1;
  if (concerns.length > 0) {
    score += 0.3;
    reasons.push(`Raised as a concern: ${concerns[0]!.title}`);
  }
  return {
    score: Math.min(1, Math.round(score * 100) / 100),
    reasons,
    terms: analysis.terms,
    symbolIds: [...new Set([...primary.map((e) => e.symbolId), ...concerns.flatMap((d) => d.codeRefs.map((r) => symbolOf(r, evidence)))].filter(Boolean))] as string[],
  };
}

function symbolOf(r: CodeRef, evidence: CodeEvidence[]): string | undefined {
  return evidence.find((e) => e.id === r.evidenceId)?.symbolId;
}

/** Does a turn (its terms and the code it touched) belong to the same technical decision as `p`? */
export function sameDecision(p: Pick<ImplementationPreview, 'terms' | 'symbolIds'>, terms: string[], symbolIds: string[], minOverlap: number): boolean {
  if (symbolIds.some((id) => p.symbolIds.includes(id))) return true;
  const shared = terms.filter((t) => p.terms.includes(t)).length;
  return shared >= 2 && shared / Math.max(1, Math.min(terms.length, p.terms.length)) >= minOverlap;
}

// ---------------------------------------------------------------- input for the analysis

/**
 * The conversation a preview reads: the decision's own turns, two turns before it, and what was said
 * between them, capped in turns and characters (oldest context goes first). Later unrelated talk is
 * left out, so it neither costs tokens nor invalidates the stored answer.
 */
export function discussionWindow(segments: Segment[], focusIds: string[], cfg: EngineConfig['preview']): Segment[] {
  if (segments.length === 0) return [];
  const focus = new Set(focusIds);
  const own = segments.filter((s) => focus.has(s.id));
  const first = own[0]?.index ?? segments.at(-1)!.index;
  const last = own.at(-1)?.index ?? segments.at(-1)!.index;
  const window = segments.slice(Math.max(0, first - 2), last + 1);
  const size = () => window.reduce((n, s) => n + Math.min(s.text.length, 500) + 40, 0);
  // Over budget: drop the oldest context turn, else the oldest of the decision's own turns; always keep the latest.
  while (window.length > 1 && (window.length > cfg.maxDiscussionTurns || size() > cfg.maxDiscussionChars)) {
    const i = window.findIndex((s) => !focus.has(s.id));
    window.splice(i >= 0 && i < window.length - 1 ? i : 0, 1);
  }
  return window;
}

/** Stable short hash (FNV-1a) of everything an analysis reads; equal hashes reuse the earlier answer. */
export function previewInputHash(parts: { commitSha: string; segmentIds: string[]; evidenceIds: string[]; requirementIds: string[]; slackIds: string[]; priorIds: string[] }): string {
  const text = JSON.stringify([parts.commitSha, parts.segmentIds, [...parts.evidenceIds].sort(), [...parts.requirementIds].sort(), [...parts.slackIds].sort(), [...parts.priorIds].sort()]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Paths a preview never reads, even when lexical search matches them. */
const SENSITIVE_PATH = /(^|\/)(\.env[^/]*|secrets?|credentials?|private[-_]?keys?)(\/|\.|$)/i;

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path);
}

// ---------------------------------------------------------------- validation

export interface PreviewValidation {
  content: PreviewContent;
  slackRefs: SlackCitation[];
  removed: { reason: string; detail: string }[];
}

/**
 * Hard gate between any analyzer and the user, like `validateCandidate` for concerns:
 * - a statement about current behavior survives only with a citation into code the analysis was shown,
 *   at the session's commit, with lines inside that symbol;
 * - an intended behavior counts as stated only with a verbatim quote, and as confirmed only with a
 *   confirmed requirement; otherwise it is shown as unspecified (never silently promoted);
 * - a question counts as answered only with a verbatim quote that answers it;
 * - a predicted impact may stand without code, but not on invented code.
 * What fails is dropped or downgraded, never repaired into a claim the evidence does not support.
 */
export function validatePreview(
  raw: RawPreview,
  ctx: { evidence: CodeEvidence[]; segments: Map<string, Segment>; commitSha: string; slack: SlackContextItem[]; requirements: Requirement[] },
): PreviewValidation {
  const removed: PreviewValidation['removed'] = [];
  const refs = (list: RawCodeRef[], where: string): { valid: CodeRef[]; invalid: number } => {
    const valid: CodeRef[] = [];
    let invalid = 0;
    for (const r of list) {
      const ev = ctx.evidence.find((e) => e.id === r.evidenceId);
      const problem = !ev
        ? `${r.evidenceId} was not part of the code shown`
        : ev.commitSha !== ctx.commitSha
          ? `${ev.filePath} is from another commit`
          : !Number.isInteger(r.startLine) || !Number.isInteger(r.endLine) || r.startLine > r.endLine
            ? `invalid lines ${r.startLine}-${r.endLine}`
            : r.startLine < ev.startLine || r.endLine > ev.endLine
              ? `${ev.filePath}:${r.startLine}-${r.endLine} is outside ${ev.symbolName} (${ev.startLine}-${ev.endLine})`
              : null;
      if (problem || !ev) {
        invalid++;
        removed.push({ reason: 'invalid_reference', detail: `${where}: ${problem}` });
        continue;
      }
      if (!valid.some((x) => x.evidenceId === ev.id && x.startLine === r.startLine)) {
        valid.push({ evidenceId: ev.id, filePath: ev.filePath, startLine: r.startLine, endLine: r.endLine, commitSha: ev.commitSha, symbolName: ev.symbolName, note: truncate(r.note ?? '', 200) });
      }
    }
    return { valid, invalid };
  };
  const quote = (q: { segmentId: string; quote: string } | null): Quote | null => {
    if (!q) return null;
    const seg = ctx.segments.get(q.segmentId);
    if (!seg || !quoteAppearsIn(q.quote.replace(/…$/, ''), seg.text)) return null;
    return { segmentId: seg.id, participantId: seg.participantId, quote: truncate(q.quote, 300) };
  };

  const slackRefs: SlackCitation[] = [];
  for (const r of raw.slackRefs) {
    const item = ctx.slack.find((s) => s.ref.id === r.refId);
    if (!item) removed.push({ reason: 'unknown_slack_message', detail: `${r.refId} was not in this Slack context` });
    else if (!slackRefs.some((x) => x.id === item.ref.id)) slackRefs.push({ ...item.ref, note: truncate(r.note, 200) });
  }

  const proposedChange = truncate(raw.proposedChange.trim(), 300);
  const summary = truncate(raw.summary.trim(), 400);
  if (raw.noImplications?.trim()) {
    return {
      content: { proposedChange, summary, contextStatus: ctx.evidence.length ? 'partial' : 'insufficient', currentBehavior: [], unknowns: [], impacts: [], scenarios: [], questions: [], clarification: null, noImplications: truncate(raw.noImplications.trim(), 300) },
      slackRefs,
      removed,
    };
  }

  const currentBehavior = raw.currentBehavior.flatMap((f) => {
    const r = refs(f.refs, 'current behavior');
    if (r.valid.length === 0) {
      removed.push({ reason: 'unsupported_fact', detail: truncate(f.text, 160) });
      return [];
    }
    return [{ text: truncate(f.text, 300), refs: r.valid }];
  });

  const impacts = raw.impacts.flatMap((i) => {
    const r = refs(i.refs, 'impact');
    // A prediction may rest on reasoning alone, but not on code that was never shown.
    if (i.refs.length > 0 && r.valid.length === 0) {
      removed.push({ reason: 'unsupported_impact', detail: truncate(i.text, 160) });
      return [];
    }
    return [{ text: truncate(i.text, 300), likelihood: i.likelihood, refs: r.valid }];
  });

  const confirmed = ctx.requirements.filter((r) => r.status === 'confirmed');
  const scenarios = raw.scenarios.map((s): PreviewScenario => {
    const r = refs(s.currentRefs, `scenario "${truncate(s.scenario, 60)}"`);
    let current: PreviewScenario['current'];
    if (s.currentBasis === 'verified' && r.valid.length === 0) {
      removed.push({ reason: 'unsupported_fact', detail: `scenario "${truncate(s.scenario, 60)}": ${truncate(s.current, 120)}` });
      current = { text: 'Not established from the code shown', basis: 'unknown', refs: [] };
    } else {
      current = { text: truncate(s.current, 240), basis: s.currentBasis, refs: s.currentBasis === 'unknown' ? [] : r.valid };
    }
    let intended: PreviewScenario['intended'] = { text: truncate(s.intended, 240), basis: 'unspecified', quote: null };
    if (s.intendedBasis === 'stated') {
      const q = quote(s.intendedQuote);
      // What was said is the words themselves: a paraphrase could add a detail ("immediately") nobody said.
      if (q) intended = { text: q.quote, basis: 'stated', quote: q };
      else removed.push({ reason: 'unsupported_intent', detail: `scenario "${truncate(s.scenario, 60)}": nobody was quoted saying it` });
    } else if (s.intendedBasis === 'confirmed') {
      const req = confirmed.find((x) => x.id === s.requirementId);
      if (req) intended = { text: truncate(s.intended, 240), basis: 'confirmed', quote: req.evidence[0]?.segmentId ? quote({ segmentId: req.evidence[0].segmentId, quote: req.evidence[0].text }) : null };
      else removed.push({ reason: 'unsupported_intent', detail: `scenario "${truncate(s.scenario, 60)}": no confirmed requirement ${s.requirementId ?? ''}`.trim() });
    }
    return { scenario: truncate(s.scenario, 160), current, intended };
  });

  const questions = raw.questions.map((q) => {
    const answer = q.status === 'answered' ? quote(q.answer) : null;
    if (q.status === 'answered' && !answer) removed.push({ reason: 'unsupported_answer', detail: truncate(q.text, 160) });
    return { text: truncate(q.text, 240), why: truncate(q.why, 240), status: answer ? ('answered' as const) : ('open' as const), answer };
  });
  const open = questions.filter((q) => q.status === 'open');
  const clarification = raw.clarification?.trim() ? truncate(raw.clarification.trim(), 240) : (open[0]?.text ?? null);

  const unknowns = raw.unknowns.map((u) => truncate(u, 240)).filter(Boolean);
  const contextStatus: PreviewContent['contextStatus'] =
    currentBehavior.length === 0 ? 'insufficient' : unknowns.length > 0 || removed.some((r) => r.reason === 'unsupported_fact') ? 'partial' : 'sufficient';
  if (contextStatus === 'insufficient' && !unknowns.length) unknowns.push('What the code does today could not be established from the indexed repository.');
  return {
    content: { proposedChange, summary, contextStatus, currentBehavior, unknowns, impacts, scenarios, questions, clarification, noImplications: null },
    slackRefs,
    removed,
  };
}

// ---------------------------------------------------------------- rule-based preview (no model)

/** "issue proration credit": an effect as a base-form verb phrase, for questions. */
function effectAction(eff: Effect): string {
  if (eff.kind === 'assign') return describeEffect(eff).replace(/^sets /, 'set ');
  const { verb, object, preposition } = humanizeCallee(eff.target);
  return verb ? [verb, preposition, object].filter(Boolean).join(' ') : `call ${eff.target}`;
}

const IT_RE = /\b(?:it|test)\(\s*(['"`])(.+?)\1/;

/**
 * A preview from the code's extracted side effects and its tests, without a model: what the code
 * does (cited), what the discussion has not mentioned, and one question about it. It does not reason
 * about consequences, and says so.
 */
export function rulePreview(input: PreviewInput): RawPreview {
  const focus = input.discussion.filter((s) => input.focusSegmentIds.includes(s.id));
  const proposal = focus[0] ?? input.discussion.at(-1);
  const saidStems = new Set(contentTerms(input.discussion.map((s) => s.text).join(' ')));
  const code = input.evidence.filter((e) => !e.isTest);
  const tests = input.evidence.filter((e) => e.isTest);

  const effects = code
    .flatMap((e) => e.effects.map((eff) => ({ e, eff })))
    .sort((a, b) => CONSEQUENCE_WEIGHT[b.eff.category] - CONSEQUENCE_WEIGHT[a.eff.category]);
  const ref = (e: CodeEvidence, line: number, note: string): RawCodeRef => ({ evidenceId: e.id, startLine: line, endLine: line, note });
  const describe = (x: { e: CodeEvidence; eff: Effect }) =>
    `${x.e.symbolName} ${describeEffect(x.eff)}${x.eff.condition ? ` when ${humanizeCondition(x.eff.condition)}` : ''}`;

  const currentBehavior: RawPreview['currentBehavior'] = effects.slice(0, 5).map((x) => ({ text: describe(x), refs: [ref(x.e, x.eff.line, x.eff.text)] }));
  for (const t of tests.slice(0, 2)) {
    const lines = t.snippet.split('\n');
    const i = lines.findIndex((l) => IT_RE.test(l));
    if (i >= 0) currentBehavior.push({ text: `A test expects: "${lines[i]!.match(IT_RE)![2]}"`, refs: [ref(t, t.startLine + i, t.filePath)] });
  }
  // Effects nobody has mentioned are where a change most often surprises people.
  // The effect's last word is its object ("email" in sendDowngradeEmail): has anyone talked about it?
  const mentioned = (eff: Effect) => saidStems.has(stem(splitIdentifier(eff.target).at(-1) ?? ''));
  const unmentioned = effects.filter((x) => CONSEQUENCE_WEIGHT[x.eff.category] >= 0.6 && !mentioned(x.eff));
  const impacts = unmentioned.slice(0, 3).map((x) => ({
    text: `Building this as discussed involves ${x.e.symbolName}, which ${describeEffect(x.eff)}; nobody has said whether that should change.`,
    likelihood: 'possible' as const,
    refs: [ref(x.e, x.eff.line, x.eff.text)],
  }));
  const scenarios: RawPreview['scenarios'] = [
    ...(unmentioned.length ? unmentioned : effects).slice(0, 3).map((x) => ({
      scenario: `${x.e.symbolName} runs after the change`,
      current: describeEffect(x.eff),
      currentBasis: 'verified' as const,
      currentRefs: [ref(x.e, x.eff.line, x.eff.text)],
      intended: 'Needs clarification',
      intendedBasis: 'unspecified' as const,
      intendedQuote: null,
      requirementId: null,
    })),
  ];
  const questions = unmentioned.slice(0, 2).map((x) => ({
    text: `With this change, should ${x.e.symbolName} still ${effectAction(x.eff)}?`,
    why: `The code does this today (${x.e.filePath}:${x.eff.line}) and the discussion has not mentioned it.`,
    status: 'open' as const,
    answer: null,
  }));
  return {
    noImplications: null,
    proposedChange: proposal ? truncate(proposal.text, 300) : 'The current discussion',
    summary:
      code.length > 0
        ? `Rule-based preview: ${code.length} related code symbol${code.length === 1 ? '' : 's'} and ${tests.length} test file${tests.length === 1 ? '' : 's'}. Side effects are listed from the code; consequences are not reasoned about without the AI analyzer.`
        : 'No code related to this discussion was found in the indexed repository.',
    currentBehavior,
    unknowns: code.length === 0 ? ['No matching code was found, so current behavior is unknown.'] : effects.length === 0 ? ['The related code has no side effects the indexer recognises; its behavior needs a closer read.'] : [],
    impacts,
    scenarios,
    questions,
    clarification: questions[0]?.text ?? null,
    slackRefs: [],
  };
}

