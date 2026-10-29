# V4 knowledge and skill packages

V4 owns its account and workspace knowledge formats, editor, storage, review
workflow, and skill packages. A package contains saved text; importing one does
not install dependencies or execute scripts.

## Account and workspace scope

**Settings > Account knowledge** manages personal preferences and reusable
workflows for the current V4 account on the selected host. It loads and saves
`/api/account/knowledge`, without a workspace path. Account knowledge can be used
in V4 requests across that account's workspaces. Paired hosts keep their own
account knowledge.

**Knowledge** beside the workspace controls manages project facts, reusable
skills, and task defaults for the current canonical workspace directory. Its
profile remains separate from account knowledge and from other workspaces.
Selecting context and choosing **Add to prompt** copies the selected instructions
and owned supporting text into an editable draft. Context over 50000 characters
must be reduced before insertion.

## Original V4 skill packages

Choose **Add skill** to create instructions, then add supporting text using safe
relative paths such as `references/checklist.md` or `scripts/check.js`. Each file
can be edited or removed independently. Script text is saved for an agent to
inspect; it is not run by the editor.

**Import V4 skill package** accepts one JSON object:

```json
{
  "name": "Release review",
  "instructions": "Read the checklist before preparing a release.",
  "supportFiles": {
    "references/checklist.md": "Check the release gates and user-facing changes."
  }
}
```

An omitted `id` receives a fresh UUID. An existing UUID can be preserved when
moving a package to another profile; duplicate IDs within one profile are
rejected. Unknown fields are rejected. Importing changes the editable form;
**Save workspace** or **Save account knowledge** is required to persist it.
**Export package JSON** exposes the complete owned package for review and copying.

Limits use UTF-8 bytes where stated:

| Item | Limit |
| --- | --- |
| Saved knowledge text | 6000 characters |
| Skills per profile | 20 |
| Skill name | 80 characters |
| Skill instructions | 6000 characters |
| Combined knowledge, names, instructions | 50000 characters |
| Supporting files per package | 20 |
| Each supporting text file | 64000 bytes |
| Supporting text per package | 128000 bytes |
| Supporting text across a profile | 256000 bytes |
| Serialized proposal | 640000 JSON bytes |

Supporting paths reject traversal, absolute paths, hidden components, credential
files, email archive formats, case collisions, and file/directory collisions.
Support files must be text without binary control characters. JSON encoding adds
overhead; encoded proposal and record limits can therefore be reached before a
text-only budget.

**Tools > Installed skills** remains a read-only discovery and instruction picker
for external host/project skill Markdown. It does not import or execute linked
supporting files, change external packages, or convert them into V4-owned code.

## Reviewed learning

**Tools > Learning** prepares a workspace suggestion request in the active
conversation. Preview the matching complete JSON response, stage it, inspect its
before/after text and supporting-file additions/changes/removals, then accept or
reject it. Staging never updates saved knowledge. Previous values accompany
replacement/removal operations so a stale change can be refused.

**Settings > Account knowledge > Reviewed learning** reviews account proposals
staged through V4's account learning tools. Account and workspace proposal routes
are separate. Accepting an account suggestion updates the account editor. If
manual edits are unsaved, the editor retains them and requires reloading the
reviewed saved profile before a manual save can overwrite it.

See [V4 agent knowledge tools](V4_AGENT_KNOWLEDGE.md) for runtime loading,
materialization, and proposal persistence details.
