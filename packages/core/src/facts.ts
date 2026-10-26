import type { SlackContextItem } from './ports';
import { AGREEMENT_LOOKBACK, HIGH_CONSEQUENCE, mentions, rankEffects, stance } from './signals';
import { effectKeywords } from './lexicon';
import { truncate } from './text';
import type { Claim, CodeEvidence, Effect, EffectCategory, Segment, SessionState } from './types';

/**
 * Facts computed by ordinary code for the model to interpret, each with its receipt (the code line,
 * the words searched for, the turns that matched). The model is told they are machine-extracted and
 * may be wrong; it checks them against the transcript and code it also sees, and can dispute them.
 */
export interface EffectFact {
  id: string;
  evidenceId: string;
  symbolName: string;
  filePath: string;
  line: number;
  code: string;
  category: EffectCategory;
  inFocus: boolean;
  /** Word stems searched for in the recent turns. */
  searchedFor: string[];
  matchingTurns: { segmentId: string; speaker: string }[];
}

export interface AgreementFact {
  id: string;
  segmentId: string;
  speaker: string;
  /** The nearest earlier proposal or requirement by someone else, if any. */
  agreedTo: { segmentId: string; speaker: string } | null;
  /** Effect facts the agreed proposal mentions. */
  touches: string[];
}

export interface StatementFact {
  id: string;
  segmentId: string;
  speaker: string;
  kind: 'proposal' | 'requirement' | 'disagreement';
  stance: Claim['polarity'];
}

export interface PriorFact {
  id: string;
  participantId: string;
  source: string;
  stance: Claim['polarity'];
  /** Recent turns that share terms with it and lean the other way. */
  opposedBy: string[];
}

export interface FactSheet {
  focus: { symbolName: string; evidenceId: string; reversal: boolean } | null;
  effects: EffectFact[];
  agreements: AgreementFact[];
  statements: StatementFact[];
  priors: PriorFact[];
  raised: { key: string; title: string }[];
}

const MAX_EFFECTS_PER_FUNCTION = 6;
const MAX_OTHER_FUNCTIONS = 2;

export function buildFactSheet(input: {
  state: SessionState;
  segments: Segment[];
  evidence: CodeEvidence[];
  slack?: SlackContextItem[];
  recentWindow: number;
}): FactSheet {
  const { state, evidence, slack = [] } = input;
  const name = (id: string) => state.participants.find((p) => p.id === id)?.displayName ?? id;
  const recentIds = new Set(input.segments.slice(-input.recentWindow).map((s) => s.id));
  const recent = state.claims.filter((c) => recentIds.has(c.segmentId) && !c.participantId.startsWith('prior:'));

  // Effects: the function in focus first, then a couple of other retrieved functions that do something consequential.
  const focusEv = state.focus ? state.evidence.find((e) => e.id === state.focus!.evidenceId) : undefined;
  const others = evidence.filter((e) => e.id !== focusEv?.id && !e.isTest && e.effects.some((x) => HIGH_CONSEQUENCE.has(x.category))).slice(0, MAX_OTHER_FUNCTIONS);
  const effects: EffectFact[] = [];
  const effectOf = new Map<string, Effect>();
  for (const ev of [...(focusEv ? [focusEv] : []), ...others]) {
    for (const e of rankEffects(ev.effects).slice(0, MAX_EFFECTS_PER_FUNCTION)) {
      const id = `F${effects.length + 1}`;
      effectOf.set(id, e);
      effects.push({
        id,
        evidenceId: ev.id,
        symbolName: ev.symbolName,
        filePath: ev.filePath,
        line: e.line,
        code: truncate(e.text.trim(), 160),
        category: e.category,
        inFocus: ev.id === focusEv?.id,
        searchedFor: effectKeywords(e),
        matchingTurns: recent.filter((c) => !c.kinds.includes('question') && mentions(e, c)).map((c) => ({ segmentId: c.segmentId, speaker: name(c.participantId) })),
      });
    }
  }

  const agreements: AgreementFact[] = [];
  recent.forEach((c, i) => {
    if (!c.kinds.includes('agreement')) return;
    const target = recent
      .slice(Math.max(0, i - AGREEMENT_LOOKBACK), i)
      .reverse()
      .find((p) => p.participantId !== c.participantId && (p.kinds.includes('proposal') || p.kinds.includes('requirement')));
    agreements.push({
      id: `A${agreements.length + 1}`,
      segmentId: c.segmentId,
      speaker: name(c.participantId) + (c.ambiguousSpeaker ? ' (speaker uncertain)' : ''),
      agreedTo: target ? { segmentId: target.segmentId, speaker: name(target.participantId) } : null,
      touches: target ? effects.filter((f) => mentions(effectOf.get(f.id)!, target)).map((f) => f.id) : [],
    });
  });

  const statements: StatementFact[] = recent.flatMap((c) => {
    const kind = c.kinds.includes('disagreement') ? 'disagreement' : c.kinds.includes('proposal') ? 'proposal' : c.kinds.includes('requirement') ? 'requirement' : null;
    return kind ? [{ id: '', segmentId: c.segmentId, speaker: name(c.participantId), kind, stance: stance(c) } as StatementFact] : [];
  });
  statements.forEach((s, i) => (s.id = `P${i + 1}`));

  // Earlier decisions (requirement records, prior decisions, Slack) that recent turns share terms with but lean against.
  const priorClaims = [...state.claims.filter((c) => c.participantId.startsWith('prior:')), ...slack.map((s) => s.claim)];
  const priors: PriorFact[] = [];
  for (const p of priorClaims) {
    const ps = stance(p);
    const opposedBy = recent.filter((c) => {
      const cs = stance(c);
      return ps !== 'neutral' && cs !== 'neutral' && cs !== ps && c.terms.some((t) => p.terms.includes(t));
    });
    if (opposedBy.length === 0) continue;
    priors.push({ id: `D${priors.length + 1}`, participantId: p.participantId, source: name(p.participantId), stance: ps, opposedBy: opposedBy.map((c) => c.segmentId) });
  }

  return {
    focus: focusEv && state.focus ? { symbolName: focusEv.symbolName, evidenceId: focusEv.id, reversal: state.focus.reversal } : null,
    effects,
    agreements,
    statements,
    priors,
    raised: state.discrepancies.filter((d) => d.status !== 'dismissed').map((d) => ({ key: d.key, title: d.title })),
  };
}

