import type { DiscrepancyCategory, PriorDecision } from '@uc/core';

export type RepoName = 'approvals' | 'billing';

export interface FixtureCase {
  id: string;
  title: string;
  repo: RepoName | null;
  featureDescription?: string;
  priorDecisions?: PriorDecision[];
  /** Slack search results handed to the engine at session start (as if found by the prefetch). */
  slack?: { channelName: string; channelKind?: 'public' | 'private' | 'dm'; authorName: string; text: string }[];
  transcript: string;
  /**
   * Held-out cases use a different repository, domain, names and wording than the development cases.
   * No rule is keyed to their strings, but they were written alongside the rules — they test transfer
   * across domains, not blind generalization. Truly blind transcripts should be added by someone else.
   */
  heldOut?: boolean;
  /** Labeled expectation for evaluation: which categories should surface (empty = must stay silent). */
  expected: { surfaced: DiscrepancyCategory[]; notSurfaced?: DiscrepancyCategory[] };
}

export const SEEDED_DEMO: FixtureCase = {
  id: 'demo-undo-approval',
  title: 'Seeded demo: undo approval ("sounds good")',
  repo: 'approvals',
  featureDescription: 'Allow administrators to undo an approval',
  transcript: `Priya (PO): Admins need to be able to undo an approval when a reviewer approves the wrong application.
Sam (Developer): Easy enough, I'll just set the status back to pending.
Priya (PO): Sounds good.
Sam (Developer): Great, I'll pick it up this sprint.`,
  expected: { surfaced: ['false_alignment'], notSurfaced: ['direct_disagreement'] },
};

/** Follow-up lines for the seeded demo after the private checks reveal different expectations. */
export const SEEDED_DEMO_RESOLUTION = `Sam (Developer): Okay, then undoing an approval should also revoke their portal access.
Priya (PO): Yes, exactly.`;

