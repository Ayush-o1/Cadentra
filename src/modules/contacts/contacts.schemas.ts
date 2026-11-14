import { z } from 'zod';
import { emailSchema, optionalText } from '../../lib/schemas.js';
import { pageQuerySchema } from '../../lib/pagination.js';

export const consentBasisSchema = z.enum([
  'requested_contact',
  'existing_customer',
  'signed_up',
  'event_attendee',
  'other_documented',
]);

const consentedAtSchema = z.coerce
  .date()
  .refine((date) => date.getTime() <= Date.now() + 60_000, 'Consent cannot be dated in the future');

export const createContactSchema = z.object({
  email: emailSchema,
  firstName: optionalText(100),
  lastName: optionalText(100),
  company: optionalText(160),
  consentBasis: consentBasisSchema,
  consentSource: optionalText(255),
  consentedAt: consentedAtSchema.optional(),
  listIds: z.array(z.number().int().positive()).max(50).optional(),
});

export const updateContactSchema = createContactSchema.omit({ listIds: true }).partial();

export const listContactsQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  listId: z.coerce.number().int().positive().optional(),
  status: z.enum(['all', 'active', 'suppressed']).default('all'),
});

export const importQuerySchema = z.object({
  consentBasis: consentBasisSchema,
  source: z.string().trim().max(255).optional(),
  listId: z.coerce.number().int().positive().optional(),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
