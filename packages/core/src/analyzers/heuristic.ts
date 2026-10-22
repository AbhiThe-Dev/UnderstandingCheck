import type {
  AnalysisContext,
  Analyzer,
  CandidateInput,
  ClarificationDraft,
  ClarificationPurpose,
  RawCandidate,
  ResponseInterpretation,
  SegmentAnalysis,
} from '../ports';
import type { Claim, Clarification, Discrepancy, Effect, Interpretation, Position, SessionState } from '../types';
import {
  CONSEQUENCE_WEIGHT,
  beneficiaryOf,
  describeEffect,
  effectKeywords,
  effectObject,
  humanizeCallee,
  humanizeCondition,
} from '../lexicon';
import {
  article,
  capitalize,
  contentTerms,
  identifierTerms,
  isNegated,
  leadingYesNo,
  pastTense,
  reversalGerund,
  reversalParticiple,
  reversalPresent,
  stem,
  thirdPerson,
  truncate,
  words,
} from '../text';
import { analyzeSegmentHeuristic, requirementOwner } from '../understanding';

const HIGH_CONSEQUENCE = new Set(['permission', 'financial', 'irreversible', 'external']);

const KEEP_WORDS = ['keep', 'keeps', 'still', 'retain', 'remain', 'stay', 'continue', 'leave', 'unchanged', 'untouched', 'grace', 'only', 'just', 'same', 'as-is'];
// Deliberately excludes words like "end", "also", "take" that show up in unrelated phrasing ("end of the day").
const REVERSE_WORDS = ['revoke', 'remove', 'lose', 'loses', 'terminate', 'cancel', 'reverse', 'claw', 'undo', 'kick', 'logout', 'anymore', 'longer', 'block', 'immediately'];
const NOTIFY_WORDS = ['notify', 'tell', 'email', 'inform', 'message', 'send', 'told', 'notified', 'informed'];
const EXCLUDE_WORDS = ['exclude', 'without', 'separate', 'skip', 'never', 'different', 'shouldn'];

/** How many claims back an agreement can refer to a proposal. */
const AGREEMENT_LOOKBACK = 3;

const stems = (ws: string[]) => [...new Set(ws.map((w) => stem(w)))];

function quoteOf(text: string): string {
  return truncate(text.trim(), 220);
}

function claimsSince(state: SessionState, segmentId: string | null): Claim[] {
  if (!segmentId) return state.claims;
  const idx = state.claims.findIndex((c) => c.segmentId === segmentId);
  return idx < 0 ? state.claims : state.claims.slice(idx);
}

function isAddressed(effect: Effect, claims: Claim[], exclude: string[] = []): boolean {
  const kw = new Set(effectKeywords(effect, exclude));
  return claims.some((c) => !c.kinds.includes('question') && c.terms.some((t) => kw.has(t)));
}

function mentions(effect: Effect, claim: Claim, exclude: string[] = []): boolean {
  const kw = new Set(effectKeywords(effect, exclude));
  return claim.terms.some((t) => kw.has(t));
}

/** Verbs that take something away. A statement using them argues *against* the thing it names. */
const REMOVAL_RE = /\b(lose|loses|revoke|revokes|revoked|remove|removes|removed|disable|disables|disabled|block|blocks|blocked|prevent|prevents|skip|skips|exclude|excludes|drop|drops)\b/i;

/** Stance toward the topic: removal verbs ("lose access", "skip the email") argue against it. */
function stance(c: Pick<Claim, 'polarity' | 'text'>): Claim['polarity'] {
  if (c.polarity !== 'positive') return c.polarity;
  return REMOVAL_RE.test(c.text) ? 'negative' : 'positive';
}

/** Words that name the act of reversing, which two statements can share without being about the same thing. */
const REVERSAL_STEMS = new Set(['undo', 'revert', 'revers', 'cancel', 'rollback', 'roll', 'back', 'retract', 'rescind'].map((w) => stem(w)));

function rankEffects(effects: Effect[]): Effect[] {
  return [...effects].sort(
    (a, b) =>
      CONSEQUENCE_WEIGHT[b.category] - CONSEQUENCE_WEIGHT[a.category] ||
      Number(Boolean(b.condition)) - Number(Boolean(a.condition)) ||
      a.line - b.line,
  );
}

