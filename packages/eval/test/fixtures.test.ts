import { buildSummary, parseTranscript, summaryToMarkdown } from '@uc/core';
import { CASES, SEEDED_DEMO, SEEDED_DEMO_RESOLUTION, getCase } from '@uc/fixtures';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/metrics';
import { participantId, runCase, surfaced } from '../src/runner';

const live = (r: Awaited<ReturnType<typeof runCase>>) => surfaced(r.engine);

describe('Fixture 1: direct disagreement', () => {
  it('surfaces a direct disagreement with both quotations and the related code', async () => {
    const r = await runCase(getCase('f1-direct-disagreement'));
    const [d, ...rest] = live(r);
    expect(rest).toHaveLength(0);
    expect(d!.category).toBe('direct_disagreement');
    expect(d!.status).toBe('different_expectations_confirmed');
    const quotes = d!.statements.map((s) => s.quote).join(' | ');
    expect(quotes).toContain('should receive an email');
    expect(quotes).toContain("We don't need an email notification");
    expect(d!.codeRefs[0]).toMatchObject({ filePath: 'src/applications/approve.ts', startLine: 23 });
  });
});

describe('Fixture 2: hidden assumption', () => {
  it('flags reuse of authenticate(), which elevates staff accounts to admin, with code evidence', async () => {
    const r = await runCase(getCase('f2-hidden-assumption'));
    const [d] = live(r);
    expect(d!.category).toBe('hidden_assumption');
    expect(d!.codeRefs[0]).toMatchObject({ filePath: 'src/auth/authenticate.ts', startLine: 19, symbolName: 'authenticate' });
    expect(d!.description).toMatch(/admin privileges/);
    const q = r.engine.state.clarifications.find((c) => c.discrepancyId === d!.id)!;
    expect(q.question).toMatch(/partner logins/);
  });
});

describe('Fixture 3: codebase conflict', () => {
  it('reports a potential conflict with source references, not a guaranteed defect', async () => {
    const r = await runCase(getCase('f3-codebase-conflict'));
    const [d, ...rest] = live(r);
    expect(rest).toHaveLength(0);
    expect(d!.category).toBe('codebase_conflict');
    expect(d!.description).toMatch(/potential conflict, not a confirmed defect/);
    expect(d!.codeRefs.map((c) => `${c.filePath}:${c.startLine}`)).toContain('src/applications/approve.ts:22');
    // "Yes, I can add that filter" answers a different question and must not be read as an answer here.
    expect(d!.positions.filter((p) => p.provenance !== 'inferred')).toHaveLength(0);
  });
});

describe('Fixture 4: missing specification', () => {
  it('asks one focused question about the most consequential unspecified behavior', async () => {
    const r = await runCase(getCase('f4-missing-specification'));
    const all = live(r);
    expect(all).toHaveLength(1);
    expect(all[0]!.category).toBe('missing_specification');
    const qs = r.engine.state.clarifications.filter((c) => c.discrepancyId === all[0]!.id);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.question).toBe("When an approval is undone, should the applicant's access also be revoked?");
  });
});

