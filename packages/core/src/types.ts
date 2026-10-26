import { z } from 'zod';

// ---------- Participants & transcript ----------

export const ParticipantRole = z.enum([
  'product_owner',
  'developer',
  'designer',
  'qa',
  'stakeholder',
  'unknown',
]);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

export const Participant = z.object({
  id: z.string(),
  displayName: z.string(),
  role: ParticipantRole,
  /** True when the transcript could not attribute this speaker reliably. */
  ambiguous: z.boolean().default(false),
});
export type Participant = z.infer<typeof Participant>;

export const TranscriptSegmentInput = z.object({
  speaker: z.string().min(1),
  role: ParticipantRole.optional(),
  text: z.string().min(1),
  /** Milliseconds from meeting start. */
  timestamp: z.number().int().nonnegative().optional(),
  /** Source-assigned id; a segment re-sent with the same id (e.g. a retry) is ignored. */
  externalId: z.string().min(1).max(128).optional(),
});
export type TranscriptSegmentInput = z.infer<typeof TranscriptSegmentInput>;

export const Segment = z.object({
  id: z.string(),
  index: z.number().int(),
  participantId: z.string(),
  timestamp: z.number().int(),
  text: z.string(),
});
export type Segment = z.infer<typeof Segment>;

// ---------- Code index ----------

export const EffectCategory = z.enum(['permission', 'financial', 'irreversible', 'external', 'data']);
export type EffectCategory = z.infer<typeof EffectCategory>;

export const Effect = z.object({
  kind: z.enum(['call', 'assign']),
  /** Called function name, or assigned property name. */
  target: z.string(),
  category: EffectCategory,
  line: z.number().int(),
  text: z.string(),
  /** Assigned value for `assign` effects (source text). */
  value: z.string().optional(),
  /** Source text of an enclosing `if` condition, when the effect is conditional. */
  condition: z.string().optional(),
  /** Set when this effect was inherited from a called function in the same repo. */
  via: z.string().optional(),
});
export type Effect = z.infer<typeof Effect>;

export const SymbolType = z.enum(['function', 'method', 'class', 'arrow_function', 'interface', 'type']);
export type SymbolType = z.infer<typeof SymbolType>;

export const CodeSymbol = z.object({
  id: z.string(),
  commitSha: z.string(),
  filePath: z.string(),
  symbolName: z.string(),
  symbolType: SymbolType,
  startLine: z.number().int(),
  endLine: z.number().int(),
  signature: z.string(),
  content: z.string(),
  calls: z.array(z.string()),
  effects: z.array(Effect),
  imports: z.array(z.string()),
  isTest: z.boolean(),
  language: z.enum(['typescript', 'tsx', 'javascript']),
});
export type CodeSymbol = z.infer<typeof CodeSymbol>;

export const CodeEvidence = z.object({
  id: z.string(),
  symbolId: z.string(),
  symbolName: z.string(),
  filePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  commitSha: z.string(),
  snippet: z.string(),
  reason: z.string(),
  effects: z.array(Effect),
  isTest: z.boolean(),
});
export type CodeEvidence = z.infer<typeof CodeEvidence>;

/** A citation of code inside a discrepancy. Always resolvable to an indexed symbol at a commit. */
export const CodeRef = z.object({
  evidenceId: z.string(),
  filePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  commitSha: z.string(),
  symbolName: z.string(),
  note: z.string(),
});
export type CodeRef = z.infer<typeof CodeRef>;

/**
 * A Slack message used as context, by reference only: Slack's terms forbid storing what search
 * returns, so persisted state never holds message text. Private channels and DMs keep no channel
 * or author name either; the permalink only opens for people who can already see the message.
 */
export const SlackRef = z.object({
  id: z.string(),
  permalink: z.string(),
  /** "#approvals", or "private conversation" for private channels and DMs. */
  channelLabel: z.string(),
  authorName: z.string().nullable(),
  ts: z.string(),
  private: z.boolean(),
});
export type SlackRef = z.infer<typeof SlackRef>;

