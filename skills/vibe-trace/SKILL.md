---
name: vibe-trace
description: Capture, normalize, inspect, validate, and prepare local-first AI coding session traces with the Vibe Trace schema. Use when Codex needs to create or repair `.vibetrace.json` files, convert Codex/Claude Code/Cursor/manual histories into a unified trace, design or update Vibe Trace adapters, reason about checkpoints and Git state, run a local trace viewer/import workflow, or prepare a trace for privacy review and optional publishing.
---

# Vibe Trace

## Overview

Use Vibe Trace to turn AI coding work into a local-first, replayable trace: messages, tool calls, tool results, file changes, Git state, checkpoints, artifacts, privacy findings, redactions, and publish metadata.

Default to local-only behavior. Do not upload or publish a trace unless the user explicitly asks for it and has reviewed privacy findings.

## Quick Start

1. Identify the task:
   - Create a new trace JSON: run `scripts/create_trace_skeleton.py`.
   - Validate or repair an existing trace: run `scripts/check_trace.py` and load `references/trace.schema.json` as needed.
   - Convert agent history: follow the adapter workflow in `references/vibe-trace-guide.md`.
   - Run or inspect the local UI: use `npm run dev`, then report the `Vibe Trace local UI: ...` URL printed by the server.
   - Prepare for sharing: run validation, inspect privacy findings, redact locally, then ask for explicit publish confirmation.
2. Preserve raw intent:
   - Keep user prompts, assistant summaries, tool names, command snippets, file paths, diffs, test commands, and checkpoint labels.
   - Prefer compact summaries for huge tool output, but keep enough detail for replay and review.
3. Validate before delivering:
   - `python3 <skill>/scripts/check_trace.py path/to/file.vibetrace.json`
   - If the trace is generated during the task, validate the final file and report the result.

## Trace Rules

- Use schema version `0.1.0`.
- Use source values from the schema: `codex`, `claude_code`, `cursor`, `cline`, `kiro`, `copilot`, `manual_json`, `fixture`, or `unknown`.
- Keep IDs stable within a trace. Link `TraceMessage.tool_call_ids` to `ToolCall.tool_call_id`, and link `ToolResult.tool_call_id` to an existing tool call.
- Store Git information even when partial. Use `null` for unknown `repo_root`, `branch`, or `head_sha`; use empty arrays for changed or untracked files.
- Record checkpoints as Git-native recovery points when possible. Prefer commit SHAs or hidden refs such as `refs/vibetrace/<trace_id>/<checkpoint_id>`.
- Put suspicious secrets in `privacy_findings` and corresponding replacements in `redactions`; do not silently drop sensitive content without noting what changed.
- The local UI defaults to `http://127.0.0.1:4317`, but the server may use a nearby port when the default is busy. Trust the startup log or verify `/api/health` before reporting the URL.

## Adapter Workflow

When adding or updating an adapter:

1. Detect the source data location and count sessions without importing everything.
2. List sessions with source, source session ID, title, start time, workspace path, and raw path when available.
3. Import one session into the unified Trace shape.
4. Preserve parser metadata, including source format hints and parser version.
5. Add or update fixture data for the source format.
6. Validate the produced trace with `scripts/check_trace.py`.

Read `references/vibe-trace-guide.md` for the adapter interface, source priorities, local import command shape, checkpoint guidance, and privacy requirements.

## Resources

- `references/trace.schema.json`: the canonical JSON Schema for `.vibetrace.json`.
- `references/vibe-trace-guide.md`: compact product, schema, adapter, checkpoint, privacy, and publishing guidance.
- `assets/examples/login-flow.vibetrace.json`: a valid example trace with messages, tool calls, file changes, Git state, checkpoint, and publish metadata.
- `scripts/create_trace_skeleton.py`: create a valid starter trace from CLI arguments.
- `scripts/check_trace.py`: validate trace JSON; uses `jsonschema` if installed and always runs Vibe Trace structural checks.
