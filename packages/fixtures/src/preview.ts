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