function reverseVerb(category: Effect['category']): { verb: string; participle: string } {
  switch (category) {
    case 'permission':
      return { verb: 'revoke', participle: 'revoked' };
    case 'financial':
      return { verb: 'reverse', participle: 'reversed' };
    case 'external':
      return { verb: 'follow up on', participle: 'followed up on' };
    default:
      return { verb: 'undo', participle: 'undone' };
  }
}

/** Nouns the conversation used for the operation ("approval"), falling back to the function's verb. */
function operationNoun(meta: Record<string, string>): string {
  return meta.operationWord || `${meta.verb ?? 'change'}`;
}

function baseVerbPhrase(effect: Effect): string {
  if (effect.kind === 'assign') return `set ${effectObject(effect)}`;
  const { verb, object } = humanizeCallee(effect.target);
  return verb ? `${verb} ${object}` : `call ${effect.target}`;
}

function participantName(state: SessionState, id: string): string {
  return state.participants.find((p) => p.id === id)?.displayName ?? 'Someone';
}

// ---------------------------------------------------------------------------------------------

export class HeuristicAnalyzer implements Analyzer {
  readonly name = 'heuristic-v1';

  async analyzeSegment(ctx: AnalysisContext): Promise<SegmentAnalysis> {
    return analyzeSegmentHeuristic(ctx);
  }

  async generateCandidates(input: CandidateInput): Promise<RawCandidate[]> {
    const out: RawCandidate[] = [];
    const dis = this.directDisagreement(input);
    if (dis) out.push(dis);
    const gap = this.effectGap(input);
    if (gap) out.push(gap);
    const reuse = this.hiddenAssumption(input);
    if (reuse) out.push(reuse);
    return out;
  }

  // ---- Rule: direct disagreement (incl. conflicts with prior decisions) ----
  private directDisagreement({ ctx, claim, evidence }: CandidateInput): RawCandidate | null {
    const claimStance = stance(claim);
    if (claim.ambiguousSpeaker || claimStance === 'neutral' || claim.kinds.includes('question')) return null;
    if (claim.kinds.includes('agreement') && !claim.kinds.includes('disagreement')) return null;
    const state = ctx.state;
    // Topics already tracked by another concern are followed by the resolution tracker instead.
    const tracked = new Set([
      ...state.discrepancies
        .filter((d) => d.status !== 'dismissed' && d.meta.kind !== 'disagreement')
        .flatMap((d) => (d.meta.linkTerms ?? '').split(' ').filter(Boolean)),
      ...REVERSAL_STEMS,
      ...(state.focus ? identifierTerms(state.focus.symbolName) : []),
    ]);
    const prior = state.claims
      .filter((c) => c.id !== claim.id && c.participantId !== claim.participantId && !c.ambiguousSpeaker)
      .slice(-8)
      .reverse();
    const priorDecisions = state.claims.filter((c) => c.participantId.startsWith('prior:'));
    for (const other of [...prior, ...priorDecisions]) {
      const otherStance = stance(other);
      if (otherStance === 'neutral' || otherStance === claimStance) continue;
      if (!other.kinds.some((k) => k === 'requirement' || k === 'proposal' || k === 'disagreement')) continue;
      const overlap = claim.terms.filter((t) => other.terms.includes(t) && !tracked.has(t));
      if (overlap.length === 0) continue;

      const positive = claimStance === 'positive' ? claim : other;
      const negative = claimStance === 'positive' ? other : claim;
      const topicWord =
        words(claim.text).find((w) => overlap.includes(stem(w))) ?? words(other.text).find((w) => overlap.includes(stem(w))) ?? overlap[0]!;
      const topicStems = new Set(overlap);
      const relatedEffect = evidence
        .flatMap((ev) => ev.effects.map((e) => ({ ev, e })))
        .find(({ e }) => effectKeywords(e).some((k) => topicStems.has(k)));

      const isPrior = other.participantId.startsWith('prior:');
      const owner = requirementOwner(state);
      // A conflict with history must be settled by the people in the room, not by the earlier record.
      const speakers = state.participants.filter((p) => !p.id.startsWith('prior:') && !p.ambiguous).map((p) => p.id);
      const relevant = isPrior
        ? [other.participantId, claim.participantId, ...(owner ? [owner.id] : []), ...speakers]
        : [claim.participantId, other.participantId];
      const positions: Position[] = [
        { participantId: positive.participantId, interpretationId: 'A', provenance: 'explicit', segmentId: positive.segmentId, text: positive.text },
        { participantId: negative.participantId, interpretationId: 'B', provenance: 'explicit', segmentId: negative.segmentId, text: negative.text },
      ];
      const interpretations: Interpretation[] = [
        { id: 'A', label: `Include the ${topicWord}`, behavior: quoteOf(positive.text), keywords: [] },
        { id: 'B', label: `No ${topicWord}`, behavior: quoteOf(negative.text), keywords: [] },
      ];
      return {
        key: `disagree:${[...overlap].sort().join('+')}`,
        category: 'direct_disagreement',
        title: isPrior ? `Conflicts with an earlier decision about the ${topicWord}` : `Different positions on the ${topicWord}`,
        description: isPrior
          ? `${participantName(state, claim.participantId)}'s statement conflicts with an earlier decision (${participantName(state, other.participantId)}).`
          : `${participantName(state, positive.participantId)} and ${participantName(state, negative.participantId)} described incompatible behavior for the ${topicWord}.`,
        quotes: [other, claim]
          .filter((c) => !c.participantId.startsWith('prior:'))
          .map((c) => ({ segmentId: c.segmentId, quote: quoteOf(c.text) })),
        codeRefs: relatedEffect
          ? [
              {
                evidenceId: relatedEffect.ev.id,
                startLine: relatedEffect.e.line,
                endLine: relatedEffect.e.line,
                note: `Current code: ${relatedEffect.ev.symbolName} ${describeEffect(relatedEffect.e)}.`,
              },
            ]
          : [],
        interpretations,
        consequence: relatedEffect ? relatedEffect.e.category : 'business_rule',
        impactExplanation: 'Both behaviors cannot be implemented at once; the implementation will match only one participant.',
        confidence: 0.9,
        relevantParticipantIds: [...new Set(relevant)],
        positions,
        meta: { kind: 'disagreement', topic: topicWord, topicTerms: overlap.join(' ') },
      };
    }
    return null;
  }

