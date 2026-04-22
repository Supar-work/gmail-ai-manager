import { z } from 'zod';

export const RunAtSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }),
  z.object({ kind: z.literal('endOfDay') }),
  z.object({ kind: z.literal('endOfNextBusinessDay') }),
  z.object({
    kind: z.literal('relative'),
    minutes: z.number().int().min(0).optional(),
    hours: z.number().int().min(0).optional(),
    days: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('atTime'),
    iso: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('contentDerived'),
    hint: z.string().min(1),
  }),
]);

export type RunAt = z.infer<typeof RunAtSchema>;
