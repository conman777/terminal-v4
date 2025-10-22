const express = require('express');
const cors = require('cors');
const readline = require('readline');
const { spawnClaude } = require('./claude-wrapper');
const { SessionStore } = require('./session-store');

const PORT = process.env.PORT || 3020;
const sessionStore = new SessionStore();

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: sessionStore.listSessions() });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessionStore.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(session);
});

app.post('/api/sessions', (req, res) => {
  const { title } = req.body || {};
  const session = sessionStore.createSession({ title: typeof title === 'string' ? title : undefined });
  res.status(201).json(sessionStore.getSession(session.id));
});

app.delete('/api/sessions/:id', (req, res) => {
  const deleted = sessionStore.deleteSession(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.status(204).end();
});

function extractTextFragment(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  if (payload.delta && typeof payload.delta.text === 'string') {
    return payload.delta.text;
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => {
        if (!item) {
          return '';
        }

        if (typeof item === 'string') {
          return item;
        }

        if (item.text) {
          return item.text;
        }

        if (item.type === 'text' && item.value) {
          return item.value;
        }

        return '';
      })
      .join('');
  }

  if (payload.message && typeof payload.message === 'string') {
    return payload.message;
  }

  return '';
}

function detectClaudeSessionId(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    payload.sessionId,
    payload.session_id,
    payload.session,
    payload.conversationId,
    payload.conversation_id,
    payload.claudeSessionId,
    payload.claude_session_id,
    payload.delta?.sessionId,
    payload.meta?.sessionId,
    payload.metadata?.sessionId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

app.post('/api/chat', (req, res) => {
  const { message, sessionId: requestedSessionId, allowedTools } = req.body || {};

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Body must include a non-empty `message` string.' });
    return;
  }

  let session;
  if (requestedSessionId) {
    session = sessionStore.touch(requestedSessionId);
    if (!session) {
      res.status(404).json({ error: `Session ${requestedSessionId} not found` });
      return;
    }
  } else {
    session = sessionStore.createSession({ firstMessage: message });
  }

  const sessionId = session.id;
  sessionStore.appendMessage(sessionId, { role: 'user', content: message });
  const assistantMessageId = sessionStore.appendMessage(sessionId, {
    role: 'assistant',
    content: '',
    meta: { streaming: true }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const child = spawnClaude({ message, sessionId: session.claudeSessionId, allowedTools });

  const sendEvent = (event, data) => {
    const payload = data === undefined ? '' : JSON.stringify(data);
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
  };

  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  sendEvent('started', { sessionId, claudeSessionId: session.claudeSessionId });

  let assistantBuffer = '';
  let currentClaudeSessionId = session.claudeSessionId || null;
  let streamClosed = false;
  let dataBuffer = '';

  // PTY API: Use onData() instead of readline
  child.onData((data) => {
    dataBuffer += data;
    const lines = dataBuffer.split('\n');
    dataBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        sendEvent('chunk', parsed);

        const fragment = extractTextFragment(parsed);
        if (fragment) {
          assistantBuffer += fragment;
          sessionStore.updateMessage(sessionId, assistantMessageId, { content: assistantBuffer });
        }

        const cliSessionId = detectClaudeSessionId(parsed);
        if (cliSessionId && cliSessionId !== currentClaudeSessionId) {
          currentClaudeSessionId = cliSessionId;
          sessionStore.setClaudeSessionId(sessionId, cliSessionId);
          sendEvent('session', { claudeSessionId: cliSessionId });
        }
      } catch (error) {
        // Non-JSON lines (stderr, debug output) are sent as raw events
        sendEvent('raw', { line: trimmed, error: error.message });
      }
    });
  });

  // PTY API: Use onExit() instead of on('close')
  child.onExit(({ exitCode, signal }) => {
    if (streamClosed) {
      return;
    }
    streamClosed = true;

    clearInterval(keepAlive);
    sessionStore.updateMessage(sessionId, assistantMessageId, {
      content: assistantBuffer,
      meta: { streaming: false, exitCode, signal }
    });
    sendEvent('complete', { code: exitCode, signal, sessionId });
    res.end();
  });

  req.on('close', () => {
    if (streamClosed) {
      return;
    }
    streamClosed = true;

    clearInterval(keepAlive);
    sessionStore.updateMessage(sessionId, assistantMessageId, {
      content: `${assistantBuffer}\n[Request aborted by client]`,
      meta: { streaming: false, aborted: true }
    });
    child.kill();
  });
});

app.listen(PORT, () => {
  console.log(`Claude Code backend listening on port ${PORT}`);
});
