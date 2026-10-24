import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { PriorDecision, RecordDraft } from '@uc/core';
import type { Db } from './client';
import { meetingSessions, requirementRecords, requirementVersions } from './schema';

export type RecordRow = typeof requirementRecords.$inferSelect;
export type VersionRow = typeof requirementVersions.$inferSelect;

export interface PublishedRecord {
  recordId: string;
  number: number;
  version: number;
  outcome: 'created' | 'superseded' | 'reaffirmed';
  title: string;
}

export const recordLabel = (r: { number: number }) => `REQ-${r.number}`;

/**
 * Versioned, workspace-scoped requirement records. Every query is bound to the workspace; versions
 * are append-only.
 */
export class RecordStore {
  constructor(
    private db: Db,
    private workspaceId: string,
  ) {}

  private scope(id: string) {
    return and(eq(requirementRecords.id, id), eq(requirementRecords.workspaceId, this.workspaceId));
  }

  /**
   * Write a session's confirmed decisions to records, exactly once per session. A decision that
   * settled a conflict with an earlier record either adds a version to it or reaffirms it.
   */
  async publishSession(sessionId: string, drafts: RecordDraft[]): Promise<PublishedRecord[]> {
    return this.db.transaction(async (tx) => {
      // Claim the session atomically so concurrent "end" calls cannot publish twice.
      const [session] = await tx
        .update(meetingSessions)
        .set({ recordsPublishedAt: new Date() })
        .where(and(eq(meetingSessions.id, sessionId), eq(meetingSessions.workspaceId, this.workspaceId), isNull(meetingSessions.recordsPublishedAt)))
        .returning();
      if (!session) return [];

      const out: PublishedRecord[] = [];
      const now = new Date();
      for (const d of drafts) {
        const version = {
          description: d.description,
          acceptanceCriteria: d.acceptanceCriteria,
          codeRefs: d.codeRefs,
          slackRefs: d.slackRefs,
          evidence: d.evidence,
          confirmedBy: d.confirmedBy,
          confirmation: d.confirmation,
          concern: d.concern,
          revisedInMeeting: d.revisedInMeeting,
          sessionId,
          sessionTitle: session.title,
        };
        const [prior] = d.priorRecord ? await tx.select().from(requirementRecords).where(this.scope(d.priorRecord.id)) : [];

        if (prior && d.priorRecord!.outcome === 'reaffirms') {
          await tx
            .update(requirementRecords)
            .set({
              lastConfirmedAt: now,
              updatedAt: now,
              status: 'active',
              reaffirmations: [...prior.reaffirmations, { sessionId, sessionTitle: session.title, at: now.toISOString(), confirmedBy: d.confirmedBy }],
            })
            .where(eq(requirementRecords.id, prior.id));
          out.push({ recordId: prior.id, number: prior.number, version: prior.currentVersion, outcome: 'reaffirmed', title: prior.title });
          continue;
        }

        if (prior) {
          const next = prior.currentVersion + 1;
          await tx.insert(requirementVersions).values({ recordId: prior.id, version: next, origin: 'supersedes', ...version });
          await tx
            .update(requirementRecords)
            .set({ currentVersion: next, title: d.title, status: 'active', retiredReason: null, lastConfirmedAt: now, updatedAt: now })
            .where(eq(requirementRecords.id, prior.id));
          out.push({ recordId: prior.id, number: prior.number, version: next, outcome: 'superseded', title: d.title });
          continue;
        }

        const [{ n } = { n: 0 }] = await tx
          .select({ n: max(requirementRecords.number) })
          .from(requirementRecords)
          .where(eq(requirementRecords.workspaceId, this.workspaceId));
        const [record] = await tx
          .insert(requirementRecords)
          .values({ workspaceId: this.workspaceId, repositoryId: session.repositoryId, number: (n ?? 0) + 1, title: d.title, lastConfirmedAt: now })
          .returning();
        await tx.insert(requirementVersions).values({ recordId: record!.id, version: 1, origin: 'created', ...version });
        out.push({ recordId: record!.id, number: record!.number, version: 1, outcome: 'created', title: d.title });
      }
      return out;
    });
  }

