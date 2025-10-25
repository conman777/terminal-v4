import { z } from 'zod';

export const terminalCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional(),
  title: z.string().min(1).max(80).optional(),
  shell: z.string().min(1).optional()
});

export type TerminalCreateRequestBody = z.infer<typeof terminalCreateRequestSchema>;

export const terminalInputRequestSchema = z.object({
  command: z
    .string({
      required_error: 'command is required',
      invalid_type_error: 'command must be a string'
    })
    .min(1, 'command cannot be empty')
});

export type TerminalInputRequestBody = z.infer<typeof terminalInputRequestSchema>;

export const bookmarkCreateRequestSchema = z.object({
  name: z
    .string({
      required_error: 'name is required',
      invalid_type_error: 'name must be a string'
    })
    .min(1, 'name cannot be empty')
    .max(100, 'name too long'),
  command: z
    .string({
      required_error: 'command is required',
      invalid_type_error: 'command must be a string'
    })
    .min(1, 'command cannot be empty')
    .max(1000, 'command too long'),
  category: z
    .string({
      required_error: 'category is required',
      invalid_type_error: 'category must be a string'
    })
    .min(1, 'category cannot be empty')
    .max(50, 'category too long')
});

export type BookmarkCreateRequestBody = z.infer<typeof bookmarkCreateRequestSchema>;

export const bookmarkUpdateRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  command: z.string().min(1).max(1000).optional(),
  category: z.string().min(1).max(50).optional()
});

export type BookmarkUpdateRequestBody = z.infer<typeof bookmarkUpdateRequestSchema>;
