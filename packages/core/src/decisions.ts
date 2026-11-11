import type { EngineConfig } from './config';
import { CONSEQUENCE_WEIGHT, describeEffect } from './lexicon';
import type { RawDecisionEvaluation, RawDecisionFinding, SegmentAnalysis, SlackContextItem } from './ports';
import { checkCodeRefs, checkSlackRefs, onlyAgrees, proposesChange } from './preview';
import { isDocPath } from './retrieval';
import { markers, splitIdentifier, stem, truncate, words } from './text';
import type { CodeEvidence, DecisionFinding, QualityDimension, Segment, SessionState, TechnicalDecision } from './types';

// ---------------------------------------------------------------- detection (free, every analysed turn)

interface TechTopic {
  label: string;
  re: RegExp;
  dimensions: QualityDimension[];
}

/**
 * Vocabulary of technical decisions, generic across codebases: each topic names the qualities a
 * decision about it usually trades off. Matching a topic is necessary, not sufficient: the turn must
 * also propose or settle an approach.
 */
const TOPICS: TechTopic[] = [
  { label: 'caching', re: /\b(cache[sd]?|caching|memoi[sz]e[sd]?|redis|memcached?|ttl|cdn)\b/i, dimensions: ['performance', 'reliability', 'compatibility'] },
  {
    label: 'background processing',
    re: /\b(queues?|kafka|rabbitmq|sqs|pub\s?\/?\s?sub|background (jobs?|workers?|tasks?)|workers?|cron( jobs?)?|scheduled jobs?|event bus|asynchronous(ly)?|async|fire[- ]and[- ]forget)\b/i,
    dimensions: ['reliability', 'scalability'],
  },
  {
    label: 'data storage',
    // A bare "table" is often a UI table ("an export button that downloads the table"); a schema change says more.
    re: /\b(database|postgres(ql)?|mysql|mongo(db)?|dynamo(db)?|sqlite|elasticsearch|schemas?|migrations?|(new|add an?|drop the|nullable) columns?|columns? (to|on|in) the \w+ table|(new|separate|join|lookup|database|db) tables?|indexes|denormali[sz]e|foreign keys?|shard(ing)?|partition(ing)?|read replicas?|jsonb?)\b/i,
    dimensions: ['scalability', 'compatibility', 'reliability'],
  },
  {
    label: 'API and integration',
    re: /\b(graphql|grpc|rest(ful)?|endpoints?|apis?|websockets?|polling|poll|server[- ]sent events|rpc|webhooks?|versioning|breaking changes?|payloads?)\b/i,
    dimensions: ['compatibility', 'performance'],
  },
  {
    label: 'service architecture',
    re: /\b(micro-?services?|monolith|separate service|own service|split (it|this|that) (out|into)|serverless|lambdas?|sidecar|event[- ]driven|feature flags?)\b/i,
    dimensions: ['maintainability', 'reliability', 'scalability'],
  },
  {
    label: 'authentication and security',
    re: /\b(jwts?|oauth|encrypt(ed|ion)?|hash(ed|ing)?|secrets?|api keys?|cors|csrf|sanitiz\w*|plain ?text|local ?storage|cookies?|signed urls?|rate limit(ing|s)?|skip (the )?(auth\w*|check|validation))\b/i,
    dimensions: ['security'],
  },
  {
    label: 'consistency and concurrency',
    re: /\b(locks?|locking|transactions?|retr(y|ies|ying)|idempoten\w*|race conditions?|eventual(ly)? consisten\w*|optimistic|exactly[- ]once|at[- ]least[- ]once)\b/i,
    dimensions: ['reliability'],
  },
  {
    label: 'technology choice',
    re: /\b(library|framework|sdk|switch(ing)? (over )?(to|from)|migrat(e|ing) (to|from|off)|replac(e|ing) [\w ]{1,30}? with|rewrite|third[- ]party|roll our own|in[- ]house)\b/i,
    dimensions: ['maintainability', 'compatibility'],
  },
  {
    label: 'performance',
    re: /\b(batch(ing|es)?|n ?\+ ?1|paginat\w*|load (all|everything)|in[- ]memory|stream(ing)?|lazy[- ]load\w*|precompute\w*|debounce|throttl\w*|paralleli[sz]e|concurren(t|cy))\b/i,
    dimensions: ['performance', 'scalability'],
  },
];