  list(filter: { status?: 'active' | 'retired'; repositoryId?: string } = {}) {
    return this.db
      .select({ record: requirementRecords, current: requirementVersions })
      .from(requirementRecords)
      .innerJoin(
        requirementVersions,
        and(eq(requirementVersions.recordId, requirementRecords.id), eq(requirementVersions.version, requirementRecords.currentVersion)),
      )
      .where(
        and(
          eq(requirementRecords.workspaceId, this.workspaceId),
          filter.status ? eq(requirementRecords.status, filter.status) : undefined,
          filter.repositoryId ? eq(requirementRecords.repositoryId, filter.repositoryId) : undefined,
        ),
      )
      .orderBy(desc(requirementRecords.updatedAt));
  }

  async get(id: string): Promise<{ record: RecordRow; versions: VersionRow[] } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [record] = await this.db.select().from(requirementRecords).where(this.scope(id));
    if (!record) return null;
    const versions = await this.db.select().from(requirementVersions).where(eq(requirementVersions.recordId, id)).orderBy(asc(requirementVersions.version));
    return { record, versions };
  }

  async setStatus(id: string, status: 'active' | 'retired', reason?: string) {
    const [r] = await this.db
      .update(requirementRecords)
      .set({ status, retiredReason: status === 'retired' ? (reason ?? null) : null, updatedAt: new Date() })
      .where(this.scope(id))
      .returning();
    return r ?? null;
  }

  /** Records published from a given session (for its summary page). */
  async fromSession(sessionId: string) {
    const rows = await this.db
      .select({ record: requirementRecords, version: requirementVersions.version })
      .from(requirementVersions)
      .innerJoin(requirementRecords, eq(requirementVersions.recordId, requirementRecords.id))
      .where(and(eq(requirementVersions.sessionId, sessionId), eq(requirementRecords.workspaceId, this.workspaceId)));
    const reaffirmed = (await this.list()).filter((r) => r.record.reaffirmations.some((a) => a.sessionId === sessionId));
    return [
      ...rows.map((r) => ({ recordId: r.record.id, number: r.record.number, title: r.record.title, version: r.version, outcome: r.version === 1 ? 'created' : 'superseded' })),
      ...reaffirmed.map((r) => ({ recordId: r.record.id, number: r.record.number, title: r.record.title, version: r.record.currentVersion, outcome: 'reaffirmed' })),
    ];
  }

  /** Active decisions for a repository, as prior decisions a new session is checked against. */
  async priorDecisionsFor(repositoryId: string, limit = 20): Promise<PriorDecision[]> {
    const rows = await this.list({ status: 'active', repositoryId });
    return rows.slice(0, limit).map(({ record, current }) => ({
      id: record.id,
      description: current.description,
      source: `${recordLabel(record)} v${record.currentVersion}`,
    }));
  }

  /** Strip transcript quotes that came from a deleted session; the agreed text itself stays. */
  async redactSession(sessionId: string) {
    const versions = await this.db
      .select({ id: requirementVersions.id })
      .from(requirementVersions)
      .innerJoin(requirementRecords, eq(requirementVersions.recordId, requirementRecords.id))
      .where(and(eq(requirementVersions.sessionId, sessionId), eq(requirementRecords.workspaceId, this.workspaceId)));
    if (versions.length) {
      await this.db
        .update(requirementVersions)
        .set({ evidence: [], evidenceRedacted: true })
        .where(inArray(requirementVersions.id, versions.map((v) => v.id)));
    }
    // Reaffirmation entries only hold names, but drop the dangling session link.
    await this.db.execute(sql`
      update requirement_records
      set reaffirmations = (
        select coalesce(jsonb_agg(case when e->>'sessionId' = ${sessionId} then e || '{"sessionId": null}'::jsonb else e end), '[]'::jsonb)
        from jsonb_array_elements(reaffirmations) e
      )
      where workspace_id = ${this.workspaceId} and reaffirmations @> ${JSON.stringify([{ sessionId }])}::jsonb`);
  }
}
