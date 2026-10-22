import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  ParticipantRole,
  pricesFrom,
  sessionMetrics,
  buildSummary,
  parseTranscript,
  recordDrafts,
  summaryToMarkdown,
  type EngineEvent,
  type SessionState,
} from '@uc/core';
import { CASES, SAMPLE_REPOS, SEEDED_DEMO, SEEDED_DEMO_RESOLUTION, type RepoName } from '@uc/fixtures';
import { recordLabel } from '@uc/db';
import { recordsToMarkdown } from './export';
import { HttpError, type Services, type SessionSnapshot } from './services';

const SegmentBody = z.object({
  speaker: z.string().trim().min(1).max(80),
  role: ParticipantRole.optional(),
  text: z.string().trim().min(1).max(4000),
  timestamp: z.number().int().nonnegative().optional(),
  externalId: z.string().trim().min(1).max(128).optional(),
});

const SessionBody = z.object({
  title: z.string().trim().min(1).max(200),
  repositoryId: z.string().uuid().nullable(),
  featureDescription: z.string().trim().max(2000).nullish(),
  githubIssueReference: z.string().trim().max(200).nullish(),
  consentConfirmed: z.literal(true, { error: 'Participants must be told the discussion is transcribed and analyzed' }),
  priorDecisions: z.array(z.object({ id: z.string().max(60), description: z.string().max(500), source: z.string().max(100) })).max(20).optional(),
  includeRecords: z.boolean().optional(),
});

const ActionBody = z.object({ action: z.enum(['ask_now', 'dismiss', 'save_for_later', 'restore', 'mark_useful', 'mark_not_useful']) });
const ReplayBody = z.object({
  text: z.string().min(1).max(200_000),
  speed: z.number().min(0.25).max(50).default(4),
  paused: z.boolean().optional(),
  force: z.boolean().optional(),
});
const ReplayControlBody = z
  .object({ action: z.enum(['pause', 'resume', 'step', 'stop']).optional(), speed: z.number().min(0.25).max(50).optional() })
  .refine((b) => b.action || b.speed !== undefined, 'Provide an action or a speed');
const ResponseBody = z.object({
  participantId: z.string().min(1),
  interpretationId: z.string().nullish(),
  text: z.string().trim().max(2000).default(''),
});

/** Events the UI cares about, without repeating the full objects (the snapshot carries those). */
function eventSummary(events: EngineEvent[]) {
  return events
    .filter((e) => e.type !== 'context_retrieved')
    .map((e) => {
      switch (e.type) {
        case 'segment_added':
          return { type: e.type, id: e.segment.id };
        case 'discrepancy_created':
        case 'discrepancy_updated':
          return { type: e.type, id: e.discrepancy.id, status: e.discrepancy.status, note: 'note' in e ? e.note : undefined };
        case 'clarification_created':
        case 'clarification_updated':
          return { type: e.type, id: e.clarification.id };
        case 'requirement_recorded':
          return { type: e.type, id: e.requirement.id };
        default:
          return e;
      }
    });
}

