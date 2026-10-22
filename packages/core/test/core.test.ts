import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  classifyCall,
  consensus,
  contentTerms,
  decide,
  emptyState,
  estimateCostUsd,
  markers,
  parseTranscript,
  quoteAppearsIn,
  redactSecrets,
  scoreDiscrepancy,
  validateCandidate,
  type CodeEvidence,
  type Discrepancy,
  type RawCandidate,
  type Segment,
} from '../src';

const evidence: CodeEvidence = {
  id: 'E1',
  symbolId: 'sym1',
  symbolName: 'approveApplication',
  filePath: 'src/applications/approve.ts',
  startLine: 11,
  endLine: 25,
  commitSha: 'abc',
  snippet: '...',
  reason: 'matches approv',
  effects: [],
  isTest: false,
};
const segs = new Map<string, Segment>([
  ['s1', { id: 's1', index: 0, participantId: 'p1', timestamp: 0, text: "I'll just set the status back to pending." }],
]);
const candidate = (over: Partial<RawCandidate> = {}): RawCandidate => ({
  key: 'k',
  category: 'codebase_conflict',
  title: 't',
  description: 'd',
  quotes: [{ segmentId: 's1', quote: 'set the status back to pending' }],
  codeRefs: [{ evidenceId: 'E1', startLine: 22, endLine: 22, note: 'grants access' }],
  interpretations: [
    { id: 'A', label: 'a', behavior: 'status only', keywords: [] },
    { id: 'B', label: 'b', behavior: 'status and access', keywords: [] },
  ],
  consequence: 'permission',
  impactExplanation: '',
  confidence: 0.8,
  relevantParticipantIds: [],
  positions: [],
  meta: {},
  ...over,
});

describe('citation validator', () => {
  it('accepts citations inside retrieved evidence and verbatim quotes', () => {
    const v = validateCandidate(candidate(), [evidence], segs, 'abc');
    expect(v.ok).toBe(true);
  });
  it('rejects a code reference to evidence that was never retrieved (hallucinated file)', () => {
    const v = validateCandidate(candidate({ codeRefs: [{ evidenceId: 'E9', startLine: 1, endLine: 1, note: '' }] }), [evidence], segs, 'abc');
    expect(v).toMatchObject({ ok: false, reason: 'unknown_evidence' });
  });
  it('rejects line numbers outside the cited symbol', () => {
    const v = validateCandidate(candidate({ codeRefs: [{ evidenceId: 'E1', startLine: 80, endLine: 81, note: '' }] }), [evidence], segs, 'abc');
    expect(v).toMatchObject({ ok: false, reason: 'lines_out_of_range' });
  });
  it('rejects evidence from a different commit', () => {
    expect(validateCandidate(candidate(), [evidence], segs, 'other')).toMatchObject({ ok: false, reason: 'stale_commit' });
  });
  it('rejects quotes that were never said', () => {
    const v = validateCandidate(candidate({ quotes: [{ segmentId: 's1', quote: 'we will revoke access' }] }), [evidence], segs, 'abc');
    expect(v).toMatchObject({ ok: false, reason: 'quote_not_found' });
  });
  it('rejects a codebase conflict without any code citation', () => {
    expect(validateCandidate(candidate({ codeRefs: [] }), [evidence], segs, 'abc')).toMatchObject({ ok: false, reason: 'no_code_evidence' });
  });
  it('rejects candidates whose interpretations do not differ', () => {
    const same = [
      { id: 'A', label: 'a', behavior: 'Same thing', keywords: [] },
      { id: 'B', label: 'b', behavior: 'same thing.', keywords: [] },
    ];
    expect(validateCandidate(candidate({ interpretations: same }), [evidence], segs, 'abc')).toMatchObject({ ok: false, reason: 'indistinct_interpretations' });
  });
});

describe('text and markers', () => {
  it('detects agreement, proposals, reversal and reuse', () => {
    expect(markers('Sounds good.').has('agreement')).toBe(true);
    expect(markers("I'll set the status back to pending").has('proposal')).toBe(true);
    expect(markers('we need a way to undo approvals').has('reversal')).toBe(true);
    expect(markers("I'll reuse the existing authentication system").has('reuse')).toBe(true);
    expect(markers("We don't need an email").has('disagreement')).toBe(true);
  });
  it('splits identifiers mentioned in speech', () => {
    expect(contentTerms('just reuse sendReceipt')).toEqual(expect.arrayContaining(['send', 'receipt']));
  });
  it('matches quotes despite punctuation and smart quotes', () => {
    expect(quoteAppearsIn('we don’t need an email', "We don't need an email notification.")).toBe(true);
  });
  it('classifies call side effects by name', () => {
    expect(classifyCall('grantAccess')).toBe('permission');
    expect(classifyCall('issueStoreCredit')).toBe('financial');
    expect(classifyCall('sendApprovalEmail')).toBe('external');
    expect(classifyCall('saveInvoice')).toBe('data');
    expect(classifyCall('findUserByEmail')).toBeNull();
  });
});

