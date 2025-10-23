import { z } from 'zod';

export const chatRequestSchema = z.object({
  message: z
    .string({
      required_error: 'message is required',
      invalid_type_error: 'message must be a string'
    })
    .min(1, 'message cannot be empty'),
  sessionId: z.string().min(1).optional(),
  allowedTools: z
    .array(z.string().min(1))
    .nonempty()
    .optional()
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;

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