export const CASES: FixtureCase[] = [
  SEEDED_DEMO,
  {
    id: 'f1-direct-disagreement',
    title: 'Fixture 1: direct disagreement about the approval email',
    repo: 'approvals',
    transcript: `Priya (PO): After an application is approved, the applicant should receive an email.
Sam (Developer): We don't need an email notification for approvals, they will see it in the portal.`,
    expected: { surfaced: ['direct_disagreement'] },
  },
  {
    id: 'f2-hidden-assumption',
    title: 'Fixture 2: reusing authentication that elevates staff to admin',
    repo: 'approvals',
    transcript: `Priya (PO): Partners need to sign in to the new partner portal.
Sam (Developer): I'll reuse the existing authentication system for partner logins.
Priya (PO): Great.`,
    expected: { surfaced: ['hidden_assumption'] },
  },
  {
    id: 'f3-codebase-conflict',
    title: 'Fixture 3: reverting approval by status alone',
    repo: 'approvals',
    transcript: `Priya (PO): Reviewers sometimes approve applications by mistake, so we want a way to revert an approval.
Sam (Developer): We'll update the status back to pending in the admin tool.
Priya (PO): Also, can we add a filter for pending applications on the dashboard?
Sam (Developer): Yes, I can add that filter.`,
    expected: { surfaced: ['codebase_conflict'] },
  },
  {
    id: 'f4-missing-specification',
    title: 'Fixture 4: undo approvals with unspecified access consequences',
    repo: 'approvals',
    transcript: `Priya (PO): Admins should be able to undo approvals from the review screen.
Alex (QA): Should the undo button ask for confirmation first?
Priya (PO): Yes, a simple confirmation dialog is fine.
Sam (Developer): I'll add the undo button next to the approve button.`,
    expected: { surfaced: ['missing_specification'] },
  },
  {
    id: 'f5-false-alignment',
    title: 'Fixture 5: "got it, that works" with different expectations',
    repo: 'approvals',
    transcript: `Dana (Product Manager): We need a way for administrators to reverse an approval if it was granted by mistake.
Lee (Engineer): Sure, I'll flip the application back to pending status.
Dana (Product Manager): Got it, that works.`,
    expected: { surfaced: ['false_alignment'] },
  },
  {
    id: 'e1-no-relevant-code',
    title: 'Edge: feature with no relevant code',
    repo: 'approvals',
    transcript: `Priya (PO): We should add CSV export to the reports page.
Sam (Developer): Sure, I'll add an export button that downloads the table.`,
    expected: { surfaced: [] },
  },
  {
    id: 'e2-ambiguous-speaker',
    title: 'Edge: agreement from an unattributed speaker',
    repo: 'approvals',
    transcript: `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Unknown: Sounds good.`,
    // The proposal still conflicts with the code; what must not happen is treating "Unknown"'s agreement as alignment.
    expected: { surfaced: ['codebase_conflict'], notSurfaced: ['false_alignment'] },
  },
  {
    id: 'e3-genuine-agreement',
    title: 'Edge: proposal covers every side effect, genuine agreement',
    repo: 'approvals',
    transcript: `Priya (PO): Admins should be able to undo an approval.
Sam (Developer): I'll set the status back to pending, revoke their portal access, and send them an email letting them know.
Priya (PO): Sounds good.`,
    expected: { surfaced: [] },
  },
  {
    id: 'e4-duplicates',
    title: 'Edge: the same proposal and agreement repeated',
    repo: 'approvals',
    transcript: `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.
Sam (Developer): Yeah, so status goes back to pending, that's the plan.
Priya (PO): Yep, sounds good.`,
    expected: { surfaced: ['false_alignment'] },
  },
  {
    id: 'e5-resolved-naturally',
    title: 'Edge: ambiguity resolved later in the conversation',
    repo: 'approvals',
    transcript: `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.
Sam (Developer): Oh, and we'd revoke their portal access as part of the undo too.
Priya (PO): Yes, definitely.`,
    expected: { surfaced: ['false_alignment'] },
  },
  {
    id: 'e6-changed-minds',
    title: 'Edge: participants change their minds after deciding',
    repo: 'approvals',
    transcript: `Priya (PO): Admins need to be able to undo an approval.
Sam (Developer): I'll just set the status back to pending.
Priya (PO): Sounds good.
Sam (Developer): Oh, and we'd revoke their portal access as part of the undo too.
Priya (PO): Yes, definitely.
Priya (PO): Actually, on second thought, let them keep access until the end of the day.
Sam (Developer): OK, fine, access stays until the end of the day then.`,
    expected: { surfaced: ['false_alignment'] },
  },
  {
    id: 'e7-historical-conflict',
    title: 'Edge: conflicts with an earlier recorded decision',
    repo: 'approvals',
    priorDecisions: [
      { id: 'ISSUE-42', description: 'Approved members must keep portal access for at least 30 days after approval.', source: 'issue #42' },
    ],
    transcript: `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`,
    expected: { surfaced: ['direct_disagreement'] },
  },
  {
    id: 's1-slack-decision-conflict',
    title: 'Slack: the call contradicts a decision made in a public channel',
    repo: 'approvals',
    slack: [{ channelName: 'approvals', authorName: 'Dana', text: 'Decision: approved members must keep portal access for at least 30 days after approval.' }],
    transcript: `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`,
    expected: { surfaced: ['direct_disagreement'] },
  },
  {
    id: 's2-slack-unrelated',
    title: 'Slack: unrelated chatter found by the search stays silent',
    repo: 'approvals',
    slack: [
      { channelName: 'random', authorName: 'Chris', text: 'Lunch after standup tomorrow? The game last night had a great finish.' },
      { channelName: 'general', authorName: 'Dana', text: 'Reminder: the office is closed on Friday.' },
    ],
    transcript: `Chris (Developer): Did anyone catch the game last night?
Priya (PO): Only the second half, it was a great finish.
Chris (Developer): We should grab lunch after standup tomorrow.`,
    expected: { surfaced: [] },
  },
  {
    id: 's3-slack-agrees',
    title: 'Slack: a Slack decision the call agrees with is not a conflict',
    repo: 'approvals',
    slack: [{ channelName: 'approvals', authorName: 'Dana', text: 'Agreed: when an admin undoes an approval, the member should lose portal access immediately.' }],
    transcript: `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`,
    expected: { surfaced: [], notSurfaced: ['direct_disagreement'] },
  },
  {
    id: 's4-slack-dm-conflict',
    title: 'Slack: the call contradicts a decision made in a DM',
    repo: 'approvals',
    slack: [{ channelName: 'U0PARTNER', channelKind: 'dm', authorName: 'Dana', text: 'Decision: approved members must keep portal access for at least 30 days after approval.' }],
    transcript: `Priya (PO): When an admin undoes an approval, the member should lose portal access immediately.
Sam (Developer): Okay, I'll revoke access as part of the undo.`,
    expected: { surfaced: ['direct_disagreement'] },
  },
  {
    id: 'e8-unrelated',
    title: 'Edge: unrelated conversation',
    repo: 'approvals',
    transcript: `Chris (Developer): Did anyone catch the game last night?
Priya (PO): Only the second half, it was a great finish.
Chris (Developer): We should grab lunch after standup tomorrow.`,
    expected: { surfaced: [] },
  },

  // ---------------- held-out: different repository, domain, names and wording ----------------
  {
    id: 'h1-cancel-refund',
    title: 'Held-out: cancelling a refund that issued store credit',
    repo: 'billing',
    heldOut: true,
    transcript: `Morgan (Support Lead): Agents keep refunding the wrong invoice, so we need a way to cancel a refund.
Jordan (Developer): Sure, I'll flip the invoice status back to paid.
Morgan (Support Lead): Works for me.`,
    expected: { surfaced: ['false_alignment'] },
  },
  {
    id: 'h2-reuse-receipt',
    title: 'Held-out: reusing sendReceipt (posts to accounting) for partial payments',
    repo: 'billing',
    heldOut: true,
    transcript: `Morgan (Support Lead): Customers who pay in installments should get a confirmation after each partial payment.
Jordan (Developer): I'll just reuse sendReceipt for partial payments.
Morgan (Support Lead): Perfect.`,
    expected: { surfaced: ['hidden_assumption'] },
  },
  {
    id: 'h3-unrelated',
    title: 'Held-out: small talk',
    repo: 'billing',
    heldOut: true,
    transcript: `Jordan (Developer): Is the office closed on Friday?
Morgan (Support Lead): I think so, there's a holiday.
Jordan (Developer): Nice, I'll plan to take a long weekend.`,
    expected: { surfaced: [] },
  },
  {
    id: 'h4-genuine-agreement',
    title: 'Held-out: harmless copy change, genuine agreement',
    repo: 'billing',
    heldOut: true,
    transcript: `Morgan (Support Lead): The receipt footer should say thanks for shopping with us instead of the current text.
Jordan (Developer): I'll update the footer text in renderReceiptFooter.
Morgan (Support Lead): Great, thanks.`,
    expected: { surfaced: [] },
  },
  {
    id: 'h5-disagreement',
    title: 'Held-out: disagreement about notifying the customer',
    repo: 'billing',
    heldOut: true,
    transcript: `Morgan (Support Lead): When a refund is issued the customer should be notified right away.
Jordan (Developer): I don't think we should notify customers about refunds, finance prefers a monthly statement.`,
    expected: { surfaced: ['direct_disagreement'] },
  },
];

export function getCase(id: string): FixtureCase {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown fixture ${id}`);
  return c;
}
