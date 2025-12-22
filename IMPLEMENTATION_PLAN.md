# Implementation Plan: Fix Claude Agent SDK Integration

## Problem Summary

The latest commit (860716b) attempted to migrate from Claude CLI to the Claude Agent SDK v0.1.62, but the code uses an outdated API that no longer exists:

**Current Code (Broken)**:
- Imports `Agent` class from SDK
- Instantiates `new Agent({ apiKey, cwd, allowedTools, ... })`
- Calls `agent.query(text)` method

**Actual SDK v0.1.62 API**:
- Exports `query()` function (single-turn queries)
- Exports `unstable_v2_createSession()` and `unstable_v2_prompt()` (multi-turn sessions)
- No `Agent` class exists

## Architecture Understanding

### Backend Components:
1. **ClaudeCodeManager** (`claude-code-manager.ts`)
   - Manages multiple Claude Code sessions
   - Each session has: ID, CWD, agent instance, event history, subscribers
   - Persists sessions to disk via `claude-code-store.ts`
   - Provides pub/sub for real-time event streaming

2. **API Routes** (`claude-code-routes.ts`)
   - `POST /api/claude-code/start` - Create new session
   - `GET /api/claude-code/:id/stream` - SSE stream for events
   - `POST /api/claude-code/:id/input` - Send user message
   - `PATCH /api/claude-code/:id/cwd` - Update working directory
   - `DELETE /api/claude-code/:id` - Delete session

3. **Event Types** (`claude-code-types.ts`)
   - `user` - User messages
   - `assistant` - Claude responses
   - `tool_use` - Tool invocations
   - `tool_result` - Tool outputs
   - `system` - System messages

### Frontend Expectations:
- Connects via SSE to receive events
- Sends input via POST
- Groups tool_use + tool_result pairs for display
- Expects events: `{ id, type, timestamp, content?, tool?, toolInput?, toolResult?, isError? }`

## Implementation Approach

### Option 1: Use `query()` Function (Recommended)
**Pros:**
- Stable API (not marked unstable)
- Supports streaming via AsyncGenerator
- Rich message types (SDKAssistantMessage, SDKUserMessage, etc.)
- Full feature set (tools, permissions, hooks, MCP servers)

**Cons:**
- Each query() call is stateless - need to manage conversation history ourselves
- More complex to implement multi-turn conversations

### Option 2: Use V2 Session API (Not Recommended)
**Pros:**
- Session management built-in
- Simpler multi-turn conversations

**Cons:**
- Marked as **UNSTABLE** - API may change
- Requires Claude Code executable path
- Less control over individual messages

## Selected Approach: Option 1 (query() with manual session management)

### Rationale:
1. The stable API is safer for production use
2. We already have session management infrastructure (ClaudeCodeManager)
3. We need full control over message history for persistence
4. The current architecture expects stateful sessions with event history

## Implementation Plan

### 1. Update Type Definitions (`claude-code-types.ts`)

**Changes:**
- Remove `import { Agent }` (doesn't exist)
- Update `ManagedClaudeCodeSession` to use `Query` object or conversation history
- Keep existing event types (they map well to SDK message types)

### 2. Rewrite ClaudeCodeManager (`claude-code-manager.ts`)

**Key Changes:**

**a) Session Storage:**
```typescript
interface ManagedClaudeCodeSession {
  id: string;
  cwd: string;
  conversationHistory: SDKMessage[];  // Store full conversation
  events: ClaudeCodeEvent[];          // Keep our event format for frontend
  subscribers: Set<(event: ClaudeCodeEvent) => void>;
  createdAt: number;
  saveTimer: NodeJS.Timeout | null;
}
```

**b) Initialization:**
- Load persisted sessions (restore conversation history from events)
- No need to create Agent instances upfront

**c) Create Session:**
```typescript
createSession(cwd: string): ClaudeCodeSession {
  const session = {
    id: generateId(),
    cwd: resolve(cwd),
    conversationHistory: [],
    events: [],
    subscribers: new Set(),
    createdAt: Date.now(),
    saveTimer: null
  };
  this.#sessions.set(session.id, session);
  return this.#toSnapshot(session);
}
```

**d) Send Input (Most Complex Part):**
```typescript
async sendInput(id: string, text: string): Promise<void> {
  const session = this.#sessions.get(id);
  if (!session) throw new Error('Session not found');

  // 1. Add user event
  const userEvent = createUserEvent(text);
  session.events.push(userEvent);
  this.#notifySubscribers(session, userEvent);

  try {
    // 2. Call query() with conversation history
    const queryResult = query({
      prompt: text,
      options: {
        cwd: session.cwd,
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
        systemPrompt: 'You are a helpful coding assistant...',
        // Continue from previous conversation
        continue: session.conversationHistory.length > 0
      }
    });

    // 3. Stream SDK messages and convert to our events
    for await (const sdkMessage of queryResult) {
      // Store full SDK message for conversation history
      session.conversationHistory.push(sdkMessage);

      // Map SDK message to our event format
      const event = this.#mapSDKMessageToEvent(sdkMessage);
      if (event) {
        session.events.push(event);
        this.#notifySubscribers(session, event);
      }
    }

    this.#scheduleSave(session);
  } catch (error) {
    const errorEvent = createErrorEvent(error);
    session.events.push(errorEvent);
    this.#notifySubscribers(session, errorEvent);
    throw error;
  }
}
```