describe('Fixture 5: false alignment', () => {
  it('suspects false alignment without claiming disagreement, and asks each participant privately', async () => {
    const r = await runCase(getCase('f5-false-alignment'));
    const [d] = live(r);
    expect(d!.category).toBe('false_alignment');
    expect(d!.status).toBe('suggested');
    expect(`${d!.title} ${d!.description}`).not.toMatch(/disagree/i);
    const checks = r.engine.state.clarifications.filter((c) => c.discrepancyId === d!.id && c.purpose === 'private_check');
    expect(checks.map((c) => c.targetedParticipantId).sort()).toEqual([participantId(r.engine, 'Dana'), participantId(r.engine, 'Lee')].sort());
    expect(checks.every((c) => c.private && c.format === 'scenario')).toBe(true);
    // The scenario must not reveal a preferred answer.
    expect(checks[0]!.question).toMatch(/\?$/);
    expect(checks[0]!.question).not.toMatch(/should be revoked|must/i);
  });

  it('surfaces the difference only after independent answers differ, then tracks the resolution', async () => {
    const r = await runCase(getCase('f5-false-alignment'));
    const d = live(r)[0]!;
    const dana = participantId(r.engine, 'Dana');
    const lee = participantId(r.engine, 'Lee');
    const check = (pid: string) => r.engine.state.clarifications.find((c) => c.discrepancyId === d.id && c.targetedParticipantId === pid)!;

    await r.engine.respond(check(dana).id, dana, { text: "No — once it's reversed they shouldn't be able to get in anymore." });
    expect(d.status).toBe('suggested'); // one independent answer proves nothing yet
    await r.engine.respond(check(lee).id, lee, { text: "Yes, they'd keep their access, I'm only changing the status." });
    expect(d.status).toBe('different_expectations_confirmed');
    expect(r.engine.state.clarifications.some((c) => c.discrepancyId === d.id && c.purpose === 'surface_difference')).toBe(true);

    for (const seg of parseTranscript(`Lee (Engineer): Understood, reversing an approval will also revoke their access.
Dana (Product Manager): Yes, exactly.`)) {
      await r.engine.ingest(seg);
    }
    expect(d.status).toBe('resolved');
    const req = r.engine.state.requirements.find((x) => x.id === d.resolution!.requirementId)!;
    expect(req).toMatchObject({ status: 'confirmed', confirmation: 'clarified' });
    expect(req.confirmedBy.sort()).toEqual([dana, lee].sort());
    expect(req.description).toMatch(/revokes the access/);
  });

  it('identical answers establish agreement on that scenario only', async () => {
    const r = await runCase(getCase('f5-false-alignment'));
    const d = live(r)[0]!;
    for (const name of ['Dana', 'Lee']) {
      const pid = participantId(r.engine, name);
      const c = r.engine.state.clarifications.find((x) => x.discrepancyId === d.id && x.targetedParticipantId === pid)!;
      await r.engine.respond(c.id, pid, { text: 'No, they lose access.' });
    }
    expect(d.status).toBe('resolved');
    expect(d.history.some((h) => h.status === 'different_expectations_confirmed')).toBe(false);
    expect(d.notes.join(' ')).toMatch(/agreement on the scenario, not on every detail/);
  });

  it('leaves an ambiguous answer unresolved', async () => {
    const r = await runCase(getCase('f5-false-alignment'));
    const d = live(r)[0]!;
    const dana = participantId(r.engine, 'Dana');
    const c = r.engine.state.clarifications.find((x) => x.discrepancyId === d.id && x.targetedParticipantId === dana)!;
    await r.engine.respond(c.id, dana, { text: 'Hmm, it depends on the situation.' });
    expect(c.confirmationStatus).toBe('ambiguous');
    expect(d.status).toBe('suggested');
  });
});

describe('Seeded Phase 1 milestone', () => {
  it('identifies unspecified access revocation and suggests a scenario check, end to end', async () => {
    const r = await runCase(SEEDED_DEMO);
    const [d, ...rest] = live(r);
    expect(rest).toHaveLength(0);
    expect(d!.category).toBe('false_alignment');
    expect(d!.key).toBe('effect:approveApplication:grantAccess');
    expect(d!.codeRefs[0]).toMatchObject({ filePath: 'src/applications/approve.ts', startLine: 22, commitSha: r.engine.state.commitSha });
    const scenario = r.engine.state.clarifications.find((c) => c.discrepancyId === d!.id && c.purpose === 'private_check')!;
    expect(scenario.scenario).toMatch(/approved yesterday/);
    expect(scenario.question).toBe('Can the applicant still use that access?');

    const priya = participantId(r.engine, 'Priya');
    const sam = participantId(r.engine, 'Sam');
    for (const c of r.engine.state.clarifications.filter((x) => x.purpose === 'private_check')) {
      await r.engine.respond(c.id, c.targetedParticipantId!, { text: c.targetedParticipantId === priya ? 'No, they lose access.' : 'Yes, they keep it.' });
    }
    expect(d!.status).toBe('different_expectations_confirmed');
    for (const seg of parseTranscript(SEEDED_DEMO_RESOLUTION)) await r.engine.ingest(seg);
    expect(d!.status).toBe('resolved');
    expect(d!.resolution!.confirmedBy.sort()).toEqual([priya, sam].sort());

    await r.engine.finalize();
    const md = summaryToMarkdown(buildSummary(r.engine.state));
    expect(md).toContain('Undoing the approval also revokes the access');
    expect(md).toContain('initially expected different behavior');
    expect(md).toContain('does not guarantee');
    expect(md).toContain('`src/applications/approve.ts:22`');
  });
});

