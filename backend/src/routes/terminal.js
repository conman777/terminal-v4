const express = require('express');

// Simple helper to remove ANSI codes - for POC we'll just return text as-is
const stripAnsi = (text) => text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

function createTerminalRouter(terminalManager) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { cwd, cols, rows } = req.body || {};
    const session = terminalManager.createSession({ cwd, cols, rows });
    res.status(201).json({ sessionId: session.id });
  });

  router.get('/:id/history', (req, res) => {
    const session = terminalManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      id: session.id,
      shell: session.shell,
      createdAt: session.createdAt,
      history: session.buffer.map((entry) => ({
        role: entry.type,
        text: entry.text,
        plain: stripAnsi(entry.text),
        ts: entry.ts
      }))
    });
  });

  router.post('/:id/input', (req, res) => {
    const { command } = req.body || {};
    if (typeof command !== 'string') {
      res.status(400).json({ error: 'Command must be a string' });
      return;
    }
    try {
      terminalManager.write(req.params.id, `${command}\n`);
      res.status(204).end();
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/:id/stream', (req, res) => {
    const session = terminalManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const send = (chunk) => {
      if (chunk === null) {
        res.write('event: end\n');
        res.write('data: {}\n\n');
        res.end();
        return;
      }
      res.write('event: data\n');
      res.write(`data: ${JSON.stringify({ text: chunk, plain: stripAnsi(chunk) })}\n\n`);
    };

    const unsubscribe = terminalManager.subscribe(session.id, send);
    req.on('close', unsubscribe);

    // Immediately flush existing buffer so the UI can hydrate the transcript.
    session.buffer.forEach((entry) => send(entry.text));
  });

  return router;
}

module.exports = { createTerminalRouter };