  // ---- Rule: effect gap — reversing/changing an operation whose code has more side effects than discussed ----
  private effectGap({ ctx, claim, analysis }: CandidateInput): RawCandidate | null {
    const state = ctx.state;
    const focus = state.focus;
    if (!focus || !focus.reversal) return null;
    const fn = state.evidence.find((e) => e.id === focus.evidenceId);
    if (!fn) return null;

    // Earlier records do not count as this meeting having addressed an effect: a proposal can still
    // contradict them. They are cited in the suggestion instead.
    const discussed = claimsSince(state, focus.segmentId).filter((c) => !c.participantId.startsWith('prior:'));
    const fnTerms = identifierTerms(fn.symbolName);
    const gaps = rankEffects(fn.effects.filter((e) => HIGH_CONSEQUENCE.has(e.category) && !isAddressed(e, discussed, fnTerms)));
    const top = gaps[0];
    if (!top) return null;

    // Which participant proposed an implementation, and did it touch any effect of the operation?
    const isProposal = claim.kinds.includes('proposal') && !claim.ambiguousSpeaker;
    const recentProposal = [...state.claims]
      .slice(-(AGREEMENT_LOOKBACK + 1))
      .reverse()
      .find((c) => c.id !== claim.id && c.kinds.includes('proposal') && !c.ambiguousSpeaker);
    const proposal = isProposal ? claim : recentProposal ?? null;
    const proposalEffects = proposal ? fn.effects.filter((e) => mentions(e, proposal, fnTerms)) : [];
    const concrete = proposal !== null && (proposalEffects.length > 0 || /\bback to\b/i.test(proposal.text));

    let category: RawCandidate['category'];
    let agreer: string | null = null;
    if (
      analysis.kinds.includes('agreement') &&
      !claim.ambiguousSpeaker &&
      proposal &&
      proposal.id !== claim.id &&
      proposal.participantId !== claim.participantId &&
      concrete
    ) {
      category = 'false_alignment';
      agreer = claim.participantId;
    } else if (isProposal && concrete) {
      category = 'codebase_conflict';
    } else if (claim.kinds.includes('requirement') || claim.kinds.includes('proposal') || claim.segmentId === focus.segmentId) {
      category = 'missing_specification';
    } else {
      return null;
    }

    const { verb, object } = humanizeCallee(fn.symbolName);
    const effectObj = effectObject(top);
    const beneficiary = beneficiaryOf(top) ?? 'user';
    const singular = focus.operationWords.map((w) => (/(als|ions|ments|ances)$/.test(w) ? w.slice(0, -1) : w));
    const opWord =
      singular.find((w) => /(al|ion|ment|ance)$/.test(w)) ??
      singular.find((w) => verb !== null && w === verb) ??
      verb ??
      focus.operationWords[0] ??
      'change';
    const mentionedDesc = proposalEffects.length
      ? [...new Set(proposalEffects.map((e) => `the ${effectObject(e)}`))].join(' and ')
      : proposal
        ? 'what was proposed'
        : 'the main status change';
    const rv = reverseVerb(top.category);
    const owner = requirementOwner(state);

    const relevant = new Set<string>();
    if (proposal) relevant.add(proposal.participantId);
    if (agreer) relevant.add(agreer);
    if (owner) relevant.add(owner.id);
    if (relevant.size < 2 && focus.introducedBy) relevant.add(focus.introducedBy);

    const positions: Position[] = [];
    if (proposal && concrete) {
      positions.push({
        participantId: proposal.participantId,
        interpretationId: 'A',
        provenance: 'inferred',
        segmentId: proposal.segmentId,
        text: proposal.text,
      });
    }

    const quotes = [...new Map(
      [discussed.find((c) => c.segmentId === focus.segmentId), proposal, category === 'false_alignment' ? claim : null]
        .filter((c): c is Claim => Boolean(c))
        .map((c) => [c.segmentId, { segmentId: c.segmentId, quote: quoteOf(c.text) }]),
    ).values()];

    const keepKw = top.category === 'external' ? stems([...EXCLUDE_WORDS, 'nothing', 'quiet', 'silent']) : stems(KEEP_WORDS);
    const reverseKw = top.category === 'external' ? stems(NOTIFY_WORDS) : stems(REVERSE_WORDS);

    const gerund = reversalGerund(focus.reversalWord);
    const [rvHead, ...rvRest] = rv.verb.split(' ');
    const interpretations: Interpretation[] = [
      {
        id: 'A',
        label: top.category === 'external' ? `No ${effectObj} follow-up` : `${capitalize(effectObj)} stays`,
        behavior: `${gerund} the ${opWord} leaves the ${effectObj} from ${fn.symbolName} in place${proposalEffects.length ? ` (only ${mentionedDesc} changes)` : ''}.`,
        keywords: keepKw,
      },
      {
        id: 'B',
        label: `Also ${rv.verb} ${effectObj}`,
        behavior: `${gerund} the ${opWord} also ${[thirdPerson(rvHead!), ...rvRest].join(' ')} the ${effectObj} that ${fn.symbolName} ${describeEffect(top).split(' ')[0]} (${top.target}).`,
        keywords: reverseKw,
      },
    ];

    const titles: Record<string, string> = {
      false_alignment: `Agreement may hide different expectations about ${effectObj}`,
      codebase_conflict: `${capitalize(opWord)} also ${describeEffect(top)} — not covered by the proposal`,
      missing_specification: `Unspecified: what happens to ${effectObj} when the ${opWord} is ${reversalParticiple(focus.reversalWord)}`,
    };
    const recorded = top ? state.claims.find((c) => c.participantId.startsWith('prior:') && mentions(top, c, fnTerms)) : undefined;
    const recordNote = recorded
      ? ` An earlier decision covers this — ${participantName(state, recorded.participantId).replace(/^Earlier decision \((.*)\)$/, '$1')}: “${truncate(recorded.text, 140)}” Check that the proposal is consistent with it.`
      : '';
    const descriptions: Record<string, string> = {
      false_alignment: `The proposal changes ${mentionedDesc}, and ${participantName(state, agreer ?? '')} agreed. But ${fn.symbolName} also ${describeEffect(top)}, and nobody said whether that should be ${rv.participle}. The agreement could mean either interpretation.`,
      codebase_conflict: `The proposal changes ${mentionedDesc}. The existing ${fn.symbolName} also ${describeEffect(top)}, so reversing only part of it may leave the ${effectObj} in place. This is a potential conflict, not a confirmed defect.`,
      missing_specification: `${fn.symbolName} ${describeEffect(top)}. The conversation has not said what should happen to the ${effectObj} when the ${opWord} is ${reversalParticiple(focus.reversalWord)}.`,
    };

    return {
      key: `effect:${fn.symbolName}:${top.target}`,
      category,
      title: titles[category]!,
      description: descriptions[category]! + recordNote,
      quotes,
      codeRefs: [
        {
          evidenceId: fn.id,
          startLine: top.line,
          endLine: top.line,
          note: `${fn.symbolName} ${describeEffect(top)}${top.via ? ` (via ${top.via})` : ''}.`,
        },
        ...proposalEffects.slice(0, 1).map((e) => ({
          evidenceId: fn.id,
          startLine: e.line,
          endLine: e.line,
          note: `Currently ${describeEffect(e)}; this is the part the proposal reverses.`,
        })),
      ],
      interpretations,
      consequence: top.category,
      impactExplanation: `If interpretations differ, the ${effectObj} may be ${top.category === 'external' ? 'handled inconsistently' : `left ${top.category === 'permission' ? 'active' : 'in place'}`} after the ${opWord} is ${reversalParticiple(focus.reversalWord)}.`,
      confidence: category === 'false_alignment' ? 0.8 : 0.75,
      relevantParticipantIds: [...relevant],
      positions,
      meta: {
        kind: 'effect_gap',
        fn: fn.symbolName,
        verb: verb ?? 'change',
        object: object || 'record',
        effectTarget: top.target,
        effectObj,
        effectCategory: top.category,
        beneficiary,
        operationWord: opWord,
        reversalWord: focus.reversalWord ?? '',
        actor: focus.actor ?? 'someone',
        mentioned: proposalEffects.length ? proposalEffects.map(describeEffect).join(' and ') : '',
        effectDesc: describeEffect(top),
        linkTerms: effectKeywords(top, fnTerms, { withCategoryWords: true }).join(' '),
      },
    };
  }

