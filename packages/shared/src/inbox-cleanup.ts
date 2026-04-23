import { z } from 'zod';
import { ActionSchema } from './rules.js';

/**
 * Preview metadata for an email that matched a proposed rule. Returned to
 * the frontend for the "Matches" sample list in the cleanup wizard.
 */
export const CleanupSampleSchema = z.object({
  messageId: z.string(),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  inInbox: z.boolean(),
});
export type CleanupSample = z.infer<typeof CleanupSampleSchema>;

/**
 * One entry in the server-side auto-refinement audit trail. Populated
 * when the evaluate step says a proposal is too broad / too narrow /
 * incoherent and Claude was asked to try again.
 */
export const RefineAuditSchema = z.object({
  attempt: z.number().int().min(1),
  previousRule: z.string(),
  previousQuery: z.string(),
  verdict: z.literal('refine'),
  note: z.string(),
});
export type RefineAudit = z.infer<typeof RefineAuditSchema>;

export const MatchTotalsSchema = z.object({
  inbox: z.number().int().min(0),
  allMail: z.number().int().min(0),
});
export type MatchTotals = z.infer<typeof MatchTotalsSchema>;

/**
 * Result of `POST /api/inbox-cleanup/session/:id/propose` — the server
 * returns a fully-evaluated proposal with its match set attached, so the
 * wizard can render everything in one go.
 */
export const CleanupProposalSchema = z.object({
  messageId: z.string(),
  naturalLanguage: z.string(),
  actions: z.array(ActionSchema),
  gmailQuery: z.string(),
  groupDescription: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  refineHistory: z.array(RefineAuditSchema),
  samples: z.array(CleanupSampleSchema),
  totals: MatchTotalsSchema,
});
export type CleanupProposal = z.infer<typeof CleanupProposalSchema>;

/**
 * Result of `POST /api/inbox-cleanup/session/:id/preview-matches` — a
 * lighter response for the debounced re-search when the user edits the
 * rule text. Includes freshly-rederived actions so the wizard's action
 * chips stay in sync with the edited NL (no refine loop; the user is
 * driving now).
 */
export const CleanupPreviewSchema = z.object({
  naturalLanguage: z.string(),
  gmailQuery: z.string(),
  actions: z.array(ActionSchema),
  samples: z.array(CleanupSampleSchema),
  totals: MatchTotalsSchema,
});
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;

export const CleanupScopeSchema = z.enum(['inbox-only', 'all-mail', 'save-only']);
export type CleanupScope = z.infer<typeof CleanupScopeSchema>;

export const CleanupApplyResultSchema = z.object({
  ruleId: z.string(),
  scope: CleanupScopeSchema,
  appliedImmediateCount: z.number().int().min(0),
  scheduledCount: z.number().int().min(0),
  coveredInboxMessageIds: z.array(z.string()),
  failures: z.array(
    z.object({
      gmailMessageId: z.string(),
      error: z.string(),
    }),
  ),
});
export type CleanupApplyResult = z.infer<typeof CleanupApplyResultSchema>;

export const CleanupSessionSchema = z.object({
  sessionId: z.string(),
  messageIds: z.array(z.string()),
  totalInbox: z.number().int().min(0),
});
export type CleanupSession = z.infer<typeof CleanupSessionSchema>;

/**
 * Minimal inbox-email preview the wizard shows above the proposed rule
 * ("here's the email we're working from"). Returned by
 * `GET /api/inbox-cleanup/message/:id`.
 */
export const InboxMessagePreviewSchema = z.object({
  messageId: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  date: z.string().nullable(),
});
export type InboxMessagePreview = z.infer<typeof InboxMessagePreviewSchema>;
