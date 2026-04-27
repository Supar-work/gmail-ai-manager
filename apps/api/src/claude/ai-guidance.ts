/**
 * Cross-cutting "always think about this first" guidance for the
 * inbox-cleanup proposer + reproposer. Stored on User.aiGuidance as a
 * free-form bullet list; injected near the top of the prompt so Claude
 * checks these patterns BEFORE settling on per-sender or per-category
 * actions.
 *
 * The OTP example illustrates the point: a code from your bank legitimately
 * matches "Finance/Bank" but should be archived an hour later, not 30
 * days later. The cross-cutting pattern wins over the category default.
 *
 * The default is a curated starter set; users can edit it in Settings.
 * `null` from the DB falls back to DEFAULT_AI_GUIDANCE.
 */
export const DEFAULT_AI_GUIDANCE = `# AI guidance — cross-cutting patterns the proposer should always check

These override the per-sender / per-category defaults when they apply.
Edit freely; the proposer reads this verbatim.

- **One-time codes / OTPs / 2FA / verification codes**: archive 1 hour
  after arrival. The code is useless after the window. Use:
    actions: [addLabel "Action/OTP", { archive, runAt: { kind:"relative", hours: 1 } }]
- **Calendar invites for past events** (event date is in the past):
  archive immediately.
- **Calendar invites for upcoming events**: keep in inbox; archive on
  the day after the event (use { kind:"atTime", iso:"<event-date+1d>" }).
- **Order confirmations / shipping notifications**: label
  Receipts/<Vendor> and archive immediately — you only need them when
  searching later.
- **Newsletters where I never click anything**: archive immediately.
  Don't snooze, don't keep visible.
- **Promotional emails with a discount code that expires soon**:
  if the email body mentions a deadline, schedule archive at the
  deadline + 1 day.
`;

export function effectiveGuidance(stored: string | null | undefined): string {
  const trimmed = (stored ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_AI_GUIDANCE.trim();
}

/**
 * Merge the user-edited (or factory-default) guidance with the
 * memory-consolidator's learned memory. The combined text is what the
 * proposer + chat agent see; the two halves are kept separate in the
 * DB so the user can edit one without affecting the other.
 *
 * The learned-memory section is appended under a clear header so
 * Claude can tell which lines are user-curated vs auto-learned.
 */
export function effectiveGuidanceWithMemory(
  stored: string | null | undefined,
  learnedMemory: string | null | undefined,
): string {
  const base = effectiveGuidance(stored);
  const memory = (learnedMemory ?? '').trim();
  if (!memory) return base;
  return `${base}\n\n# Learned from your past actions (auto-updated)\n\n${memory}`;
}