  // ---- Rule: hidden assumption — reusing code whose side effects nobody mentioned ----
  private hiddenAssumption({ ctx, claim, analysis, evidence }: CandidateInput): RawCandidate | null {
    if (!analysis.reuseTarget || claim.ambiguousSpeaker) return null;
    const state = ctx.state;
    const targetTerms = new Set(contentTerms(analysis.reuseTarget));
    const purposeTerms = new Set(analysis.purpose ? contentTerms(analysis.purpose) : []);
    const reusedTerms = [...targetTerms].filter((t) => !purposeTerms.has(t));
    const candidates = evidence
      .filter((ev) => !ev.isTest && ev.reason.startsWith('matches'))
      .map((ev) => ({ ev, overlap: identifierTerms(ev.symbolName).filter((t) => reusedTerms.includes(t) || targetTerms.has(t)).length }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap);
    const reused = candidates[0]?.ev;
    if (!reused) return null;

    const purposeStems = new Set([...purposeTerms, ...identifierTerms(reused.symbolName)]);
    const surprising = rankEffects(
      reused.effects.filter(
        (e) =>
          HIGH_CONSEQUENCE.has(e.category) &&
          !isAddressed(e, state.claims) &&
          // Effects that are clearly the reason to reuse the code are not surprising.
          !(effectKeywords(e).some((k) => purposeStems.has(k)) && !e.condition),
      ),
    );
    const top = surprising[0];
    if (!top) return null;

    const owner = requirementOwner(state);
    const purpose = analysis.purpose ?? 'this feature';
    const what = `${describeEffect(top)}${top.condition ? ` when ${humanizeCondition(top.condition)}` : ''}`;
    return {
      key: `reuse:${reused.symbolName}:${top.target}`,
      category: 'hidden_assumption',
      title: `Reusing ${reused.symbolName} also ${describeEffect(top)}`,
      description: `${participantName(state, claim.participantId)} plans to reuse ${reused.symbolName}. That code also ${what}. It is not established whether that behavior is wanted for ${purpose}.`,
      quotes: [{ segmentId: claim.segmentId, quote: quoteOf(claim.text) }],
      codeRefs: [
        {
          evidenceId: reused.id,
          startLine: top.line,
          endLine: top.line,
          note: `${reused.symbolName} ${what}${top.via ? ` (via ${top.via})` : ''}.`,
        },
      ],
      interpretations: [
        {
          id: 'A',
          label: 'Reuse as-is',
          behavior: `${capitalize(purpose)} goes through ${reused.symbolName} unchanged, so it also ${what}.`,
          keywords: stems(['same', 'fine', 'also', 'too', 'keep', 'as-is', 'okay']),
        },
        {
          id: 'B',
          label: `Exclude ${effectObject(top)}`,
          behavior: `${capitalize(purpose)} reuses ${reused.symbolName} but must not ${baseVerbPhrase(top)}.`,
          keywords: stems(EXCLUDE_WORDS),
        },
      ],
      consequence: top.category,
      impactExplanation: `Reusing the code as-is would carry the ${effectObject(top)} behavior into ${purpose}.`,
      confidence: 0.75,
      relevantParticipantIds: [...new Set([claim.participantId, owner?.id].filter((x): x is string => Boolean(x)))],
      positions: [
        { participantId: claim.participantId, interpretationId: 'A', provenance: 'inferred', segmentId: claim.segmentId, text: claim.text },
      ],
      meta: {
        kind: 'reuse',
        fn: reused.symbolName,
        effectTarget: top.target,
        effectObj: effectObject(top),
        effectCategory: top.category,
        what,
        purpose,
        linkTerms: effectKeywords(top, [], { withCategoryWords: true }).join(' '),
      },
    };
  }

  // ---- Module 4: scenario / question drafting ----
  async draftClarification(
    d: Discrepancy,
    purpose: ClarificationPurpose,
    state: SessionState,
    targetParticipantId: string | null,
  ): Promise<ClarificationDraft> {
    const m = d.meta;
    const empty = { scenario: null, beforeAfter: null, decisionTable: null };
    if (m.kind === 'disagreement') {
      const [a, b] = d.positions;
      const scenario = a && b ? `${participantName(state, a.participantId)}: “${truncate(a.text, 120)}” — ${participantName(state, b.participantId)}: “${truncate(b.text, 120)}”` : null;
      return {
        ...empty,
        format: 'verbal',
        question: `Should this change include the ${m.topic}?`,
        scenario,
        answerKey: { yes: 'A', no: 'B' },
      };
    }

    if (m.kind === 'reuse') {
      return {
        ...empty,
        format: 'verbal',
        scenario: `The existing ${m.fn} also ${m.what}.`,
        question: `Should that also happen for ${m.purpose}?`,
        answerKey: { yes: 'A', no: 'B' },
      };
    }

    if (m.kind === 'effect_gap') {
      const cat = m.effectCategory as Effect['category'];
      const op = operationNoun(m);
      const object = m.object!;
      const past = pastTense(m.verb!);
      const rev = reversalPresent(m.reversalWord || null);
      const participle = reversalParticiple(m.reversalWord || null);
      const ben = m.beneficiary!;
      const eo = m.effectObj!;
      const rv = reverseVerb(cat);
      const setupByCat: Record<string, string> = {
        permission: `and the ${ben} has been using the ${eo} it granted`,
        financial: `and the ${ben} received the ${eo} that comes with it`,
        external: `and the ${eo} has already gone out`,
        irreversible: `and the ${eo} has already happened`,
        data: `and the ${eo} was recorded`,
      };
      const scenario = `${capitalize(article(object))} ${object} was ${past} yesterday, ${setupByCat[cat]}. Today ${m.actor} ${rev} the ${op}.`;

      if (purpose === 'private_check') {
        const qByCat: Record<string, { q: string; yes: string; no: string }> = {
          permission: { q: `Can the ${ben} still use that ${eo}?`, yes: 'A', no: 'B' },
          financial: { q: `Does the ${ben} keep the ${eo}?`, yes: 'A', no: 'B' },
          external: { q: `Should the ${ben} be told that the ${op} was ${participle}?`, yes: 'B', no: 'A' },
          irreversible: { q: `Should the ${eo} stay as it is?`, yes: 'A', no: 'B' },
          data: { q: `Should the ${eo} stay as it is?`, yes: 'A', no: 'B' },
        };
        const q = qByCat[cat]!;
        return {
          ...empty,
          format: 'scenario',
          scenario,
          question: q.q,
          answerKey: { yes: q.yes, no: q.no },
        };
      }

      const groupQ =
        cat === 'external'
          ? `When ${article(op)} ${op} is ${participle}, should the ${ben} be notified?`
          : `When ${article(op)} ${op} is ${participle}, should the ${ben}'s ${eo} also be ${rv.participle}?`;
      const answerKey = { yes: 'B', no: 'A' };

      if (purpose === 'surface_difference') {
        const diffs = d.positions
          .filter((p) => p.provenance !== 'inferred')
          .map((p) => `${participantName(state, p.participantId)} expects: ${d.interpretations.find((i) => i.id === p.interpretationId)?.label ?? p.interpretationId}`);
        return { ...empty, format: 'verbal', scenario: diffs.join(' · '), question: groupQ, answerKey };
      }

      if (d.category === 'codebase_conflict') {
        return {
          ...empty,
          format: 'before_after',
          question: groupQ,
          beforeAfter: {
            before: m.mentioned ? `Today, ${m.fn} ${m.mentioned} and ${m.effectDesc}.` : `Today, ${m.fn} ${m.effectDesc}.`,
            after: Object.fromEntries(d.interpretations.map((i) => [i.id, i.behavior])),
          },
          answerKey,
        };
      }
      return { ...empty, format: 'scenario', scenario, question: groupQ, answerKey };
    }

    void targetParticipantId;
    return { ...empty, format: 'verbal', question: d.title, answerKey: {} };
  }

  // ---- Module 6 helper: map a free-form answer onto an interpretation ----
  async interpretResponse(
    text: string,
    d: Discrepancy,
    opts: { clarification?: Clarification; latestOtherPosition?: Position },
  ): Promise<ResponseInterpretation> {
    return interpretResponseHeuristic(text, d, opts);
  }
}

export function interpretResponseHeuristic(
  text: string,
  d: Discrepancy,
  opts: { clarification?: Clarification; latestOtherPosition?: Position },
): ResponseInterpretation {
  const yn = leadingYesNo(text);
  const body = text.replace(/^\s*(yes|yeah|yep|yup|sure|no|nope|nah|correct|of course|definitely|absolutely)\b[,.!]?\s*/i, '');
  const tokens = words(body);
  const tokenStems = tokens.map((t) => stem(t));

  if (d.meta.kind === 'disagreement') {
    const topic = new Set((d.meta.topicTerms ?? '').split(' ').filter(Boolean));
    const onTopic = tokenStems.some((t) => topic.has(t));
    if (onTopic) {
      return isNegated(body) || stance({ polarity: 'positive', text: body }) === 'negative'
        ? { interpretationId: 'B', confidence: 0.7, reason: 'statement against the topic' }
        : { interpretationId: 'A', confidence: 0.7, reason: 'statement in favor of the topic' };
    }
  } else {
    const hits = d.interpretations.map((interp) => {
      let score = 0;
      let flipped = 0;
      tokenStems.forEach((s, i) => {
        if (!interp.keywords.includes(s)) return;
        const window = tokens.slice(Math.max(0, i - 3), i).join(' ');
        if (/\b(not|don't|do not|doesn't|shouldn't|should not|won't|can't|cannot|never|no)\b/.test(window)) flipped++;
        else score++;
      });
      return { id: interp.id, score, flipped };
    });
    const [a, b] = hits;
    if (a && b) {
      const aScore = a.score + b.flipped;
      const bScore = b.score + a.flipped;
      let kwPick: string | null = null;
      if (aScore > bScore) kwPick = a.id;
      else if (bScore > aScore) kwPick = b.id;
      if (kwPick) {
        const ynPick = yn ? opts.clarification?.answerKey[yn] : undefined;
        if (ynPick && ynPick !== kwPick && opts.clarification) {
          return { interpretationId: null, confidence: 0.2, reason: 'yes/no answer conflicts with the rest of the reply' };
        }
        return { interpretationId: kwPick, confidence: 0.75, reason: 'keywords' };
      }
    }
  }

  if (yn && opts.clarification) {
    const pick = opts.clarification.answerKey[yn];
    if (pick) return { interpretationId: pick, confidence: 0.7, reason: `answered "${yn}" to the question` };
  }
  if (opts.latestOtherPosition && opts.latestOtherPosition.provenance !== 'inferred' && contentTerms(body).length <= 3 && (yn === 'yes' || /\b(agree|sounds good|exactly|makes sense|works|fine|ok|okay|right|sure|definitely)\b/i.test(text))) {
    return { interpretationId: opts.latestOtherPosition.interpretationId, confidence: 0.6, reason: 'agreed with the latest explicit position' };
  }
  return { interpretationId: null, confidence: 0, reason: 'no clear mapping to an interpretation' };
}