/** Phrases that settle or commit to an approach ("let's go with", "we'll store it in"). */
const APPROACH_VERBS = 'use|go with|do|just|switch|move|put|store|cache|add|keep|make|run|host|deploy|build|replace|rewrite|split|migrate|drop|introduce|adopt|call|poll|queue|batch|encrypt|hash|expose';
const DECISIVE_RE = new RegExp(
  `\\b(let's (${APPROACH_VERBS})|we('ll| will) (${APPROACH_VERBS})|i('ll| will) (${APPROACH_VERBS})|we should (just )?(${APPROACH_VERBS})|the plan is|we('ve| have)? decided|going with|instead of|rather than)\\b`,
  'i',
);

export interface DecisionSignal {
  score: number;
  topics: string[];
  dimensions: QualityDimension[];
  terms: string[];
  symbolIds: string[];
  decisive: boolean;
}

export function technicalTopics(text: string): TechTopic[] {
  return TOPICS.filter((t) => t.re.test(text));
}

/**
 * Is this turn a technical decision (an architecture, technology or implementation approach) rather
 * than a product requirement, a question or chatter? Rules only. Agreement alone is not a decision,
 * but agreement plus a concrete approach is ("yes, and we'll cache it in Redis").
 */
export function decisionSignal(input: { text: string; analysis: SegmentAnalysis; evidence: CodeEvidence[] }): DecisionSignal | null {
  const { text, analysis, evidence } = input;
  if (onlyAgrees(analysis) || analysis.terms.length < 2) return null;
  const topics = technicalTopics(text);
  if (topics.length === 0) return null;
  const decisive = DECISIVE_RE.test(text);
  // "Should we cache it?" asks; "we should cache it" decides.
  if (markers(text).has('question') && !decisive) return null;
  if (!decisive && !proposesChange(text, analysis)) return null;

  const code = evidence.filter((e) => !e.isTest && e.reason.startsWith('matches'));
  let score = 0.35 + 0.15 * Math.min(topics.length, 2);
  if (decisive) score += 0.15;
  if (code.length > 0) score += 0.15;
  // "Let's not use Redis" turns an approach down rather than choosing one; "no, let's use Postgres instead" chooses.
  if (!decisive && (analysis.kinds.includes('disagreement') || analysis.polarity === 'negative')) score -= 0.2;
  return {
    score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)),
    topics: topics.map((t) => t.label),
    dimensions: [...new Set(topics.flatMap((t) => t.dimensions))],
    terms: analysis.terms,
    symbolIds: [...new Set(code.map((e) => e.symbolId))],
    decisive,
  };
}

/** A turn that turns the decision down ("no, let's not add Redis", "that won't work"). */
export function objectsTo(analysis: SegmentAnalysis): boolean {
  return analysis.kinds.includes('disagreement');
}

// ---------------------------------------------------------------- rule findings (free)

/** Verbs that change what existing code does or how it is reached. */
const CHANGE_VERB_RE = /\b(replac\w*|rewrit\w*|remov\w*|drop\w*|delet\w*|renam\w*|chang\w*|deprecat\w*|switch\w*|mov(e|ing)|migrat\w*|split\w*|refactor\w*|merg\w*|cach\w*|wrap\w*|swap\w*|rip(ping)? out)\b/i;

/**
 * Callers nobody mentioned: when a decision changes code that other code calls, those callers change
 * too. A fact from the index, not a prediction; severity reflects what the callers do (access, money,
 * irreversible actions) and how many there are.
 */