/** A Slack citation inside a discrepancy. */
export const SlackCitation = SlackRef.extend({ note: z.string() });
export type SlackCitation = z.infer<typeof SlackCitation>;

// ---------- Conversation state ----------

export const Provenance = z.enum(['explicit', 'inferred', 'unknown']);
export type Provenance = z.infer<typeof Provenance>;

export const ClaimKind = z.enum([
  'requirement',
  'proposal',
  'agreement',
  'disagreement',
  'question',
  'correction',
  'statement',
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Claim = z.object({
  id: z.string(),
  segmentId: z.string(),
  participantId: z.string(),
  kinds: z.array(ClaimKind),
  text: z.string(),
  /** Stemmed content terms. */
  terms: z.array(z.string()),
  polarity: z.enum(['positive', 'negative', 'neutral']),
  provenance: Provenance,
  ambiguousSpeaker: z.boolean(),
});
export type Claim = z.infer<typeof Claim>;

export const Quote = z.object({
  segmentId: z.string(),
  participantId: z.string(),
  quote: z.string(),
});
export type Quote = z.infer<typeof Quote>;

export const Interpretation = z.object({
  id: z.string(),
  label: z.string(),
  behavior: z.string(),
  /** Stemmed keywords that indicate a participant holds this interpretation. */
  keywords: z.array(z.string()).default([]),
});
export type Interpretation = z.infer<typeof Interpretation>;

export const DiscrepancyCategory = z.enum([
  'direct_disagreement',
  'hidden_assumption',
  'codebase_conflict',
  'missing_specification',
  'false_alignment',
]);
export type DiscrepancyCategory = z.infer<typeof DiscrepancyCategory>;

export const DiscrepancyStatus = z.enum([
  'potential',
  'suggested',
  'awaiting_response',
  'different_expectations_confirmed',
  'resolution_proposed',
  'confirmed',
  'resolved',
  'dismissed',
  'unresolved',
]);
export type DiscrepancyStatus = z.infer<typeof DiscrepancyStatus>;

export const Position = z.object({
  participantId: z.string(),
  interpretationId: z.string(),
  /**
   * explicit: participant stated it; scenario_answer: answered a private check;
   * inferred: implied by what they said (never enough to confirm a decision).
   */
  provenance: z.enum(['explicit', 'scenario_answer', 'inferred']),
  segmentId: z.string().optional(),
  clarificationId: z.string().optional(),
  text: z.string(),
});
export type Position = z.infer<typeof Position>;

export const Discrepancy = z.object({
  id: z.string(),
  /** Semantic dedupe key, e.g. `effect:approveApplication:grantAccess`. */
  key: z.string(),
  category: DiscrepancyCategory,
  title: z.string(),
  description: z.string(),
  statements: z.array(Quote),
  codeRefs: z.array(CodeRef),
  /** Slack messages the concern rests on (references only). Absent in sessions from before Slack. */
  slackRefs: z.array(SlackCitation).optional(),
  interpretations: z.array(Interpretation),
  impact: z.object({
    consequence: z.union([EffectCategory, z.literal('business_rule')]),
    explanation: z.string(),
  }),
  impactScore: z.number(),
  confidence: z.number(),
  decision: z.enum(['surface', 'defer', 'suppress']),
  /** live: shown in the side panel; queued: saved for later / rate limited; hidden: not shown. */
  visibility: z.enum(['live', 'queued', 'hidden']),
  status: DiscrepancyStatus,
  relevantParticipantIds: z.array(z.string()),
  positions: z.array(Position),
  clarificationIds: z.array(z.string()),
  surfaceAfterSegmentIndex: z.number().int().nullable(),
  /** Segment index at which the suggestion first appeared live; null if never surfaced. */
  surfacedAtSegmentIndex: z.number().int().nullable(),
  createdAtSegmentId: z.string(),
  lastLinkedSegmentIndex: z.number().int(),
  resolution: z
    .object({
      interpretationId: z.string(),
      summary: z.string(),
      confirmedBy: z.array(z.string()),
      requirementId: z.string(),
    })
    .nullable(),
  history: z.array(
    z.object({ at: z.number().int(), status: DiscrepancyStatus, note: z.string() }),
  ),
  notes: z.array(z.string()),
  /** The user's rating of the suggestion, used for the "useful questions" metric. */
  feedback: z.enum(['useful', 'not_useful']).nullable().optional(),
  /** Context for templating questions (heuristic analyzer) — free-form, not shown. */
  meta: z.record(z.string(), z.string()).default({}),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

export const ClarificationFormat = z.enum(['verbal', 'scenario', 'before_after', 'decision_table']);
export type ClarificationFormat = z.infer<typeof ClarificationFormat>;

export const ClarificationResponse = z.object({
  participantId: z.string(),
  text: z.string(),
  interpretationId: z.string().nullable(),
  source: z.enum(['transcript', 'ui']),
  segmentId: z.string().optional(),
  at: z.number().int(),
});
export type ClarificationResponse = z.infer<typeof ClarificationResponse>;

export const Clarification = z.object({
  id: z.string(),
  discrepancyId: z.string(),
  purpose: z.enum(['group_question', 'private_check', 'surface_difference']),
  format: ClarificationFormat,
  question: z.string(),
  scenario: z.string().nullable(),
  beforeAfter: z
    .object({ before: z.string(), after: z.record(z.string(), z.string()) })
    .nullable(),
  decisionTable: z
    .object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) })
    .nullable(),
  targetedParticipantId: z.string().nullable(),
  private: z.boolean(),
  /** Maps a leading yes/no answer to an interpretation id. */
  answerKey: z.object({ yes: z.string().optional(), no: z.string().optional() }),
  responses: z.array(ClarificationResponse),
  confirmationStatus: z.enum(['pending', 'answered', 'ambiguous', 'superseded']),
});
export type Clarification = z.infer<typeof Clarification>;

export const RequirementEvidence = z.object({
  segmentId: z.string().optional(),
  clarificationId: z.string().optional(),
  participantId: z.string(),
  text: z.string(),
});

export const Requirement = z.object({
  id: z.string(),
  /** Stable across versions. */
  lineageId: z.string(),
  description: z.string(),
  status: z.enum(['proposed', 'confirmed', 'superseded']),
  /** verbal: agreed without a scenario check; clarified: confirmed through a clarification. */
  confirmation: z.enum(['verbal', 'clarified']),
  evidence: z.array(RequirementEvidence),
  confirmedBy: z.array(z.string()),
  version: z.number().int(),
  supersedes: z.string().nullable(),
  discrepancyId: z.string().nullable(),
  /** Set when this decision settles a conflict with an earlier requirement record. */
  priorRecord: z.object({ id: z.string(), outcome: z.enum(['supersedes', 'reaffirms']) }).nullable().optional(),
  acceptanceCriteria: z.array(z.string()),
  codeRefs: z.array(CodeRef),
  /** Slack messages behind the decision, by reference only. */
  slackRefs: z.array(SlackCitation).optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const PriorDecision = z.object({
  id: z.string(),
  description: z.string(),
  source: z.string(),
});
export type PriorDecision = z.infer<typeof PriorDecision>;

export const Focus = z.object({
  symbolId: z.string(),
  evidenceId: z.string(),
  symbolName: z.string(),
  reversal: z.boolean(),
  /** Surface words from the conversation that referred to the operation (e.g. "approval"). */
  operationWords: z.array(z.string()),
  reversalWord: z.string().nullable(),
  actor: z.string().nullable(),
  introducedBy: z.string().nullable(),
  segmentId: z.string().nullable(),
});
export type Focus = z.infer<typeof Focus>;

export const EngineMetrics = z.object({
  segmentsSeen: z.number().int(),
  analysesRun: z.number().int(),
  analysesSkipped: z.number().int(),
  retrievals: z.number().int(),
  retrievalCacheHits: z.number().int(),
  candidatesGenerated: z.number().int(),
  candidatesRejected: z.number().int(),
  rejectionReasons: z.record(z.string(), z.number().int()),
  suggestionsSurfaced: z.number().int(),
  duplicatesSuppressed: z.number().int(),
  /** Segments dropped because their externalId was already ingested. */
  duplicateSegments: z.number().int().optional(),
  /** Processing time of the most recent ingests (ms), newest last; bounded. */
  latencyMs: z.array(z.number()).optional(),
  /** Tiered analyzer: small-model screens run, stretches they flagged, and large-model calls those caused. */
  screens: z.number().int().optional(),
  screenFlags: z.number().int().optional(),
  deepCalls: z.number().int().optional(),
  /** Fact-sheet facts the model said the transcript or code contradicts (rule mistakes to fix). */
  factsDisputed: z.number().int().optional(),
});
export type EngineMetrics = z.infer<typeof EngineMetrics>;

export const SessionState = z.object({
  sessionId: z.string(),
  commitSha: z.string(),
  feature: z.object({
    description: z.string(),
    provenance: Provenance,
  }),
  participants: z.array(Participant),
  claims: z.array(Claim),
  focus: Focus.nullable(),
  evidence: z.array(CodeEvidence),
  contextStatus: z.enum(['none', 'sufficient', 'insufficient']),
  existingBehavior: z.array(z.object({ evidenceId: z.string(), description: z.string() })),
  assumptions: z.array(
    z.object({
      id: z.string(),
      claimId: z.string(),
      description: z.string(),
      status: z.enum(['unverified', 'verified', 'rejected']),
    }),
  ),
  openQuestions: z.array(z.object({ id: z.string(), text: z.string(), discrepancyId: z.string().nullable() })),
  priorDecisions: z.array(PriorDecision),
  discrepancies: z.array(Discrepancy),
  clarifications: z.array(Clarification),
  requirements: z.array(Requirement),
  metrics: EngineMetrics,
  budgetExhausted: z.boolean(),
  ended: z.boolean(),
  counters: z.record(z.string(), z.number().int()),
  /** externalIds already ingested (idempotent live ingestion). */
  externalIds: z.array(z.string()).optional(),
  /**
   * Code currently visible on the shared screen, matched against the repository (desktop capture).
   * `at` is the meeting time it was last seen; older than the screen window it no longer counts.
   */
  screen: z
    .object({
      at: z.number().int(),
      evidenceIds: z.array(z.string()),
      files: z.array(z.string()),
    })
    .nullable()
    .optional(),
  /** Where the tiered analyzer's screen last read up to (segment index and meeting time). */
  screening: z
    .object({
      lastSegmentIndex: z.number().int(),
      lastAt: z.number().int(),
    })
    .optional(),
  /** Slack messages seen this session, by reference (never their text). */
  slackRefs: z.array(SlackRef).optional(),
  /** The latest Slack search results that still count as context; `at` is meeting time. */
  slack: z
    .object({
      at: z.number().int(),
      refIds: z.array(z.string()),
    })
    .nullable()
    .optional(),
});
export type SessionState = z.infer<typeof SessionState>;

// ---------- Engine events ----------

export type EngineEvent =
  | { type: 'segment_added'; segment: Segment }
  | { type: 'duplicate_segment'; externalId: string }
  | { type: 'participant_added'; participant: Participant }
  | { type: 'analysis_skipped'; segmentId: string; reason: string }
  | { type: 'context_retrieved'; evidenceIds: string[]; sufficient: boolean }
  | { type: 'candidate_rejected'; reason: string; detail: string }
  | { type: 'discrepancy_created'; discrepancy: Discrepancy }
  | { type: 'discrepancy_updated'; discrepancy: Discrepancy; note: string }
  | { type: 'clarification_created'; clarification: Clarification }
  | { type: 'clarification_updated'; clarification: Clarification }
  | { type: 'requirement_recorded'; requirement: Requirement }
  | { type: 'budget_exhausted'; spentUsd: number; limitUsd: number }
  | { type: 'screen_observed'; evidenceIds: string[]; files: string[] }
  | { type: 'slack_observed'; refIds: string[] }
  | { type: 'screened'; segments: number; flags: number }
  | { type: 'fact_disputed'; factId: string; fact: string; reason: string };
