# Vibe Trace Guide

## Product Shape

Vibe Trace is local-first tooling for AI coding traces. It normalizes sessions from tools such as Codex, Claude Code, Cursor, Cline, Kiro, Copilot, or manual JSON into one schema, then lets users browse, search, restore checkpoints, and optionally publish after privacy review.

The client-side path is:

```text
Coding agent history
  -> adapter or parser
  -> unified Trace schema
  -> local store
  -> local Web UI
  -> optional publish flow
```

Default behavior is local-only. Uploading, public sharing, cross-device sync, or team collaboration requires explicit user intent.

## Core Objects

Use the JSON Schema in `trace.schema.json` as the source of truth. The central objects are:

- `Trace`: top-level session with source, title, workspace, timestamps, arrays, Git state, metadata.
- `TraceMessage`: user, assistant, system, and tool messages.
- `ToolCall` and `ToolResult`: tool invocation records and outputs.
- `FileChange`: file path, change type, language, counts, optional diff.
- `GitState`: repo root, remote URL, branch, HEAD SHA, dirty status, changed files, test command/result.
- `Checkpoint`: manual or automatic recovery point linked to Git state.
- `Artifact`: related file, image, video, log, report, or other output.
- `PrivacyFinding` and `Redaction`: local privacy scan results and replacements.
- `PublishMetadata`: visibility, tags, description, outcome, and published URL.

## Local Repository Workflow

For the Vibe Trace app repository:

```bash
npm install
npm run dev
npm run import:local
npm test
npm run typecheck
npm run build
```

The local server is expected at `http://localhost:4317`. `npm run import:local` scans supported local agent histories and writes unified trace JSON files under `VIBETRACE_HOME` or `~/.vibetrace`.

Useful smoke imports:

```bash
npm run import:local -- --limit-per-source=3
npm run import:local -- --sources=codex,claude_code
```

## Adapter Interface

Each coding agent should have a focused adapter with this shape:

```ts
interface AgentAdapter {
  source: TraceSource;
  detect(): Promise<DetectResult>;
  listSessions(): Promise<SourceSessionSummary[]>;
  importSession(sessionId: string): Promise<Trace>;
  validateRaw?(raw: unknown): Promise<ValidationResult>;
}
```

Adapter responsibilities:

- Find local data for one agent or source format.
- Read raw chat history, tool calls, files, timestamps, workspace metadata, and model hints.
- Convert to the unified Trace schema.
- Preserve parser/source metadata for debugging future format changes.
- Support fixtures and regression tests for representative raw formats.

Recommended source priority for MVP work:

1. Cursor or existing chat-history plugin data.
2. Claude Code.
3. Codex.
4. Cline, Kiro, Copilot, and other sources.

If a source is difficult to read automatically, support manual upload or manual JSON first.

## Checkpoints and Git

Git records what changed; the trace records why it changed and how the agent participated.

Record:

- repository root
- remote URL
- branch
- HEAD commit
- dirty status
- changed and untracked files
- diff when useful and safe
- commit message
- PR or issue URLs
- test command and test result

Checkpoint timing:

- before an agent session
- after a user prompt
- after file edits
- after tests pass
- before and after commit
- when a PR is created
- when the user explicitly marks a point

Prefer Git-native recovery:

- For clean states, record the commit SHA.
- For dirty states, create a hidden ref or store a patch reference.
- Restore into a new worktree by default instead of overwriting the current working tree.

Example hidden ref:

```text
refs/vibetrace/<trace_id>/<checkpoint_id>
```

## Privacy and Publishing

Run local privacy review before any upload or public display. Scan for:

- API keys, access tokens, SSH keys, private keys
- `.env` content, cookies, sessions
- database URLs, webhook URLs
- internal IPs and domains
- email addresses and phone numbers
- local absolute paths
- private repository URLs
- company, customer, or project-sensitive names

Prefer replacements over deletion so the trace remains readable:

```text
sk-... -> [REDACTED_API_KEY]
postgres://user:pass@host/db -> [REDACTED_DATABASE_URL]
/Users/name/Project/app -> [REDACTED_LOCAL_PATH]
```

Publishing checklist:

1. Validate the trace.
2. Run or perform a privacy scan.
3. Apply redactions locally.
4. Show the user what was found and replaced.
5. Ask for explicit confirmation before upload or public sharing.
