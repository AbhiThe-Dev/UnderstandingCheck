import type { AnalysisContext, SegmentAnalysis } from './ports';
import type { ClaimKind, CodeEvidence, Focus, Participant, SessionState } from './types';
import {
  contentTerms,
  identifierTerms,
  isBareAgreement,
  isNegated,
  leadingYesNo,
  markers,
  purposePhrase,
  reuseTarget,
  reversalWord,
  stem,
  words,
} from './text';

/**
 * Module 1 (cheap path) — classify one transcript segment without a model call.
 * Used directly by the heuristic analyzer and as the gate in front of LLM analysis.
 */
export function analyzeSegmentHeuristic(ctx: AnalysisContext): SegmentAnalysis {
  const text = ctx.segment.text;
  const m = markers(text);
  const kinds: ClaimKind[] = [];
  const bare = isBareAgreement(text);
  if (m.has('agreement') && !m.has('disagreement')) kinds.push('agreement');
  if (m.has('disagreement')) kinds.push('disagreement');
  if (m.has('proposal') && (m.has('implementation') || m.has('reuse'))) kinds.push('proposal');
  else if (m.has('reuse')) kinds.push('proposal');
  if (m.has('requirement') && !m.has('question')) kinds.push('requirement');
  if (m.has('question')) kinds.push('question');
  if (m.has('correction')) kinds.push('correction');
  if (kinds.length === 0) kinds.push('statement');

  // Polarity about the topic, ignoring a leading yes/no answer token.
  const body = text.replace(/^\s*(yes|yeah|no|nope|ok|okay)\b[,.!]?\s*/i, '');
  let polarity: SegmentAnalysis['polarity'] = 'neutral';
  if (kinds.includes('disagreement') || ((kinds.includes('requirement') || kinds.includes('proposal')) && isNegated(body))) {
    polarity = 'negative';
  } else if (kinds.includes('requirement') || kinds.includes('proposal')) {
    polarity = 'positive';
  }

  const terms = contentTerms(text);
  const meaningful =
    kinds.some((k) => ['requirement', 'proposal', 'agreement', 'disagreement', 'correction'].includes(k)) ||
    m.has('reversal') ||
    m.has('reuse') ||
    leadingYesNo(text) !== null ||
    (kinds.includes('question') && terms.length > 0);

  const target = m.has('reuse') ? reuseTarget(text) : null;
  return {
    kinds,
    polarity,
    terms,
    words: words(text),
    reversalWord: m.has('reversal') ? reversalWord(text) : null,
    reuseTarget: target,
    purpose: target ? purposePhrase(target) : null,
    meaningful,
    bareAgreement: bare,
  };
}

const ACTOR_RE =
  /\b(admins?|administrators?|support agents?|agents?|managers?|reviewers?|moderators?|operators?|staff|finance team|support)\b/i;

const ACTOR_PHRASE: Record<string, string> = {
  admin: 'an administrator',
  administrator: 'an administrator',
  'support agent': 'a support agent',
  agent: 'a support agent',
  support: 'a support agent',
  manager: 'a manager',
  reviewer: 'a reviewer',
  moderator: 'a moderator',
  operator: 'an operator',
  staff: 'a staff member',
  'finance team': 'someone on the finance team',
};

export function detectActor(text: string): string | null {
  const m = text.match(ACTOR_RE);
  if (!m) return null;
  const key = m[1]!.toLowerCase().replace(/s$/, '');
  return ACTOR_PHRASE[key] ?? null;
}

/**
 * Track which existing operation the discussion is about. A function becomes the focus when a
 * requirement/proposal names it (by stem) and it has side effects worth reasoning about.
 */
export function updateFocus(
  state: SessionState,
  text: string,
  analysis: SegmentAnalysis,
  evidence: CodeEvidence[],
  participantId: string | null,
  segmentId: string | null,
): Focus | null {
  const triggers =
    analysis.reversalWord !== null ||
    analysis.kinds.includes('requirement') ||
    (analysis.kinds.includes('proposal') && state.focus === null);
  if (!triggers) return state.focus;
  // Implementation proposals name helper functions ("revoke their access"); they refine the current
  // operation rather than change the subject. Only a new requirement moves an existing focus.
  if (state.focus && !analysis.kinds.includes('requirement')) return state.focus;

  // With a reversal ("undo an approval"), the operation is the thing being reversed, not other verbs in the sentence.
  const reversalObject = analysis.reversalWord ? wordsAfter(text, analysis.reversalWord, 4) : null;
  const termSet = new Set(reversalObject ?? analysis.terms);
  let best: { ev: CodeEvidence; overlap: string[] } | null = null;
  for (const ev of evidence) {
    if (ev.isTest || ev.effects.length === 0 || !ev.reason.startsWith('matches')) continue;
    const overlap = identifierTerms(ev.symbolName).filter((t) => termSet.has(t));
    if (overlap.length === 0) continue;
    if (!best || overlap.length > best.overlap.length) best = { ev, overlap };
  }
  if (!best) return state.focus;

  const reversal = analysis.reversalWord !== null;
  // Keep an existing reversal focus unless the new mention is also a reversal of something else.
  if (state.focus && state.focus.symbolId === best.ev.symbolId) {
    return {
      ...state.focus,
      reversal: state.focus.reversal || reversal,
      reversalWord: state.focus.reversalWord ?? analysis.reversalWord,
      actor: state.focus.actor ?? detectActor(text),
    };
  }
  if (state.focus?.reversal && !reversal) return state.focus;

  const overlapSet = new Set(best.overlap);
  const operationWords = analysis.words.filter((w) => overlapSet.has(stem(w)));
  return {
    symbolId: best.ev.symbolId,
    evidenceId: best.ev.id,
    symbolName: best.ev.symbolName,
    reversal,
    operationWords: [...new Set(operationWords)],
    reversalWord: analysis.reversalWord,
    actor: detectActor(text),
    introducedBy: participantId,
    segmentId,
  };
}

function wordsAfter(text: string, marker: string, n: number): string[] {
  const ws = words(text);
  const i = ws.findIndex((w) => w === marker.split(' ')[0]);
  if (i < 0) return [];
  return ws
    .slice(i + marker.split(' ').length, i + marker.split(' ').length + n)
    .map((w) => stem(w))
    .filter((t) => t.length >= 3);
}

/** The participant who owns the requirement: a product owner if present, else whoever introduced the focus. */
export function requirementOwner(state: SessionState): Participant | null {
  const real = state.participants.filter((p) => !p.id.startsWith('prior:') && !p.ambiguous);
  const po = real.find((p) => p.role === 'product_owner');
  if (po) return po;
  if (state.focus?.introducedBy) return real.find((p) => p.id === state.focus!.introducedBy) ?? null;
  const firstReq = state.claims.find((c) => c.kinds.includes('requirement') && !c.ambiguousSpeaker);
  return firstReq ? (real.find((p) => p.id === firstReq.participantId) ?? null) : null;
}
