import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';

export async function forkClaude(input, fork = forkSession) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!input || Object.keys(input).sort().join(',') !== 'cursor,sessionId,workspace' ||
      !uuid.test(input.sessionId) || !uuid.test(input.cursor) ||
      typeof input.workspace !== 'string' || !isAbsolute(input.workspace) ||
      /[\x00-\x1f]/.test(input.workspace)) throw new Error('Invalid native fork request');
  const result = await fork(input.sessionId, {
    dir: input.workspace, upToMessageId: input.cursor, title: 'Terminal v4 rewind',
  });
  if (!uuid.test(result?.sessionId) || result.sessionId === input.sessionId) {
    throw new Error('Native fork did not create an independent conversation');
  }
  return { sessionId: result.sessionId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await forkClaude(JSON.parse(process.argv[2])))); }
  catch { process.stderr.write('Native Claude fork failed'); process.exitCode = 1; }
}