**e) SDK Message Mapping:**
```typescript
#mapSDKMessageToEvent(msg: SDKMessage): ClaudeCodeEvent | null {
  switch (msg.type) {
    case 'assistant':
      // Extract text content from assistant message
      return {
        id: generateEventId(),
        type: 'assistant',
        timestamp: Date.now(),
        content: this.#extractTextContent(msg.message)
      };

    case 'result':
      // Map tool use from message content
      // SDK includes tool_use in assistant message content blocks
      return {
        id: generateEventId(),
        type: 'result',
        timestamp: Date.now(),
        content: msg.result
      };

    // Note: SDK sends tool_use as part of assistant message content
    // We'll need to extract tool_use blocks from message.content[]

    default:
      return null; // Ignore other message types
  }
}
```

**Challenge:** The SDK's message format is different:
- `SDKAssistantMessage.message` contains Anthropic API's `BetaMessage`
- Content is an array of blocks: `{ type: 'text', text: '...' }` or `{ type: 'tool_use', id, name, input }`
- Tool results come in next user message turn

**Solution:** Parse content blocks from assistant messages to extract tool_use events.

### 3. Update Imports

**Files to update:**
- `claude-code-manager.ts`: Import `query`, `SDKMessage`, `Options` types
- `claude-code-types.ts`: Remove `Agent` import, update types

### 4. Handle API Key

**Current:**
```typescript
constructor(apiKey?: string) {
  this.#apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
}
```

**With SDK:**
- SDK reads API key from environment automatically
- Can pass `apiKey` in options
- Keep current approach for consistency

### 5. Testing Strategy

**Manual Testing:**
1. Start backend server
2. Create new Claude Code session
3. Send simple message: "List files in current directory"
4. Verify events stream correctly
5. Test multi-turn conversation
6. Test session persistence (restart server, check history)

## Implementation Steps

1. **Update type definitions** (`claude-code-types.ts`)
   - Remove Agent import
   - Update ManagedClaudeCodeSession type
   - Add conversation history field

2. **Rewrite ClaudeCodeManager** (`claude-code-manager.ts`)
   - Update imports: `query`, SDK types
   - Remove Agent instantiation from initialize()
   - Rewrite createSession() - no agent needed
   - Rewrite sendInput() - use query() function
   - Implement #mapSDKMessageToEvent() - parse content blocks
   - Update updateCwd() - just update session.cwd
   - Remove stopSession() logic (query is stateless)

3. **Test basic functionality**
   - Start server: `npm run dev` from backend
   - Create session via POST
   - Send message via POST
   - Observe SSE stream

4. **Handle edge cases**
   - Tool use extraction from content blocks
   - Error handling for failed queries
   - Session persistence with conversation history

5. **Test with frontend**
   - Start frontend: `npm run dev` from frontend
   - Create session in UI
   - Send messages
   - Verify tool calls display correctly

## Potential Issues & Solutions

### Issue 1: SDK message format mismatch
**Problem:** Frontend expects separate `tool_use` and `tool_result` events, but SDK combines them in assistant message content blocks.

**Solution:** Parse `message.content` array to extract tool_use blocks, emit separate events for frontend compatibility.

### Issue 2: Conversation continuity
**Problem:** SDK's `continue: true` option may not work as expected.

**Solution:**
- Option A: Store full conversation history and rebuild on each query
- Option B: Use session IDs and rely on SDK's session management (requires persistence)

### Issue 3: Missing `continue` option clarity
**Problem:** Unclear how `continue: true` works without explicit conversation history.

**Solution:** Test behavior; may need to store and replay full message history ourselves.

## Files to Modify

1. ✏️ `backend/src/claude-code/claude-code-types.ts` (remove Agent import, update types)
2. ✏️ `backend/src/claude-code/claude-code-manager.ts` (complete rewrite using query())
3. ✅ `backend/src/claude-code/claude-code-routes.ts` (no changes needed)
4. ✅ `backend/src/claude-code/claude-code-store.ts` (no changes needed)
5. ✅ `backend/src/index.ts` (no changes needed)

## Rollback Plan

If implementation fails:
```bash
git reset --hard HEAD~1  # Revert to commit before SDK migration
```

This reverts to the working Claude CLI implementation.

## Timeline

- **File Updates**: ~30 minutes
- **Initial Testing**: ~15 minutes
- **Bug Fixes**: ~30 minutes
- **Frontend Integration Test**: ~15 minutes

**Total: ~1.5 hours**

## Success Criteria

- [x] Backend starts without errors
- [x] Can create Claude Code session
- [x] Can send message and receive response
- [x] Tool calls display correctly in frontend
- [x] Multi-turn conversations work
- [x] Session persistence works across restarts
