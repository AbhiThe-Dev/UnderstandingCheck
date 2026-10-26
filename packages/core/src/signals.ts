import { CONSEQUENCE_WEIGHT, effectKeywords } from './lexicon';
import type { Claim, Effect, SessionState } from './types';

/**
 * Deterministic signals shared by the rule-based analyzer and the fact sheet the model reads:
 * what was said about which side effect, and which way a statement leans.
 */

export const HIGH_CONSEQUENCE = new Set(['permission', 'financial', 'irreversible', 'external']);

/** How many claims back an agreement can refer to a proposal. */
export const AGREEMENT_LOOKBACK = 3;

export function claimsSince(state: SessionState, segmentId: string | null): Claim[] {
  if (!segmentId) return state.claims;
  const idx = state.claims.findIndex((c) => c.segmentId === segmentId);
  return idx < 0 ? state.claims : state.claims.slice(idx);
}

export function isAddressed(effect: Effect, claims: Claim[], exclude: string[] = []): boolean {
  const kw = new Set(effectKeywords(effect, exclude));
  return claims.some((c) => !c.kinds.includes('question') && c.terms.some((t) => kw.has(t)));
}

export function mentions(effect: Effect, claim: Claim, exclude: string[] = []): boolean {
  const kw = new Set(effectKeywords(effect, exclude));
  return claim.terms.some((t) => kw.has(t));
}

/** Verbs that take something away. A statement using them argues *against* the thing it names. */
const REMOVAL_RE = /\b(lose|loses|revoke|revokes|revoked|remove|removes|removed|disable|disables|disabled|block|blocks|blocked|prevent|prevents|skip|skips|exclude|excludes|drop|drops)\b/i;

/** Stance toward the topic: removal verbs ("lose access", "skip the email") argue against it. */
export function stance(c: Pick<Claim, 'polarity' | 'text'>): Claim['polarity'] {
  if (c.polarity !== 'positive') return c.polarity;
  return REMOVAL_RE.test(c.text) ? 'negative' : 'positive';
}

export function rankEffects(effects: Effect[]): Effect[] {
  return [...effects].sort(
    (a, b) =>
      CONSEQUENCE_WEIGHT[b.category] - CONSEQUENCE_WEIGHT[a.category] ||
      Number(Boolean(b.condition)) - Number(Boolean(a.condition)) ||
      a.line - b.line,
  );
}
