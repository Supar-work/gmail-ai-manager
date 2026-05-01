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
 * One element of the rule sentence, as Claude tokenises it. The wizard
 * renders these inline inside the rule textbox: text tokens are plain
 * editable spans, chip tokens are clickable buttons with optional
 * preset values.
 *
 * The model decides which fragments are meaningful chips and what
 * `options` to offer for each — e.g. a sender chip might surface
 * `["noreply@github.com", "*@github.com", "github"]`. Free text the
 * user types between chips becomes `kind: "text"` tokens. The user
 * clicks Evaluate when they're ready; we serialise the tokens into a
 * NL string and re-prompt Claude, which returns a fresh token
 * sequence (potentially promoting free text into new chips).
 */
export const RuleTokenChipSchema = z.object({
  kind: z.literal('chip'),
  /**
   * Free-form classification chosen by the model. Common values:
   * 'sender', 'recipient', 'subject', 'list', 'time', 'attachment',
   * 'flag', 'action', 'label', 'timing', 'note'. Decorative —
   * drives chip styling only.
   */
  semantic: z.string().min(1),
  /** Optional prefix rendered before the value, e.g. "from". Empty string allowed. */
  label: z.string(),
  /** Current chip value, e.g. "noreply@github.com". */
  value: z.string().min(1),
  /** Suggested alternative values offered in the chip's edit popover. */
  options: z.array(z.string()).optional(),
});
export type RuleTokenChip = z.infer<typeof RuleTokenChipSchema>;

export const RuleTokenTextSchema = z.object({
  kind: z.literal('text'),
  /** Plain text fragment between chips. May be empty. */
  value: z.string(),
});
export type RuleTokenText = z.infer<typeof RuleTokenTextSchema>;

export const RuleTokenSchema = z.discriminatedUnion('kind', [
  RuleTokenChipSchema,
  RuleTokenTextSchema,
]);
export type RuleToken = z.infer<typeof RuleTokenSchema>;

/**
 * Result of `POST /api/inbox-cleanup/session/:id/propose` when Claude
 * decides the email is already covered by an existing enabled rule.
 * Saves the propose / evaluate / refine round-trip — the wizard
 * shows a "Already handled by rule X" card and auto-advances.
 */
export const CleanupCoveredSchema = z.object({
  outcome: z.literal('covered'),
  messageId: z.string(),
  /** The matching rule's id from the user's Rule table. */
  ruleId: z.string(),
  /** That rule's naturalLanguage, surfaced in the wizard so the user
   *  can read why it's considered covered. */
  ruleNL: z.string(),
  /** Short note explaining why this email matches the existing rule. */
  reasoning: z.string(),
});
export type CleanupCovered = z.infer<typeof CleanupCoveredSchema>;

/**
 * Result of `POST /api/inbox-cleanup/session/:id/propose` — the server
 * returns a fully-evaluated proposal with its match set attached, so the
 * wizard can render everything in one go.
 */
export const CleanupProposalSchema = z.object({
  outcome: z.literal('propose'),
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
  /**
   * AI-tokenised rule. The wizard renders these inline inside the
   * rule textbox; the user clicks Evaluate to ask the AI to re-derive
   * tokens after edits. Optional so older cached proposals still
   * parse.
   */
  ruleTokens: z.array(RuleTokenSchema).optional(),
});
export type CleanupProposal = z.infer<typeof CleanupProposalSchema>;

/**
 * Discriminated union returned by /propose — either a brand-new
 * proposal or a "covered by existing rule" short-circuit.
 */
export const CleanupOutcomeSchema = z.discriminatedUnion('outcome', [
  CleanupProposalSchema,
  CleanupCoveredSchema,
]);
export type CleanupOutcome = z.infer<typeof CleanupOutcomeSchema>;

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
  ruleTokens: z.array(RuleTokenSchema).optional(),
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
