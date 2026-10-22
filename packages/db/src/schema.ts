import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Retention for transcripts, in days; null keeps them until deleted. */
  transcriptRetentionDays: integer('transcript_retention_days'),
  monthlyBudgetUsd: real('monthly_budget_usd').notNull().default(5),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
    /** Authentication is deferred to Phase 3 (GitHub sign-in); no credentials are stored here. */
    authProvider: text('auth_provider'),
    authSubject: text('auth_subject'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_workspace_email').on(t.workspaceId, t.email)],
);

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['sample', 'github'] }).notNull(),
    name: text('name').notNull(),
    /** Sample repositories are read from the local fixtures directory. */
    sampleKey: text('sample_key'),
    githubInstallationId: text('github_installation_id'),
    githubRepositoryId: text('github_repository_id'),
    defaultBranch: text('default_branch').notNull().default('main'),
    indexedCommitSha: text('indexed_commit_sha'),
    indexingStatus: text('indexing_status', { enum: ['pending', 'indexing', 'ready', 'failed'] }).notNull().default('pending'),
    indexingError: text('indexing_error'),
    indexingProgress: jsonb('indexing_progress').$type<{ done: number; total: number }>(),
    symbolCount: integer('symbol_count').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('repositories_workspace').on(t.workspaceId)],
);

export const codeSymbols = pgTable(
  'code_symbols',
  {
    id: text('id').primaryKey(),
    repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    filePath: text('file_path').notNull(),
    symbolName: text('symbol_name').notNull(),
    symbolType: text('symbol_type').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    signature: text('signature').notNull(),
    content: text('content').notNull(),
    calls: jsonb('calls').$type<string[]>().notNull(),
    effects: jsonb('effects').notNull(),
    imports: jsonb('imports').$type<string[]>().notNull(),
    isTest: boolean('is_test').notNull(),
    language: text('language').notNull(),
    /** Identifier words split for full-text search (e.g. "approve application"). */
    nameTerms: text('name_terms').notNull(),
    pathTerms: text('path_terms').notNull(),
    bodyTerms: text('body_terms').notNull(),
    searchableContent: tsvector('searchable_content').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', name_terms), 'A') || setweight(to_tsvector('english', path_terms), 'B') || setweight(to_tsvector('english', body_terms), 'C')`,
    ),
  },
  (t) => [
    index('code_symbols_repo_sha_name').on(t.repositoryId, t.commitSha, t.symbolName),
    index('code_symbols_search').using('gin', t.searchableContent),
  ],
);

export const meetingSessions = pgTable(
  'meeting_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    githubIssueReference: text('github_issue_reference'),
    featureDescription: text('feature_description'),
    status: text('status', { enum: ['active', 'ended'] }).notNull().default('active'),
    analyzer: text('analyzer').notNull(),
    commitSha: text('commit_sha'),
    /** Participants were told the discussion is being transcribed and analyzed. */
    consentConfirmedAt: timestamp('consent_confirmed_at', { withTimezone: true }),
    /** Engine state snapshot (compact structured state, never raw audio). */
    state: jsonb('state'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_workspace_started').on(t.workspaceId, t.startedAt)],
);

const sessionRef = () => uuid('session_id').notNull().references(() => meetingSessions.id, { onDelete: 'cascade' });

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: sessionRef(),
    localId: text('local_id').notNull(),
    displayName: text('display_name').notNull(),
    participantRole: text('participant_role').notNull(),
    ambiguous: boolean('ambiguous').notNull().default(false),
  },
  (t) => [uniqueIndex('participants_session_local').on(t.sessionId, t.localId)],
);

export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: sessionRef(),
    localId: text('local_id').notNull(),
    participantLocalId: text('participant_local_id').notNull(),
    idx: integer('idx').notNull(),
    timestampMs: integer('timestamp_ms').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('segments_session_local').on(t.sessionId, t.localId), index('segments_session_idx').on(t.sessionId, t.idx)],
);

export const requirements = pgTable(
  'requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: sessionRef(),
    localId: text('local_id').notNull(),
    lineageId: text('lineage_id').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull(),
    confirmation: text('confirmation').notNull(),
    evidence: jsonb('evidence').notNull(),
    confirmedBy: jsonb('confirmed_by').$type<string[]>().notNull(),
    version: integer('version').notNull(),
    supersedes: text('supersedes'),
    discrepancyLocalId: text('discrepancy_local_id'),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
  },
  (t) => [uniqueIndex('requirements_session_local').on(t.sessionId, t.localId)],
);

export const discrepancies = pgTable(
  'discrepancies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: sessionRef(),
    localId: text('local_id').notNull(),
    key: text('key').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** Conversation statements and code references backing the concern. */
    evidence: jsonb('evidence').notNull(),
    interpretations: jsonb('interpretations').notNull(),
    impactScore: real('impact_score').notNull(),
    confidence: real('confidence').notNull(),
    status: text('status').notNull(),
    visibility: text('visibility').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('discrepancies_session_local').on(t.sessionId, t.localId), index('discrepancies_status').on(t.sessionId, t.status)],
);

export const clarifications = pgTable(
  'clarifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: sessionRef(),
    localId: text('local_id').notNull(),
    discrepancyLocalId: text('discrepancy_local_id').notNull(),
    question: text('question').notNull(),
    format: text('format').notNull(),
    purpose: text('purpose').notNull(),
    targetedParticipantLocalId: text('targeted_participant_local_id'),
    response: jsonb('response').notNull(),
    resolution: text('resolution'),
    confirmationStatus: text('confirmation_status').notNull(),
  },
  (t) => [uniqueIndex('clarifications_session_local').on(t.sessionId, t.localId)],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => meetingSessions.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    estimatedCost: real('estimated_cost').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_workspace_created').on(t.workspaceId, t.createdAt)],
);