/** The fact sheet as the model sees it: every fact with its id and how it was derived. */
export function renderFactSheet(sheet: FactSheet): string {
  const lines: string[] = [];
  lines.push(sheet.focus ? `Code in focus: ${sheet.focus.symbolName}${sheet.focus.reversal ? ' (being undone or reversed)' : ''}` : 'Code in focus: none');
  if (sheet.effects.length) {
    lines.push('Side effects in the code (with whether recent turns mention them):');
    for (const f of sheet.effects) {
      const who = f.matchingTurns.length ? f.matchingTurns.map((m) => `${m.segmentId} (${m.speaker})`).join(', ') : 'none';
      lines.push(`${f.id} ${f.filePath}:${f.line} ${f.symbolName}${f.inFocus ? '' : ' (related)'} [${f.category}]  ${f.code}`);
      lines.push(`   searched recent turns for word stems: ${f.searchedFor.join(', ') || '(none)'} → matching turns: ${who}`);
    }
  }
  if (sheet.statements.length) {
    lines.push('Proposals, requirements and disagreements in recent turns:');
    for (const s of sheet.statements) lines.push(`${s.id} ${s.segmentId} ${s.speaker}: ${s.kind}, leaning ${s.stance}`);
  }
  if (sheet.agreements.length) {
    lines.push('Agreements in recent turns (matched to the nearest earlier proposal by someone else):');
    for (const a of sheet.agreements) {
      lines.push(
        `${a.id} ${a.segmentId} ${a.speaker} agreed${a.agreedTo ? ` to ${a.agreedTo.segmentId} (${a.agreedTo.speaker})` : ' (no proposal found in the last few turns)'}` +
          (a.agreedTo ? `; that proposal mentions effects: ${a.touches.join(', ') || 'none'}` : ''),
      );
    }
  }
  if (sheet.priors.length) {
    lines.push('Earlier decisions that recent turns share terms with but lean against:');
    for (const p of sheet.priors) lines.push(`${p.id} ${p.source} (participantId ${p.participantId}), leaning ${p.stance}; opposed by ${p.opposedBy.join(', ')}`);
  }
  lines.push(`Already raised (do not raise again): ${sheet.raised.map((r) => `key=${r.key} "${r.title}"`).join('; ') || 'none'}`);
  return lines.join('\n');
}
