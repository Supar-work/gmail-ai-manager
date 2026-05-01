import { z } from 'zod';
import { ActionSchema, ActionTypeSchema } from './rules.js';

/**
 * Wire shapes shared between the API and the web client.
 *
 * The naming convention is `<Entity>DTO`. A DTO is the post-Prisma
 * post-`hydrate*` shape served as JSON; both ends should consume these
 * types from `@gam/shared` rather than declaring their own ad-hoc
 * versions and drifting.
 */

// ── Rule ──────────────────────────────────────────────────────────────

// `actionsJson` is historical: the column on disk is JSON-stringified,
// but the wire type is the parsed array. Renaming the field would be a
// breaking change for old web bundles in flight; keep the name + the
// real array-of-Action shape as documented here.
export const RuleDTOSchema = z.object({
  id: z.string(),
  naturalLanguage: z.string(),
  actionsJson: z.array(ActionSchema),
  enabled: z.boolean(),
  position: z.number().int(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
});
export type RuleDTO = z.infer<typeof RuleDTOSchema>;

// ── Me / current user ────────────────────────────────────────────────

export const ClaudeCliStatusSchema = z.union([
  z.object({
    ok: z.literal(true),
    version: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['missing', 'timeout', 'failed']),
    detail: z.string(),
    checkedAt: z.string(),
  }),
]);
export type ClaudeCliStatus = z.infer<typeof ClaudeCliStatusSchema>;

export const MeDTOSchema = z.object({
  id: z.string(),
  email: z.string(),
  timezone: z.string(),
  status: z.enum(['active', 'paused', 'needsReauth']),
  createdAt: z.string().or(z.date()),
  claudeCli: ClaudeCliStatusSchema.optional(),
});
export type MeDTO = z.infer<typeof MeDTOSchema>;

// ── Rule analyzer ────────────────────────────────────────────────────

// Sparse view of an Action used by the analyzer endpoint. Both labelName
// and to are optional because the model emits whichever applies for the
// given action type — discriminating clients should narrow on `type`.
export const AnalyzeActionSchema = z.object({
  type: ActionTypeSchema,
  labelName: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  timing: z.string().nullable().optional(),
});
export type AnalyzeAction = z.infer<typeof AnalyzeActionSchema>;

export const AnalyzeResponseSchema = z.object({
  summary: z.string(),
  actions: z.array(AnalyzeActionSchema),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()).optional(),
  suggestedRewrite: z.string().nullable().optional(),
});
export type AnalyzeResponse = z.infer<typeof AnalyzeResponseSchema>;

// ── Forwarding allowlist ─────────────────────────────────────────────

export const ForwardTargetDTOSchema = z.object({
  id: z.string(),
  address: z.string(),
  verified: z.boolean(),
  updatedAt: z.string().or(z.date()).optional(),
});
export type ForwardTargetDTO = z.infer<typeof ForwardTargetDTOSchema>;
