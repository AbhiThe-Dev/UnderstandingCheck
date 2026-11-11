import type { EngineConfig } from './config';
import { CONSEQUENCE_WEIGHT } from './lexicon';
import type { Discrepancy, SessionState } from './types';
import { openLiveFindings } from './decisions';

const TERMINAL = new Set(['resolved', 'dismissed', 'unresolved', 'confirmed']);
const IDENTITY_DEPENDENT = new Set<Discrepancy['category']>(['false_alignment', 'direct_disagreement']);

export interface ScoreBreakdown {
  consequence: number;
  codeEvidence: number;
  conversationEvidence: number;
  divergence: number;
  relevance: number;
  multiplier: number;
  score: number;
}

/** Module 5 — configurable scoring of how worthwhile it is to interrupt for this candidate. */
export function scoreDiscrepancy(
  d: Discrepancy,
  state: SessionState,
  currentSegmentIndex: number,
  cfg: EngineConfig['scoring'],
  recentWindow: number,
): ScoreBreakdown {
  const w = cfg.weights;
  const consequence = CONSEQUENCE_WEIGHT[d.impact.consequence];
  const codeEvidence = d.codeRefs.length === 0 ? 0 : d.codeRefs.some((r) => r.startLine === r.endLine) ? 1 : 0.6;
  const conversationEvidence = Math.min(1, d.statements.length * 0.5);
  const divergence = d.interpretations.length >= 2 ? 1 : 0;
  // lastLinkedSegmentIndex starts at the creation segment and advances when the topic comes back.
  const relevance = currentSegmentIndex - d.lastLinkedSegmentIndex <= recentWindow ? 1 : 0.5;

  // Only suggestions about who said what depend on knowing the speaker. A gap in the spec or a conflict
  // with the code is just as true whoever raised it.
  const ambiguous =
    IDENTITY_DEPENDENT.has(d.category) &&
    d.statements.some((q) => state.participants.find((p) => p.id === q.participantId)?.ambiguous);
  const base =
    (w.consequence * consequence +
      w.codeEvidence * codeEvidence +
      w.conversationEvidence * conversationEvidence +
      w.divergence * divergence +
      w.relevance * relevance) /
    (w.consequence + w.codeEvidence + w.conversationEvidence + w.divergence + w.relevance);
  const multiplier =
    cfg.categoryMultiplier[d.category] * (0.5 + 0.5 * d.confidence) * (ambiguous ? cfg.ambiguousSpeakerPenalty : 1);
  const score = TERMINAL.has(d.status) ? 0 : base * multiplier;
  return { consequence, codeEvidence, conversationEvidence, divergence, relevance, multiplier, score: round(score) };
}

export function decide(score: number, cfg: EngineConfig['scoring'], windowElapsed: boolean): Discrepancy['decision'] {
  if (score < cfg.suppressThreshold) return 'suppress';
  if (score >= cfg.liveThreshold && windowElapsed) return 'surface';
  return 'defer';
}

/** True when the side panel has room for another live suggestion. */
export function hasLiveCapacity(state: SessionState, cfg: EngineConfig['rateLimit']): boolean {
  const everLive = state.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null).length;
  // Decision findings shown live take the same room in the panel.
  const openLive = state.discrepancies.filter((d) => d.visibility === 'live' && !TERMINAL.has(d.status)).length + openLiveFindings(state);
  return everLive < cfg.maxLivePerSession && openLive < cfg.maxOpenLive;
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
