import { z } from 'zod';

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be at most 50 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').optional(),
  email: z.string().trim().min(1, 'Email is required').optional(),
  password: z.string().min(1, 'Password is required')
}).transform((input) => ({
  username: input.username || input.email || '',
  password: input.password
})).refine((input) => input.username.length > 0, {
  message: 'Username is required',
  path: ['username']
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
