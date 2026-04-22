import { z } from 'zod';
import { RunAtSchema } from './time.js';

export const ActionTypeSchema = z.enum([
  'addLabel',
  'removeLabel',
  'archive',
  'markRead',
  'star',
  'markImportant',
  'trash',
  'forward',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addLabel'), labelName: z.string(), runAt: RunAtSchema.optional() }),
  z.object({
    type: z.literal('removeLabel'),
    labelName: z.string(),
    runAt: RunAtSchema.optional(),
  }),
  z.object({ type: z.literal('archive'), runAt: RunAtSchema.optional() }),
  z.object({ type: z.literal('markRead'), runAt: RunAtSchema.optional() }),
  z.object({ type: z.literal('star'), runAt: RunAtSchema.optional() }),
  z.object({ type: z.literal('markImportant'), runAt: RunAtSchema.optional() }),
  z.object({ type: z.literal('trash'), runAt: RunAtSchema.optional() }),
  z.object({
    type: z.literal('forward'),
    to: z.string().email(),
    runAt: RunAtSchema.optional(),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const RuleSchema = z.object({
  id: z.string(),
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  enabled: z.boolean().default(true),
  position: z.number().int(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RuleDraftSchema = RuleSchema.omit({ id: true, position: true }).extend({
  enabled: z.boolean().default(true),
});
export type RuleDraft = z.infer<typeof RuleDraftSchema>;

/**
 * Shape the classifier returns per matched rule. `resolvedRunAtIso` is null
 * for immediate actions and an ISO UTC timestamp for deferred actions
 * (including `contentDerived` kinds the model resolved from the email body).
 */
export const ClassifierActionSchema = z.object({
  type: ActionTypeSchema,
  labelName: z.string().optional(),
  to: z.string().email().optional(),
  resolvedRunAtIso: z.string().datetime().nullable(),
});
export type ClassifierAction = z.infer<typeof ClassifierActionSchema>;

export const ClassifierMatchSchema = z.object({
  ruleId: z.string(),
  reasoning: z.string(),
  actions: z.array(ClassifierActionSchema),
});
export type ClassifierMatch = z.infer<typeof ClassifierMatchSchema>;

export const ClassifierResponseSchema = z.object({
  matches: z.array(ClassifierMatchSchema),
});
export type ClassifierResponse = z.infer<typeof ClassifierResponseSchema>;