export function dependentsFinding(input: { discussion: Segment[]; focusSegmentIds: string[]; changed: CodeEvidence[]; callers: CodeEvidence[] }): RawDecisionFinding | null {
  const own = input.discussion.filter((s) => input.focusSegmentIds.includes(s.id));
  const text = own.map((s) => s.text).join(' ');
  if (!CHANGE_VERB_RE.test(text)) return null;
  // Only code the decision names ("replace getSession"), not code its topic merely matches ("cache entitlements").
  const ownWords = words(text).join(' ');
  const named = input.changed.filter((e) => ownWords.includes(splitIdentifier(e.symbolName).join(' ')) && splitIdentifier(e.symbolName).length > 1);
  if (named.length === 0) return null;
  const said = new Set(words(input.discussion.map((s) => s.text).join(' ')).map(stem));
  const mentioned = (e: CodeEvidence) =>
    splitIdentifier(e.symbolName).every((w) => said.has(stem(w))) || said.has(stem(e.filePath.split('/').at(-1)!.replace(/\.[a-z]+$/, '')));
  const changedNames = new Set(named.map((e) => e.symbolName));
  const unmentioned = input.callers.filter((c) => !mentioned(c) && !changedNames.has(c.symbolName));
  if (unmentioned.length === 0) return null;

  const target = named.find((e) => unmentioned.some((c) => callLine(c, e.symbolName) !== null)) ?? named[0]!;
  const callers = unmentioned.filter((c) => callLine(c, target.symbolName) !== null);
  if (callers.length === 0) return null;
  const weighty = callers.flatMap((c) => c.effects.map((eff) => ({ c, eff }))).sort((a, b) => CONSEQUENCE_WEIGHT[b.eff.category] - CONSEQUENCE_WEIGHT[a.eff.category])[0];
  const consequential = !!weighty && CONSEQUENCE_WEIGHT[weighty.eff.category] >= 0.9;
  const high = consequential || callers.length >= 3;
  const names = callers.slice(0, 3).map((c) => `${c.symbolName} (${c.filePath})`);
  return {
    kind: 'overlooked_dependency',
    dimension: 'compatibility',
    severity: high ? 'high' : 'medium',
    title: `${target.symbolName} is also used by ${callers.length === 1 ? callers[0]!.symbolName : `${callers.length} other functions`}`,
    impact: `Changing ${target.symbolName} changes ${names.join(', ')}${callers.length > 3 ? ' and more' : ''}, which nobody has mentioned${
      consequential ? `; ${weighty!.c.symbolName} ${describeEffect(weighty!.eff)}` : ''
    }.`,
    refs: [
      { evidenceId: target.id, startLine: target.startLine, endLine: target.startLine, note: `${target.symbolName} is being changed` },
      ...callers.slice(0, 3).map((c) => {
        const line = callLine(c, target.symbolName)!;
        return { evidenceId: c.id, startLine: line, endLine: line, note: `${c.symbolName} calls ${target.symbolName}` };
      }),
    ],
    slackRefs: [],
    alternative: null,
    ask: `Does changing ${target.symbolName} also work for ${callers[0]!.symbolName}${callers.length > 1 ? ` and the other ${callers.length - 1} caller${callers.length > 2 ? 's' : ''}` : ''}?`,
    // That callers exist is certain; that the change breaks them is not, so a single unremarkable caller is noted, not raised.
    confidence: high ? 0.9 : 0.75,
  };
}

/** The first line of `caller` that calls `name`, in file line numbers. */
function callLine(caller: CodeEvidence, name: string): number | null {
  const i = caller.snippet.split('\n').findIndex((l) => new RegExp(`\\b${name}\\s*\\(`).test(l));
  return i < 0 ? null : caller.startLine + i;
}

// ---------------------------------------------------------------- validation

export interface DecisionValidation {
  summary: string | null;
  verdict: string | null;
  findings: Omit<DecisionFinding, 'id' | 'visibility' | 'surfacedAtSegmentIndex' | 'feedback'>[];
  removed: { reason: string; detail: string }[];
}

const SEVERITY_RANK = { high: 2, medium: 1, low: 0 } as const;

/**
 * Hard gate between any analyzer and the user. A finding survives only when it is consequential
 * (high or medium severity, enough confidence) and rests on evidence the evaluation was shown: code or
 * documentation lines inside a cited symbol at the session's commit, or a Slack message in context. A
 * better alternative must name the alternative. What fails is dropped and recorded, never repaired.
 */
