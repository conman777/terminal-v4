const { spawn, exec } = require('child_process');

const DEFAULT_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS
  ? process.env.CLAUDE_ALLOWED_TOOLS.split(',').map((tool) => tool.trim()).filter(Boolean)
  : [];

/**
 * Spawn the Claude Code CLI with a prompt and optional session + tool controls.
 * @param {object} options
 * @param {string} options.message - Prompt to send to Claude.
 * @param {string} [options.sessionId] - Existing Claude session id to continue.
 * @param {string[]} [options.allowedTools] - Subset of tools Claude can invoke.
 * @returns {import('child_process').ChildProcess}
 */
function spawnClaude(options) {
  const { message, sessionId, allowedTools = DEFAULT_ALLOWED_TOOLS } = options || {};

  if (!message || typeof message !== 'string') {
    throw new Error('Claude invocation requires a non-empty message.');
  }

  const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];

  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  if (sessionId) {
    args.push('--continue', sessionId);
  }

  if (process.env.CLAUDE_ASSUME_YES === 'true') {
    args.push('--dangerously-skip-permissions');
  }

  // Build the command string
  const cmdParts = ['claude', ...args.map(arg => `"${arg.replace(/"/g, '\\"')}"`)]
  const cmdString = cmdParts.join(' ');

  console.log('[Claude Wrapper] Running command:', cmdString);

  // Use cmd.exe /c to run the command through shell
  return spawn('cmd.exe', ['/c', cmdString], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: true
  });
}

module.exports = {
  spawnClaude
};
