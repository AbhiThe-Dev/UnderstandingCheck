/**
 * Meetings for the Implementation Preview (not part of the misunderstanding eval: a preview is
 * requested, not surfaced, so these have no expected categories).
 */
export const PREVIEW_DEMO = {
  id: 'preview-downgrade',
  title: 'Implementation preview: remove premium access on downgrade',
  repo: 'subscriptions' as const,
  transcript: `Maya (PO): When a customer downgrades their subscription, remove their access to premium features.
Leo (Developer): Sure, I'll hook that into the downgrade flow.
Maya (PO): Great, and they should still get the proration credit.`,
  /** Said later in the meeting: settles when access ends. */
  clarification: `Leo (Developer): Should premium go away immediately, or at the end of their session?
Maya (PO): Immediately, even if they are signed in.`,
};

/**
 * Meetings for technical decision evaluation, against demo/subscriptions. Everyone agrees in each;
 * what matters is whether the decision holds up against the code and the documentation.
 */
export const DECISION_DEMO = {
  id: 'decision-entitlement-cache',
  title: 'Decision check: cache entitlements in Redis',
  repo: 'subscriptions' as const,
  /** Conflicts with docs/entitlements.md (downgrades must take effect within an hour). */
  transcript: `Leo (Developer): Premium checks are slow, so let's cache entitlements in Redis with a 24 hour TTL.
Priya (Developer): Sounds good, that takes load off the database.
Maya (PO): Great, go for it.`,
  /** Changes getSession, which hasPremiumAccess relies on; nobody mentions it. */
  replaceSession: `Leo (Developer): Let's replace getSession with a stateless JWT check instead of the session map.
Priya (Developer): Sure, sounds good.`,
  /** Turned down before anyone agrees: never evaluated. */
  rejected: `Leo (Developer): Let's move the session store into Redis.
Priya (Developer): No, let's not add Redis just for that.
Maya (PO): Okay, moving on to the pricing page.`,
};
