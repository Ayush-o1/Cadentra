import { z } from 'zod';
import { emailSchema, isValidTimeZone, optionalText } from '../../lib/schemas.js';

const hour = (min: number, max: number) => z.number().int().min(min).max(max);

export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: z
      .string()
      .refine(isValidTimeZone, 'Choose a valid IANA time zone such as Europe/London'),
    senderName: optionalText(120),
    senderEmail: emailSchema.nullable(),
    replyToEmail: emailSchema.nullable(),
    postalAddress: optionalText(500),
    windowStartHour: hour(0, 23),
    windowEndHour: hour(1, 24),
    weekdaysOnly: z.boolean(),
    dailySendLimit: z.number().int().min(1).max(100_000),
  })
  .partial()
  .refine(
    (value) =>
      value.windowStartHour === undefined ||
      value.windowEndHour === undefined ||
      value.windowStartHour < value.windowEndHour,
    { message: 'The sending window must end after it starts', path: ['windowEndHour'] },
  );

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
