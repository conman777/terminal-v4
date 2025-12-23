import { z } from 'zod';

export const terminalCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional(),
  title: z.string().min(1).max(80).optional(),
  shell: z.string().min(1).optional(),
  initialCommand: z.string().max(1000).optional()
});

export type TerminalCreateRequestBody = z.infer<typeof terminalCreateRequestSchema>;

// Maximum input size: 1MB (reasonable limit for terminal input while allowing large pastes)
const MAX_TERMINAL_INPUT_SIZE = 1024 * 1024;

export const terminalInputRequestSchema = z.object({
  command: z
    .string({ error: 'command must be a string' })
    .min(1, 'command cannot be empty')
    .max(MAX_TERMINAL_INPUT_SIZE, 'command exceeds maximum allowed size')
});

export type TerminalInputRequestBody = z.infer<typeof terminalInputRequestSchema>;

export const terminalResizeRequestSchema = z.object({
  cols: z.number().positive().max(500).transform(Math.round),
  rows: z.number().positive().max(500).transform(Math.round)
});

export type TerminalResizeRequestBody = z.infer<typeof terminalResizeRequestSchema>;

export const terminalRenameRequestSchema = z.object({
  title: z.string().trim().min(1, 'title cannot be empty').max(60, 'title too long')
});

export type TerminalRenameRequestBody = z.infer<typeof terminalRenameRequestSchema>;

export const bookmarkCreateRequestSchema = z.object({
  name: z
    .string({ error: 'name must be a string' })
    .min(1, 'name cannot be empty')
    .max(100, 'name too long'),
  command: z
    .string({ error: 'command must be a string' })
    .min(1, 'command cannot be empty')
    .max(1000, 'command too long'),
  category: z
    .string({ error: 'category must be a string' })
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
