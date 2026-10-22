import { and, desc, eq, gte, inArray, lt, sql, sum } from 'drizzle-orm';
import type { CodeSymbol, Segment, SessionState, UsageRecord, UsageSink } from '@uc/core';
import type { Db } from './client';
import {
  aiUsage,
  clarifications,
  codeSymbols,
  discrepancies,
  meetingSessions,
  participants,
  repositories,
  requirements,
  transcriptSegments,
  users,
  workspaces,
} from './schema';
import { searchColumns } from './symbolSearch';

export type RepositoryRow = typeof repositories.$inferSelect;
export type SessionRow = typeof meetingSessions.$inferSelect;
export type UsageRow = typeof aiUsage.$inferSelect;

const DEMO_WORKSPACE = 'Demo workspace';

/** Find or create the single local workspace used until GitHub sign-in exists (Phase 3). */
export async function ensureDemoWorkspace(db: Db) {
  let [ws] = await db.select().from(workspaces).where(eq(workspaces.name, DEMO_WORKSPACE)).limit(1);
  if (!ws) {
    [ws] = await db.insert(workspaces).values({ name: DEMO_WORKSPACE }).returning();
    await db.insert(users).values({ workspaceId: ws!.id, email: 'demo@localhost', displayName: 'Demo user', role: 'owner' });
  }
  return ws!;
}

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * All data access goes through a store bound to one workspace. Every query filters on the
 * workspace (directly, or through a session/repository that was first checked to belong to it),
 * so one workspace can never read or modify another's rows.
 */
export class WorkspaceStore {
  constructor(
    readonly db: Db,
    readonly workspaceId: string,
  ) {}