describe('transcript parsing', () => {
  it('parses speakers, roles, timestamps and continuation lines', () => {
    const segs = parseTranscript(`[00:05] Priya (PO): We need undo.
continued thought
Sam (Developer): Sure.
Unknown: ok`);
    expect(segs).toEqual([
      { speaker: 'Priya', role: 'product_owner', text: 'We need undo. continued thought', timestamp: 5000 },
      { speaker: 'Sam', role: 'developer', text: 'Sure.' },
      { speaker: 'Unknown', role: undefined, text: 'ok' },
    ]);
  });
});

function disc(over: Partial<Discrepancy> = {}): Discrepancy {
  return {
    id: 'd1', key: 'k', category: 'false_alignment', title: '', description: '', statements: [], codeRefs: [],
    interpretations: [
      { id: 'A', label: '', behavior: 'a', keywords: [] },
      { id: 'B', label: '', behavior: 'b', keywords: [] },
    ],
    impact: { consequence: 'permission', explanation: '' }, impactScore: 0, confidence: 0.8, decision: 'defer', visibility: 'hidden',
    status: 'potential', relevantParticipantIds: ['p1', 'p2'], positions: [], clarificationIds: [], surfaceAfterSegmentIndex: 0,
    surfacedAtSegmentIndex: null, createdAtSegmentId: 's1', lastLinkedSegmentIndex: 0, resolution: null, history: [], notes: [], meta: {},
    ...over,
  };
}

describe('resolution tracker consensus', () => {
  it('ignores inferred positions', () => {
    const d = disc({ positions: [{ participantId: 'p1', interpretationId: 'A', provenance: 'inferred', text: '' }] });
    expect(consensus(d).state).toBe('incomplete');
  });
  it('requires every relevant participant before agreeing', () => {
    const d = disc({ positions: [{ participantId: 'p1', interpretationId: 'A', provenance: 'explicit', text: '' }] });
    expect(consensus(d)).toMatchObject({ state: 'incomplete', missing: ['p2'] });
    d.positions.push({ participantId: 'p2', interpretationId: 'A', provenance: 'scenario_answer', text: '' });
    expect(consensus(d)).toEqual({ state: 'agree', interpretationId: 'A' });
  });
  it('one dissent is a confirmed difference', () => {
    const d = disc({
      positions: [
        { participantId: 'p1', interpretationId: 'A', provenance: 'explicit', text: '' },
        { participantId: 'p2', interpretationId: 'B', provenance: 'explicit', text: '' },
      ],
    });
    expect(consensus(d).state).toBe('differ');
  });
  it('uses each participant’s latest position (people change their minds)', () => {
    const d = disc({
      positions: [
        { participantId: 'p1', interpretationId: 'A', provenance: 'explicit', text: '' },
        { participantId: 'p2', interpretationId: 'B', provenance: 'explicit', text: '' },
        { participantId: 'p2', interpretationId: 'A', provenance: 'explicit', text: '' },
      ],
    });
    expect(consensus(d)).toEqual({ state: 'agree', interpretationId: 'A' });
  });
});

describe('prioritizer', () => {
  const state = emptyState('s', 'abc');
  it('scores code-backed permission concerns above the live threshold', () => {
    const d = disc({
      statements: [{ segmentId: 's1', participantId: 'p1', quote: 'x' }, { segmentId: 's2', participantId: 'p2', quote: 'y' }],
      codeRefs: [{ evidenceId: 'E1', filePath: 'f', startLine: 1, endLine: 1, commitSha: 'abc', symbolName: 'f', note: '' }],
    });
    const s = scoreDiscrepancy(d, state, 1, DEFAULT_CONFIG.scoring, 12);
    expect(s.score).toBeGreaterThan(DEFAULT_CONFIG.scoring.liveThreshold);
    expect(decide(s.score, DEFAULT_CONFIG.scoring, true)).toBe('surface');
    expect(decide(s.score, DEFAULT_CONFIG.scoring, false)).toBe('defer');
  });
  it('scores low-consequence, evidence-free concerns below the suppress threshold', () => {
    const d = disc({ category: 'missing_specification', impact: { consequence: 'data', explanation: '' }, confidence: 0.2, interpretations: [] });
    const s = scoreDiscrepancy(d, state, 40, DEFAULT_CONFIG.scoring, 12);
    expect(decide(s.score, DEFAULT_CONFIG.scoring, true)).toBe('suppress');
  });
  it('gives resolved concerns zero score', () => {
    expect(scoreDiscrepancy(disc({ status: 'resolved' }), state, 1, DEFAULT_CONFIG.scoring, 12).score).toBe(0);
  });
});

describe('cost and secrets', () => {
  it('estimates cost from a configurable price table', () => {
    expect(estimateCostUsd('m', 1_000_000, 500_000, { m: { inputPerMTok: 1, outputPerMTok: 4 } })).toBeCloseTo(3);
    expect(estimateCostUsd('unknown', 1000, 1000)).toBe(0);
  });
  it('redacts credentials before repository text reaches a model', () => {
    const out = redactSecrets(`const apiKey = "sk_live_abcdefghijklmnop";\nconst token = 'ghp_abcdefghijklmnopqrstuvwxyz1234';\nconst x = 1;`);
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('const x = 1;');
  });
});
