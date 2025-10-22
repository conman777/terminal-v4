const pty = require('node-pty');

const DEFAULT_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS
  ? process.env.CLAUDE_ALLOWED_TOOLS.split(',').map((tool) => tool.trim()).filter(Boolean)
  : [];

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

  const claudePath = '/home/conor/.nvm/versions/node/v22.16.0/bin/claude';
  const nvmBinPath = '/home/conor/.nvm/versions/node/v22.16.0/bin';

  // Build environment with NVM paths
  const ptyEnv = Object.assign({}, process.env, {
    PATH: nvmBinPath + ':' + (process.env.PATH || '')
  });

  console.log('[Claude Wrapper] Spawning:', claudePath);
  console.log('[Claude Wrapper] PATH:', ptyEnv.PATH.split(':').slice(0, 3));

  const child = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || process.cwd(),
    env: ptyEnv
  });

  return child;
}

module.exports = { spawnClaude };