  async workspace() {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, this.workspaceId));
    return ws!;
  }

  async updateSettings(patch: { transcriptRetentionDays?: number | null; monthlyBudgetUsd?: number }) {
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, this.workspaceId));
  }

  // ---------------- repositories

  listRepositories() {
    return this.db.select().from(repositories).where(eq(repositories.workspaceId, this.workspaceId)).orderBy(repositories.createdAt);
  }

  async getRepository(id: string): Promise<RepositoryRow | null> {
    const [r] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, id), eq(repositories.workspaceId, this.workspaceId)));
    return r ?? null;
  }

  async addSampleRepository(sampleKey: string, name: string): Promise<RepositoryRow> {
    const existing = (await this.listRepositories()).find((r) => r.sampleKey === sampleKey);
    if (existing) return existing;
    const [r] = await this.db.insert(repositories).values({ workspaceId: this.workspaceId, source: 'sample', sampleKey, name }).returning();
    return r!;
  }

  async updateRepository(id: string, patch: Partial<Omit<RepositoryRow, 'id' | 'workspaceId'>>) {
    await this.db
      .update(repositories)
      .set(patch)
      .where(and(eq(repositories.id, id), eq(repositories.workspaceId, this.workspaceId)));
  }

  /** Replace the index for a repository with symbols at a new commit (old commits are dropped). */
  async replaceSymbols(repositoryId: string, commitSha: string, symbols: CodeSymbol[]) {
    if (!(await this.getRepository(repositoryId))) throw new Error('Repository not found');
    await this.db.transaction(async (tx) => {
      await tx.delete(codeSymbols).where(eq(codeSymbols.repositoryId, repositoryId));
      for (let i = 0; i < symbols.length; i += 200) {
        await tx.insert(codeSymbols).values(
          symbols.slice(i, i + 200).map((s) => ({
            id: `${repositoryId.slice(0, 8)}:${s.id}`,
            repositoryId,
            commitSha: s.commitSha,
            filePath: s.filePath,
            symbolName: s.symbolName,
            symbolType: s.symbolType,
            startLine: s.startLine,
            endLine: s.endLine,
            signature: s.signature,
            content: s.content,
            calls: s.calls,
            effects: s.effects,
            imports: s.imports,
            isTest: s.isTest,
            language: s.language,
            ...searchColumns(s),
          })),
        );
      }
      await tx
        .update(repositories)
        .set({ indexedCommitSha: commitSha, symbolCount: symbols.length, indexingStatus: 'ready', indexingError: null, indexedAt: new Date() })
        .where(eq(repositories.id, repositoryId));
    });
  }

  async deleteRepository(id: string) {
    await this.db.delete(repositories).where(and(eq(repositories.id, id), eq(repositories.workspaceId, this.workspaceId)));
  }

  // ---------------- sessions

  async createSession(input: {
    title: string;
    repositoryId: string | null;
    featureDescription?: string | null;
    githubIssueReference?: string | null;
    analyzer: string;
    consentConfirmed: boolean;
  }): Promise<SessionRow> {
    if (input.repositoryId && !(await this.getRepository(input.repositoryId))) throw new Error('Repository not found');
    const [s] = await this.db
      .insert(meetingSessions)
      .values({
        workspaceId: this.workspaceId,
        repositoryId: input.repositoryId,
        title: input.title,
        featureDescription: input.featureDescription ?? null,
        githubIssueReference: input.githubIssueReference ?? null,
        analyzer: input.analyzer,
        consentConfirmedAt: input.consentConfirmed ? new Date() : null,
      })
      .returning();
    return s!;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [s] = await this.db
      .select()
      .from(meetingSessions)
      .where(and(eq(meetingSessions.id, id), eq(meetingSessions.workspaceId, this.workspaceId)));
    return s ?? null;
  }

  listSessions(limit = 20) {
    return this.db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.workspaceId, this.workspaceId))
      .orderBy(desc(meetingSessions.startedAt))
      .limit(limit);
  }

  async loadSegments(sessionId: string): Promise<Segment[]> {
    if (!(await this.getSession(sessionId))) return [];
    const rows = await this.db.select().from(transcriptSegments).where(eq(transcriptSegments.sessionId, sessionId)).orderBy(transcriptSegments.idx);
    return rows.map((r) => ({ id: r.localId, index: r.idx, participantId: r.participantLocalId, timestamp: r.timestampMs, text: r.text }));
  }

  /** Persist the engine snapshot plus normalized rows for dashboards. Idempotent per local id. */
  async saveSessionState(sessionId: string, state: SessionState, segments: Segment[], opts: { ended?: boolean } = {}) {
    if (!(await this.getSession(sessionId))) throw new Error('Session not found');
    await this.db.transaction(async (tx) => {
      await tx
        .update(meetingSessions)
        .set({
          state,
          commitSha: state.commitSha,
          ...(opts.ended ? { status: 'ended' as const, endedAt: new Date() } : {}),
        })
        .where(eq(meetingSessions.id, sessionId));
      for (const p of state.participants) {
        await tx
          .insert(participants)
          .values({ sessionId, localId: p.id, displayName: p.displayName, participantRole: p.role, ambiguous: p.ambiguous })
          .onConflictDoUpdate({ target: [participants.sessionId, participants.localId], set: { participantRole: p.role, ambiguous: p.ambiguous } });
      }
      const stored = new Set(
        (await tx.select({ localId: transcriptSegments.localId }).from(transcriptSegments).where(eq(transcriptSegments.sessionId, sessionId))).map((r) => r.localId),
      );
      const fresh = segments.filter((s) => !stored.has(s.id));
      if (fresh.length) {
        await tx.insert(transcriptSegments).values(
          fresh.map((s) => ({ sessionId, localId: s.id, participantLocalId: s.participantId, idx: s.index, timestampMs: s.timestamp, text: s.text })),
        );
      }
      for (const d of state.discrepancies) {
        const row = {
          key: d.key,
          category: d.category,
          title: d.title,
          description: d.description,
          evidence: { statements: d.statements, codeRefs: d.codeRefs },
          interpretations: d.interpretations,
          impactScore: d.impactScore,
          confidence: d.confidence,
          status: d.status,
          visibility: d.visibility,
          updatedAt: new Date(),
        };
        await tx
          .insert(discrepancies)
          .values({ sessionId, localId: d.id, ...row })
          .onConflictDoUpdate({ target: [discrepancies.sessionId, discrepancies.localId], set: row });
      }
      for (const c of state.clarifications) {
        const row = {
          discrepancyLocalId: c.discrepancyId,
          question: c.question,
          format: c.format,
          purpose: c.purpose,
          targetedParticipantLocalId: c.targetedParticipantId,
          response: c.responses,
          resolution: state.discrepancies.find((d) => d.id === c.discrepancyId)?.resolution?.summary ?? null,
          confirmationStatus: c.confirmationStatus,
        };
        await tx
          .insert(clarifications)
          .values({ sessionId, localId: c.id, ...row })
          .onConflictDoUpdate({ target: [clarifications.sessionId, clarifications.localId], set: row });
      }
      for (const r of state.requirements) {
        const row = {
          lineageId: r.lineageId,
          description: r.description,
          status: r.status,
          confirmation: r.confirmation,
          evidence: r.evidence,
          confirmedBy: r.confirmedBy,
          version: r.version,
          supersedes: r.supersedes,
          discrepancyLocalId: r.discrepancyId,
          acceptanceCriteria: r.acceptanceCriteria,
        };
        await tx
          .insert(requirements)
          .values({ sessionId, localId: r.id, ...row })
          .onConflictDoUpdate({ target: [requirements.sessionId, requirements.localId], set: row });
      }
    });
  }

  /** Deletes the session, its transcript and everything derived from it (cascade). */
  async deleteSession(id: string) {
    await this.db.delete(meetingSessions).where(and(eq(meetingSessions.id, id), eq(meetingSessions.workspaceId, this.workspaceId)));
  }

  /** Remove transcript text past the workspace's retention period (derived state is kept). */
  async purgeExpiredTranscripts(now = new Date()) {
    const ws = await this.workspace();
    if (!ws.transcriptRetentionDays) return 0;
    const cutoff = new Date(now.getTime() - ws.transcriptRetentionDays * 86_400_000);
    const old = await this.db
      .select({ id: meetingSessions.id })
      .from(meetingSessions)
      .where(and(eq(meetingSessions.workspaceId, this.workspaceId), lt(meetingSessions.startedAt, cutoff)));
    if (old.length === 0) return 0;
    const deleted = await this.db
      .delete(transcriptSegments)
      .where(inArray(transcriptSegments.sessionId, old.map((o) => o.id)))
      .returning({ id: transcriptSegments.id });
    return deleted.length;
  }

  // ---------------- dashboard

  async dashboardCounts() {
    const rows = await this.db
      .select({ status: discrepancies.status, visibility: discrepancies.visibility, n: sql<number>`count(*)::int` })
      .from(discrepancies)
      .innerJoin(meetingSessions, eq(discrepancies.sessionId, meetingSessions.id))
      .where(eq(meetingSessions.workspaceId, this.workspaceId))
      .groupBy(discrepancies.status, discrepancies.visibility);
    const open = rows
      .filter((r) => !['resolved', 'dismissed'].includes(r.status) && r.visibility !== 'hidden')
      .reduce((s, r) => s + r.n, 0);
    const resolved = rows.filter((r) => r.status === 'resolved' && r.visibility !== 'hidden').reduce((s, r) => s + r.n, 0);
    return { open, resolved };
  }

  // ---------------- usage & budget

  async recordUsage(u: UsageRecord & { sessionDbId: string | null }) {
    await this.db.insert(aiUsage).values({
      workspaceId: this.workspaceId,
      sessionId: u.sessionDbId,
      model: u.model,
      operation: u.operation,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estimatedCost: u.estimatedCostUsd,
    });
  }

  async spentThisMonthUsd(): Promise<number> {
    const [r] = await this.db
      .select({ total: sum(aiUsage.estimatedCost) })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, this.workspaceId), gte(aiUsage.createdAt, monthStart())));
    return Number(r?.total ?? 0);
  }

  usageRows(limit = 500) {
    return this.db.select().from(aiUsage).where(eq(aiUsage.workspaceId, this.workspaceId)).orderBy(desc(aiUsage.createdAt)).limit(limit);
  }

  usageSink(sessionDbId: string): UsageSink {
    return {
      record: (u) => this.recordUsage({ ...u, sessionDbId }),
      spentUsd: () => this.spentThisMonthUsd(),
    };
  }
}