export function validateDecision(
  raw: RawDecisionEvaluation,
  ctx: { evidence: CodeEvidence[]; commitSha: string; slack: SlackContextItem[]; cfg: EngineConfig['decisions']; ruleFindings: RawDecisionFinding[] },
): DecisionValidation {
  const removed: DecisionValidation['removed'] = [];
  if (!raw.isDecision) {
    return { summary: truncate(raw.decision.trim(), 240) || null, verdict: truncate(raw.verdict?.trim() || 'Not a technical decision.', 240), findings: [], removed };
  }
  const out: DecisionValidation['findings'] = [];
  const all = [...ctx.ruleFindings.map((f) => ({ f, source: 'rules' as const })), ...raw.findings.map((f) => ({ f, source: 'model' as const }))];
  for (const { f, source } of all) {
    const label = truncate(f.title, 100);
    if (f.severity === 'low') {
      removed.push({ reason: 'minor', detail: label });
      continue;
    }
    if (!(f.confidence >= ctx.cfg.minConfidence)) {
      removed.push({ reason: 'low_confidence', detail: `${label} (${f.confidence})` });
      continue;
    }
    const refs = checkCodeRefs(f.refs, ctx.evidence, ctx.commitSha, label, removed).valid;
    const slackRefs = checkSlackRefs(f.slackRefs, ctx.slack, removed);
    if (refs.length === 0 && slackRefs.length === 0) {
      removed.push({ reason: 'speculative', detail: `${label}: no code, documentation or Slack evidence` });
      continue;
    }
    if (f.kind === 'better_alternative' && !f.alternative?.trim()) {
      removed.push({ reason: 'no_alternative', detail: label });
      continue;
    }
    const lead = refs[0] ? (isDocPath(refs[0].filePath) ? refs[0].filePath : refs[0].symbolName) : slackRefs[0]!.id;
    const key = `${f.dimension}:${f.kind}:${lead}`;
    if (out.some((x) => x.key === key)) {
      removed.push({ reason: 'duplicate', detail: label });
      continue;
    }
    out.push({
      key,
      kind: f.kind,
      dimension: f.dimension,
      severity: f.severity,
      title: truncate(f.title.trim(), 140),
      impact: truncate(f.impact.trim(), 320),
      refs,
      slackRefs,
      alternative: f.alternative?.trim() ? truncate(f.alternative.trim(), 240) : null,
      ask: f.ask?.trim() ? truncate(f.ask.trim(), 200) : null,
      confidence: Math.round(f.confidence * 100) / 100,
      source,
    });
  }
  out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence);
  const findings = out.slice(0, 3);
  for (const f of out.slice(3)) removed.push({ reason: 'over_limit', detail: f.title });
  return {
    summary: truncate(raw.decision.trim(), 240) || null,
    verdict: findings.length === 0 ? truncate(raw.verdict?.trim() || 'No consequential issues found.', 240) : null,
    findings,
    removed,
  };
}

// ---------------------------------------------------------------- live policy

/** Open live suggestion cards of either kind: they share the panel's room. */
export function openLiveFindings(state: SessionState): number {
  return (state.decisions ?? []).flatMap((d) => d.findings).filter((f) => f.visibility === 'live' && f.feedback == null).length;
}

/**
 * Which finding (at most one per decision) interrupts the meeting: high severity, or medium with high
 * confidence and code or documentation behind it; none while the decision is being argued again, when
 * the meeting's live budget is spent, or when a live concern already cites the same code.
 */
export function pickLiveFinding(d: TechnicalDecision, state: SessionState, cfg: EngineConfig['decisions'], openLiveOthers: number, maxOpenLive: number): DecisionFinding | null {
  if (d.status !== 'evaluated') return null;
  const everLive = (state.decisions ?? []).flatMap((x) => x.findings).filter((f) => f.surfacedAtSegmentIndex !== null).length;
  if (everLive >= cfg.maxLivePerSession || openLiveOthers + openLiveFindings(state) >= maxOpenLive) return null;
  const liveConcernRefs = new Set(state.discrepancies.filter((x) => x.visibility === 'live' && !['resolved', 'dismissed', 'unresolved'].includes(x.status)).flatMap((x) => x.codeRefs.map((r) => `${r.evidenceId}:${r.startLine}`)));
  return (
    d.findings.find(
      (f) =>
        f.visibility === 'noted' &&
        (f.severity === 'high' ? f.confidence >= cfg.minConfidence : f.confidence >= cfg.liveConfidence && f.refs.length > 0) &&
        !f.refs.some((r) => liveConcernRefs.has(`${r.evidenceId}:${r.startLine}`)),
    ) ?? null
  );
}
