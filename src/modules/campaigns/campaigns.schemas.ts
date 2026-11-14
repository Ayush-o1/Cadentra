import { z } from 'zod';
import { findInvalidTokens } from '../../email/template.js';
import { pageQuerySchema } from '../../lib/pagination.js';
import { MAX_STEPS } from './campaigns.lifecycle.js';

const hour = (min: number, max: number) => z.number().int().min(min).max(max);
const version = z.number().int().positive();

const campaignFields = {
  name: z.string().trim().min(1, 'Name the campaign').max(160),
  listId: z.number().int().positive().nullable(),
  startAt: z.coerce.date().nullable(),
  windowStartHour: hour(0, 23),
  windowEndHour: hour(1, 24),
  weekdaysOnly: z.boolean(),
};

const windowIsValid = (value: { windowStartHour?: number; windowEndHour?: number }) =>
  value.windowStartHour === undefined ||
  value.windowEndHour === undefined ||
  value.windowStartHour < value.windowEndHour;
const windowIssue = {
  message: 'The sending window must end after it starts',
  path: ['windowEndHour'],
};

export const createCampaignSchema = z
  .object({ ...campaignFields, name: campaignFields.name })
  .partial({
    listId: true,
    startAt: true,
    windowStartHour: true,
    windowEndHour: true,
    weekdaysOnly: true,
  })
  .refine(windowIsValid, windowIssue);

export const updateCampaignSchema = z
  .object({ ...campaignFields, version })
  .partial()
  .required({ version: true })
  .refine(windowIsValid, windowIssue);

const stepSchema = z.object({
  subject: z.string().trim().min(1, 'Write a subject line').max(200),
  body: z.string().trim().min(1, 'Write the email').max(20_000),
  delayDays: z.number().int().min(0).max(60),
});

export const replaceStepsSchema = z
  .object({ version, steps: z.array(stepSchema).min(1).max(MAX_STEPS) })
  .superRefine((value, ctx) => {
    value.steps.forEach((step, index) => {
      for (const field of ['subject', 'body'] as const) {
        const invalid = findInvalidTokens(step[field]);
        if (invalid.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, field],
            message: `Unknown merge field ${invalid.join(', ')}. Use {{first_name}}, {{last_name}}, {{company}} or {{email}}.`,
          });
        }
      }
    });
  });

export const launchSchema = z.object({ version });
export const resumeSchema = z.object({ acknowledgeBounceRate: z.boolean().optional() });

export const previewSchema = z.object({
  position: z.number().int().min(1).max(MAX_STEPS),
  contactId: z.number().int().positive().optional(),
});

export const listCampaignsQuerySchema = pageQuerySchema.extend({
  status: z.enum(['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled']).optional(),
  search: z.string().trim().max(100).optional(),
});

export const listMessagesQuerySchema = pageQuerySchema.extend({
  status: z
    .enum([
      'scheduled',
      'sending',
      'accepted',
      'delivered',
      'bounced',
      'complained',
      'failed',
      'skipped',
      'cancelled',
    ])
    .optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type ReplaceStepsInput = z.infer<typeof replaceStepsSchema>;
