# Local Codex conversations

Choose Codex in the main composer to use the locally installed agent in
Terminal V4's conversation view. Codex handles the reasoning and tools; the app
handles conversation display, saved requests and user controls.

## User flow

1. Install Codex on the computer running Terminal V4 and run `codex login` once.
2. Choose **New thread**, select a project, and choose **Codex**, its model, **Reasoning** and **Speed** in the composer. Use **+** once to add a project folder if needed.
3. Type the task and send it directly. Approve or reject individual permission requests when
   shown. Use **Stop** to end active work.
4. Return to the saved conversation to continue the same native Codex thread.

Model selection is optional. With no selection the native configuration chooses
the model. Sign-in failures point users back to `codex login`. The catalog can
detect installation without claiming that authentication has been verified.

## Changing project and model

The active desktop composer keeps project, model and reasoning controls visible.
The labelled **Reasoning** picker uses the selected model’s advertised efforts.
The **Speed** picker offers Default (local settings), Standard, Fast and Ultrafast.
Fast and Ultrafast use more allowance and require native model/account support;
[official speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed)
explains eligibility and usage. Speed stays unchanged when changing model or effort.

Changing the model, reasoning or speed while idle saves the selection for the next
response in the same app conversation and native Codex thread. Controls are
unavailable during a response or process cleanup; failed saves preserve the old
selection and draft. Loading or refreshing the model catalog never changes an
existing conversation's selection.

Choosing another project opens the new-task composer in that folder. It keeps
the original conversation and draft intact and creates no session until Send.
The project menu labels this action **New chat in project**.

## Runtime behavior

The Rust adapter communicates over stdio with `codex app-server`, using the
[official app-server protocol](https://developers.openai.com/codex/app-server).
It initializes the connection, checks authentication, starts or resumes a native
thread, then submits one turn. It uses workspace-write and on-request approvals.
Native instructions, skills, MCP configuration and credentials remain under
Codex's control. Their availability follows that installation's configuration.

Accepted messages have durable request IDs, so an uncertain network response can
be checked without submitting a second turn. Reload replays saved app events;
continuation resumes the saved native thread ID. If native history is missing,
the app reports the resume error and preserves the conversation. Restarted
unfinished turns are marked interrupted, rather than automatically repeated.
Preview context sent to Codex also uses a saved request ID. Delivery failures
remain visible; retrying the same context keeps the original identity.

Approvals bind to an exact native request and appear in order. File approvals
include the affected paths and proposed diff before the user decides. Stop interrupts
the turn and cleans up its process tree. If cleanup or outcome persistence fails,
the session stays blocked with a retry action. Native private reasoning is not
added to the app transcript. Protocol messages and saved turn output are bounded.

## Initial scope

Supported: text conversations, assistant streaming, command/file/MCP/web tool
results, command/file/permission approvals, Stop, reload and continuation.

Image attachments, active-turn steering, specialized request-user-input forms,
MCP elicitation, and V4-owned compaction/queues are outside this first adapter.
Unsupported server requests receive an explicit protocol error. Organizer
projects and coordination across multiple agents remain separate follow-up work.

Protocol fixtures and the app browser smoke test do not require a real account
or consume model tokens. They verify integration behavior, not live model access
or every third-party tool configured by a user.