describe('Edge cases', () => {
  it('no relevant code: stays silent and marks context insufficient', async () => {
    const r = await runCase(getCase('e1-no-relevant-code'));
    expect(live(r)).toHaveLength(0);
    expect(r.engine.state.contextStatus).toBe('insufficient');
    expect(r.engine.state.discrepancies.flatMap((d) => d.codeRefs)).toHaveLength(0);
  });

  it('ambiguous speaker: an unattributed "sounds good" is not treated as alignment', async () => {
    const r = await runCase(getCase('e2-ambiguous-speaker'));
    expect(r.engine.state.discrepancies.some((d) => d.category === 'false_alignment')).toBe(false);
    expect(r.engine.state.participants.find((p) => p.displayName === 'Unknown')!.ambiguous).toBe(true);
  });

  it('genuine agreement: a proposal covering every side effect produces no suggestion', async () => {
    const r = await runCase(getCase('e3-genuine-agreement'));
    expect(live(r)).toHaveLength(0);
  });

  it('duplicates: repeating the proposal does not create a second suggestion', async () => {
    const r = await runCase(getCase('e4-duplicates'));
    expect(r.engine.state.discrepancies.filter((d) => d.key === 'effect:approveApplication:grantAccess')).toHaveLength(1);
    expect(live(r)).toHaveLength(1);
    expect(r.engine.state.metrics.duplicatesSuppressed).toBeGreaterThan(0);
  });

  it('resolved naturally later in the transcript', async () => {
    const r = await runCase(getCase('e5-resolved-naturally'));
    const d = r.engine.state.discrepancies.find((x) => x.key === 'effect:approveApplication:grantAccess')!;
    expect(d.status).toBe('resolved');
    expect(d.resolution!.interpretationId).toBe('B');
    expect(live(r)).toHaveLength(1); // the lower-consequence email follow-up waits for the summary
  });

  it('participants changing their minds create a new requirement version', async () => {
    const r = await runCase(getCase('e6-changed-minds'));
    const d = r.engine.state.discrepancies.find((x) => x.key === 'effect:approveApplication:grantAccess')!;
    expect(d.status).toBe('resolved');
    expect(d.resolution!.interpretationId).toBe('A');
    const lineage = r.engine.state.requirements.filter((x) => x.discrepancyId === d.id).sort((a, b) => a.version - b.version);
    expect(lineage.map((x) => [x.version, x.status])).toEqual([
      [1, 'superseded'],
      [2, 'superseded'],
      [3, 'confirmed'],
    ]);
    expect(lineage[2]!.supersedes).toBe(lineage[1]!.id);
    expect(d.history.some((h) => h.status === 'resolution_proposed' && /changed position/.test(h.note))).toBe(true);
  });

  it('conflicting historical decision is surfaced as a disagreement with the earlier record', async () => {
    const r = await runCase(getCase('e7-historical-conflict'));
    const d = live(r).find((x) => x.category === 'direct_disagreement')!;
    expect(d.title).toMatch(/earlier decision/);
    expect(d.relevantParticipantIds).toContain('prior:ISSUE-42');
    expect(d.history.some((h) => h.status === 'different_expectations_confirmed')).toBe(true);
  });

  it('unrelated conversation produces no suggestions and skips nothing it should analyze', async () => {
    const r = await runCase(getCase('e8-unrelated'));
    expect(r.engine.state.discrepancies).toHaveLength(0);
  });

  it('unraised follow-ups become open questions at the end of the meeting', async () => {
    const r = await runCase(getCase('e5-resolved-naturally'), { finalize: true });
    const summary = buildSummary(r.engine.state);
    expect(summary.openQuestions.map((q) => q.text)).toContain('When an approval is undone, should the applicant be notified?');
  });
});

describe('Held-out billing conversations', () => {
  it('cancelling a refund: suspects false alignment about store credit', async () => {
    const r = await runCase(getCase('h1-cancel-refund'));
    const [d] = live(r);
    expect(d!.category).toBe('false_alignment');
    expect(d!.key).toBe('effect:refundInvoice:issueStoreCredit');
    const check = r.engine.state.clarifications.find((c) => c.discrepancyId === d!.id && c.purpose === 'private_check')!;
    expect(check.question).toBe('Does the customer keep the store credit?');
  });

  it('reusing sendReceipt: flags the accounting webhook side effect', async () => {
    const r = await runCase(getCase('h2-reuse-receipt'));
    const [d] = live(r);
    expect(d!.category).toBe('hidden_assumption');
    expect(d!.key).toBe('reuse:sendReceipt:postToAccountingWebhook');
  });
});

describe('Evaluation over all labeled fixtures', () => {
  it('meets the bar: no false positives, nothing missed, every code reference valid', async () => {
    const report = await evaluate(CASES);
    const failures = report.cases.filter((c) => c.missed || c.falsePositives || c.forbiddenSurfaced.length);
    expect(failures.map((f) => `${f.id}: expected ${f.expected} got ${f.actual}`)).toEqual([]);
    expect(report.evidenceValidity).toBe(1);
  });
});

describe('earlier requirement records', () => {
  it('do not silence a concern the meeting has not addressed, but are cited in it', async () => {
    const r = await runCase({
      ...SEEDED_DEMO,
      priorDecisions: [{ id: 'rec-1', description: 'Undoing an approval also revokes the applicant’s portal access.', source: 'REQ-7 v2' }],
    });
    const [d, ...rest] = live(r);
    expect(rest).toHaveLength(0);
    expect(d!.key).toBe('effect:approveApplication:grantAccess');
    expect(d!.description).toContain('An earlier decision covers this — REQ-7 v2');
  });
});
