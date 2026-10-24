import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    githubOwner: text('github_owner'),
    githubName: text('github_name'),
    /** Web URL used to build links to code at a commit. */
    htmlUrl: text('html_url'),
    defaultBranch: text('default_branch').notNull().default('main'),
    indexedCommitSha: text('indexed_commit_sha'),
    /** `revoked`: the GitHub App lost access; cached code was deleted. */
    indexingStatus: text('indexing_status', { enum: ['pending', 'indexing', 'ready', 'failed', 'revoked'] }).notNull().default('pending'),
    indexingError: text('indexing_error'),
    indexingProgress: jsonb('indexing_progress').$type<{ done: number; total: number }>(),
    symbolCount: integer('symbol_count').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSync: jsonb('last_sync').$type<{ mode: 'full' | 'incremental' | 'unchanged'; changed: number; removed: number; fetched: number; files: number; durationMs: number }>(),
    createdAt: createdAt(),
  },
  (t) => [index('repositories_workspace').on(t.workspaceId), uniqueIndex('repositories_workspace_github').on(t.workspaceId, t.githubRepositoryId)],
);

/**
 * Source of the indexed files at the latest indexed commit, keyed by git blob SHA. Lets a sync fetch
 * only files whose blob changed. Deleted with the repository, or when access is revoked.
 */
export const repositoryFiles = pgTable(
  'repository_files',
  {
    repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    blobSha: text('blob_sha').notNull(),
    content: text('content').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.path] })],
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
    /** Snapshot of the linked GitHub issue (title, body excerpt, url) taken when the session started. */
    githubIssue: jsonb('github_issue').$type<{ number: number; title: string; state: string; url: string; bodyExcerpt: string }>(),
    /** When this session's confirmed decisions were written to requirement records (once). */
    recordsPublishedAt: timestamp('records_published_at', { withTimezone: true }),
    /** Which Slack conversations this session may search; null (older sessions) means off. */
    slackMode: text('slack_mode', { enum: ['off', 'public', 'all'] }),
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

/**
 * Durable, workspace-level agreed requirements. A record keeps one row per version; versions are
 * immutable. Reaffirmations (a later meeting confirming the same decision) are logged without a new version.
 */
export const requirementRecords = pgTable(
  'requirement_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    /** Human-friendly number, shown as REQ-<number>; unique per workspace. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: ['active', 'retired'] }).notNull().default('active'),
    retiredReason: text('retired_reason'),
    currentVersion: integer('current_version').notNull().default(1),
    reaffirmations: jsonb('reaffirmations')
      .$type<{ sessionId: string | null; sessionTitle: string; at: string; confirmedBy: string[] }[]>()
      .notNull()
      .default([]),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('records_workspace_number').on(t.workspaceId, t.number), index('records_workspace_repo').on(t.workspaceId, t.repositoryId, t.status)],
);

export const requirementVersions = pgTable(
  'requirement_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id').notNull().references(() => requirementRecords.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    description: text('description').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
    codeRefs: jsonb('code_refs').notNull(),
    /** Links to Slack messages behind the decision (Slack's terms forbid storing their text). */
    slackRefs: jsonb('slack_refs').notNull().default([]),
    /** Quotes and scenario answers with speaker names; emptied if the source session is deleted. */
    evidence: jsonb('evidence').notNull(),
    evidenceRedacted: boolean('evidence_redacted').notNull().default(false),
    confirmedBy: jsonb('confirmed_by').$type<string[]>().notNull(),
    confirmation: text('confirmation').notNull(),
    concern: text('concern'),
    /** How this version came about: a new decision, or one that replaced the previous version. */
    origin: text('origin', { enum: ['created', 'supersedes'] }).notNull(),
    revisedInMeeting: boolean('revised_in_meeting').notNull().default(false),
    sessionId: uuid('session_id').references(() => meetingSessions.id, { onDelete: 'set null' }),
    sessionTitle: text('session_title').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('versions_record_version').on(t.recordId, t.version), index('versions_session').on(t.sessionId)],
);

/**
 * One Slack user token per workspace, encrypted by the API before it reaches the database. Slack's
 * terms forbid storing what search returns, so there is deliberately no table for messages.
 */
export const slackConnections = pgTable('slack_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull(),
  teamName: text('team_name').notNull(),
  slackUserId: text('slack_user_id').notNull(),
  userName: text('user_name').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  tokenCiphertext: text('token_ciphertext').notNull(),
  /** `revoked`: Slack rejected the token; searches stop until the user connects again. */
  status: text('status', { enum: ['connected', 'revoked'] }).notNull().default('connected'),
  statusDetail: text('status_detail'),
  connectedAt: createdAt(),
});