export function createApp(services: Services, opts: { webOrigin?: string } = {}) {
  const app = new Hono();
  /** What the UI renders: engine state plus live replay progress and meeting metrics. */
  const view = (s: SessionSnapshot) => ({
    state: s.state,
    segments: s.segments,
    status: s.status,
    replay: services.replays.status(s.state.sessionId),
    metrics: sessionMetrics(s.state, s.segments),
  });
  const origin = opts.webOrigin ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000';

  app.use('*', cors({ origin: [origin, 'http://127.0.0.1:3000'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    // Log the message only: request bodies may contain transcripts or code.
    console.error(`[api] ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json({ error: 'Internal error' }, 500);
  });

  const json = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    return schema.parse(body);
  };

  app.get('/health', (c) => c.json({ ok: true }));

  // ---------------- overview

  app.get('/api/dashboard', async (c) => {
    const [repos, sessions, counts, spent, ws, records] = await Promise.all([
      services.store.listRepositories(),
      services.store.listSessions(10),
      services.store.dashboardCounts(),
      services.store.spentThisMonthUsd(),
      services.store.workspace(),
      services.store.records.list({ status: 'active' }),
    ]);
    return c.json({
      analyzer: services.analyzerMode,
      repos,
      sessions: sessions.map(({ state, ...s }) => ({
        ...s,
        segmentCount: (state as { metrics?: { segmentsSeen: number } } | null)?.metrics?.segmentsSeen ?? 0,
        live: ((state as { discrepancies?: { visibility: string; status: string }[] } | null)?.discrepancies ?? []).filter(
          (d) => d.visibility !== 'hidden' && !['resolved', 'dismissed'].includes(d.status),
        ).length,
      })),
      counts: { ...counts, activeRequirements: records.length },
      budget: { spentUsd: spent, limitUsd: ws.monthlyBudgetUsd },
      settings: { transcriptRetentionDays: ws.transcriptRetentionDays, monthlyBudgetUsd: ws.monthlyBudgetUsd },
    });
  });

  app.get('/api/samples', (c) =>
    c.json({
      repos: Object.entries(SAMPLE_REPOS).map(([key, v]) => ({ key, ...v })),
      transcripts: CASES.map((x) => ({ id: x.id, title: x.title, repo: x.repo, featureDescription: x.featureDescription ?? '', transcript: x.transcript, priorDecisions: x.priorDecisions ?? [] })),
      demo: { id: SEEDED_DEMO.id, resolution: SEEDED_DEMO_RESOLUTION },
    }),
  );

  app.patch('/api/settings', async (c) => {
    const body = await json(c, z.object({ monthlyBudgetUsd: z.number().min(0).max(10_000).optional(), transcriptRetentionDays: z.number().int().min(1).max(3650).nullable().optional() }));
    await services.store.updateSettings(body);
    const purged = await services.store.purgeExpiredTranscripts();
    return c.json({ ok: true, purgedSegments: purged });
  });

  // ---------------- repositories

  app.get('/api/repos', async (c) => c.json(await services.store.listRepositories()));

  app.post('/api/repos/sample', async (c) => {
    const { sampleKey } = await json(c, z.object({ sampleKey: z.enum(Object.keys(SAMPLE_REPOS) as [RepoName, ...RepoName[]]) }));
    return c.json(await services.addSampleRepository(sampleKey), 201);
  });

  app.post('/api/repos/:id/index', async (c) => {
    const repo = await services.store.getRepository(c.req.param('id'));
    if (!repo) throw new HttpError(404, 'Repository not found');
    void services.indexRepository(repo.id).catch(() => undefined);
    return c.json({ ok: true }, 202);
  });

  app.delete('/api/repos/:id', async (c) => {
    await services.store.deleteRepository(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/github/status', (c) =>
    c.json({
      configured: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
      message: 'GitHub App integration arrives in Phase 3. It will use installation tokens with read-only Contents, Metadata and Issues permissions.',
    }),
  );

  // ---------------- sessions

  app.post('/api/sessions', async (c) => {
    const body = await json(c, SessionBody);
    const row = await services.createSession({ ...body, consentConfirmed: true });
    return c.json({ id: row.id }, 201);
  });

  /** One click: index the sample repo and open a session for the seeded scenario. */
  app.post('/api/demo', async (c) => {
    const repo = await services.ensureSampleIndexed('approvals');
    const row = await services.createSession({
      title: 'Demo: undo an approval',
      repositoryId: repo.id,
      featureDescription: SEEDED_DEMO.featureDescription,
      consentConfirmed: true,
    });
    return c.json({ id: row.id }, 201);
  });

  app.get('/api/sessions', async (c) => c.json((await services.store.listSessions(50)).map(({ state: _state, ...s }) => s)));

  app.get('/api/sessions/:id', async (c) => {
    const s = await services.snapshot(c.req.param('id'));
    const repo = s.row.repositoryId ? await services.store.getRepository(s.row.repositoryId) : null;
    const { state: _state, ...session } = s.row;
    return c.json({ session, repo: repo && { id: repo.id, name: repo.name, indexedCommitSha: repo.indexedCommitSha }, ...view(s) });
  });

  /** Mode B — live transcript ingestion: one speaker-labeled segment at a time. */
  app.post('/api/sessions/:id/segments', async (c) => {
    const seg = await json(c, SegmentBody);
    const { events, snapshot } = await services.run(c.req.param('id'), (engine) => engine.ingest(seg));
    return c.json({ events: eventSummary(events), ...view(snapshot) });
  });

  /** Mode A — upload a whole transcript; processed incrementally, segment by segment. */
  app.post('/api/sessions/:id/transcript', async (c) => {
    const { text } = await json(c, z.object({ text: z.string().min(1).max(200_000) }));
    const segments = parseTranscript(text);
    if (segments.length === 0) throw new HttpError(422, 'No "Speaker: text" lines found');
    const { events, snapshot } = await services.run(c.req.param('id'), async (engine) => {
      const all: EngineEvent[] = [];
      for (const s of segments) all.push(...(await engine.ingest(s)));
      return all;
    });
    return c.json({ events: eventSummary(events), ...view(snapshot) });
  });

  /** Server-side replay: simulate a live meeting at adjustable speed; every viewer sees it over SSE. */
  app.post('/api/sessions/:id/replay', async (c) => {
    const body = await json(c, ReplayBody);
    return c.json(await services.replays.start(c.req.param('id'), body.text, body), 202);
  });

  app.post('/api/sessions/:id/replay/control', async (c) => {
    const body = await json(c, ReplayControlBody);
    return c.json(services.replays.control(c.req.param('id'), body.action ?? null, body.speed));
  });

  app.get('/api/sessions/:id/metrics', async (c) => {
    const s = await services.snapshot(c.req.param('id'));
    return c.json(sessionMetrics(s.state, s.segments));
  });

  app.get('/api/sessions/:id/stream', async (c) => {
    const id = c.req.param('id');
    const initial = await services.snapshot(id);
    return streamSSE(c, async (stream) => {
      let open = true;
      const queue: string[] = [JSON.stringify({ ...view(initial), events: [] })];
      let wake: (() => void) | null = null;
      const unsubscribe = services.subscribe(id, (snap, events) => {
        queue.push(JSON.stringify({ ...view(snap), events: eventSummary(events) }));
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      while (open) {
        while (queue.length) await stream.writeSSE({ event: 'state', data: queue.shift()! });
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000);
        });
        wake = null;
        if (open && queue.length === 0) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.post('/api/sessions/:id/discrepancies/:did/actions', async (c) => {
    const { action } = await json(c, ActionBody);
    const { snapshot } = await services.run(c.req.param('id'), (engine) => {
      engine.discrepancy(c.req.param('did'));
      return engine.act(c.req.param('did'), action);
    });
    return c.json(view(snapshot));
  });

  app.post('/api/sessions/:id/clarifications/:cid/responses', async (c) => {
    const body = await json(c, ResponseBody);
    const { snapshot } = await services.run(c.req.param('id'), async (engine) => {
      try {
        return await engine.respond(c.req.param('cid'), body.participantId, { interpretationId: body.interpretationId ?? null, text: body.text });
      } catch (err) {
        throw new HttpError(422, (err as Error).message);
      }
    });
    return c.json(view(snapshot));
  });

  app.post('/api/sessions/:id/end', async (c) => {
    services.replays.stop(c.req.param('id'));
    const id = c.req.param('id');
    const { snapshot } = await services.run(id, (engine) => engine.finalize(), { ended: true });
    // Confirmed decisions become durable requirement records (once per session).
    const published = await services.store.records.publishSession(id, recordDrafts(snapshot.state));
    return c.json({ ...view(snapshot), published });
  });

  app.get('/api/sessions/:id/summary', async (c) => {
    const s = await services.snapshot(c.req.param('id'));
    const summary = buildSummary(s.state);
    return c.json({
      summary,
      markdown: summaryToMarkdown(summary, { commitSha: s.state.commitSha }),
      participants: s.state.participants,
      records: await services.store.records.fromSession(s.row.id),
    });
  });

  // ---------------- requirement records

  const RecordFilter = z.object({ status: z.enum(['active', 'retired']).optional(), repositoryId: z.string().uuid().optional() });

  app.get('/api/requirements', async (c) => {
    const filter = RecordFilter.parse({ status: c.req.query('status') || undefined, repositoryId: c.req.query('repositoryId') || undefined });
    const repos = await services.store.listRepositories();
    const rows = await services.store.records.list(filter);
    return c.json(
      rows.map(({ record, current }) => ({
        ...record,
        label: recordLabel(record),
        repositoryName: repos.find((r) => r.id === record.repositoryId)?.name ?? null,
        current,
      })),
    );
  });

  /** Local download of records as Markdown or JSON (no external service). */
  app.get('/api/requirements/export', async (c) => {
    const format = z.enum(['md', 'json']).parse(c.req.query('format') ?? 'md');
    const filter = RecordFilter.parse({ status: c.req.query('status') || undefined, repositoryId: c.req.query('repositoryId') || undefined });
    const rows = await services.store.records.list(filter);
    const items = (await Promise.all(rows.map((r) => services.store.records.get(r.record.id)))).filter((x): x is NonNullable<typeof x> => x !== null);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      c.header('content-disposition', `attachment; filename="requirements-${stamp}.json"`);
      return c.json(items.map(({ record, versions }) => ({ label: recordLabel(record), ...record, versions })));
    }
    c.header('content-type', 'text/markdown; charset=utf-8');
    c.header('content-disposition', `attachment; filename="requirements-${stamp}.md"`);
    return c.body(recordsToMarkdown(items, { history: c.req.query('history') !== 'false' }));
  });

  app.get('/api/requirements/:id', async (c) => {
    const r = await services.store.records.get(c.req.param('id'));
    if (!r) throw new HttpError(404, 'Requirement not found');
    const repo = r.record.repositoryId ? await services.store.getRepository(r.record.repositoryId) : null;
    return c.json({ ...r, label: recordLabel(r.record), repositoryName: repo?.name ?? null });
  });

  app.post('/api/requirements/:id/status', async (c) => {
    const body = await json(c, z.object({ status: z.enum(['active', 'retired']), reason: z.string().trim().max(500).optional() }));
    const r = await services.store.records.setStatus(c.req.param('id'), body.status, body.reason);
    if (!r) throw new HttpError(404, 'Requirement not found');
    return c.json({ ...r, label: recordLabel(r) });
  });

  app.delete('/api/sessions/:id', async (c) => {
    await services.deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---------------- cost

  app.get('/api/usage', async (c) => {
    const [rows, sessions, spent, ws] = await Promise.all([
      services.store.usageRows(1000),
      services.store.listSessions(50),
      services.store.spentThisMonthUsd(),
      services.store.workspace(),
    ]);
    const bySession = await Promise.all(
      sessions.map(async (s) => {
        const r = rows.filter((u) => u.sessionId === s.id);
        const st = s.state as SessionState | null;
        const m = st ? sessionMetrics(st, await services.store.loadSegments(s.id)) : null;
        const surfacedList = st?.discrepancies.filter((d) => d.surfacedAtSegmentIndex !== null) ?? [];
        const confirmed = surfacedList.filter((d) => d.history.some((h) => h.status === 'different_expectations_confirmed')).length;
        const cost = r.reduce((x, u) => x + u.estimatedCost, 0);
        const hours = m && m.meetingDurationMs > 0 ? m.meetingDurationMs / 3_600_000 : null;
        return {
          id: s.id,
          title: s.title,
          analyzer: s.analyzer,
          calls: r.length,
          inputTokens: r.reduce((x, u) => x + u.inputTokens, 0),
          outputTokens: r.reduce((x, u) => x + u.outputTokens, 0),
          costUsd: cost,
          metrics: m,
          confirmedMisunderstandings: confirmed,
          costPerMeetingHour: hours ? cost / hours : null,
          costPerSuggestion: surfacedList.length ? cost / surfacedList.length : null,
          costPerUsefulSuggestion: (() => {
            const useful = surfacedList.filter((d) => d.feedback === 'useful').length;
            return useful ? cost / useful : null;
          })(),
          costPerConfirmedMisunderstanding: confirmed ? cost / confirmed : null,
        };
      }),
    );
    const byOperation = Object.values(
      rows.reduce<Record<string, { operation: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>>((acc, u) => {
        const k = `${u.operation}:${u.model}`;
        acc[k] ??= { operation: u.operation, model: u.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        acc[k].calls++;
        acc[k].inputTokens += u.inputTokens;
        acc[k].outputTokens += u.outputTokens;
        acc[k].costUsd += u.estimatedCost;
        return acc;
      }, {}),
    );
    return c.json({ analyzer: services.analyzerMode, spentUsd: spent, limitUsd: ws.monthlyBudgetUsd, prices: pricesFrom(process.env.UC_MODEL_PRICES_JSON), bySession, byOperation });
  });

  return app;
}
