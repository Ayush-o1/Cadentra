import { z } from 'zod';
import { emailSchema } from '../../lib/schemas.js';

const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: emailSchema,
  password: passwordSchema,
  workspaceName: z.string().trim().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
