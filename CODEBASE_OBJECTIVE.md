# Terminal V4 Codebase Objective

## What We Are Building

Terminal V4 is a desktop-first app that gives users a native interface for working with terminal-based AI agents, without forcing them to stay in a raw terminal view.

Primary platform focus is Windows first, with a Mac version planned next.

## Core Product Goal

Deliver a **single, unified workspace UI** where users can:

1. Launch and use multiple AI CLIs (not just one provider).
2. Communicate from a chat-like interface in the main panel.
3. Still access a real terminal panel when direct TUI interaction is required.
4. See what is happening in the terminal from the main UI (live mirror), so context is never hidden.

## Key UX Direction

- Avoid fragmented mode confusion.
- Keep conversation and terminal context in one area.
- Make chat input behave as the default send surface.
- Preserve terminal power features without making users depend on terminal-only workflows.

## Multi-AI Requirement

This system must support multiple CLI-based agents, including current and future providers.  
Behavior should be provider-agnostic where possible:

- Launch handling
- Connection/status display
- Turn/noise filtering
- Interactive prompt fallback behavior

## Interaction Model

1. User opens/creates a session and selects an AI provider.
2. Provider CLI is launched in session context.
3. Main UI shows conversation turns when structured turns are available.
4. If CLI enters interactive/full-screen mode, main UI switches to terminal mirror presentation.
5. User can continue from chat input; terminal panel is available for direct TUI control when needed.

## Current Implementation Priorities

1. Reliable send path from main chat input (no terminal dependency for normal messages).
2. Visual consistency between main panel and terminal output during interactive modes.
3. Generic support for multiple CLI agents, not hardcoded provider behavior.
4. Stable session transport and reconnection behavior.

## Success Criteria

- A user can run different AI CLIs in different sessions from one consistent UI.
- Main panel always reflects session state and output clearly.
- Users are not forced to open terminal for standard back-and-forth messaging.
- Terminal panel remains available for advanced/interactive edge cases.
