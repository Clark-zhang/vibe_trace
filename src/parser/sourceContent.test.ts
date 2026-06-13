import assert from "node:assert/strict";
import { test } from "node:test";
import { TRACE_SCHEMA_VERSION, type Trace } from "../schema/types.js";
import {
  cleanTitleCandidate,
  deriveTraceDisplayTitle,
  traceWithDisplayTitle,
} from "./sourceContent.js";

test("derives display title after leading environment context", () => {
  const trace = makeTrace("<environment_context><cwd>/tmp/app</cwd></environment_context>", [
    "<environment_context><cwd>/tmp/app</cwd></environment_context>\nBuild a local parser",
  ]);

  assert.equal(deriveTraceDisplayTitle(trace), "Build a local parser");
});

test("uses command args instead of command wrapper tags", () => {
  const title =
    "<command-message>idea-add</command-message><command-name>/idea-add</command-name><command-args>Track import titles</command-args>";
  const trace = makeTrace(title, [title]);

  assert.equal(cleanTitleCandidate(title), "Track import titles");
  assert.equal(deriveTraceDisplayTitle(trace), "Track import titles");
});

test("skips command-only setup messages when deriving display titles", () => {
  const setup =
    "<local-command-caveat>Model changed</local-command-caveat><command-name>/model</command-name>";
  const trace = makeTrace(setup, [setup, "Group Codex sessions by project"]);

  assert.equal(deriveTraceDisplayTitle(trace), "Group Codex sessions by project");
});

test("preserves raw title when replacing an internal display title", () => {
  const trace = makeTrace("<environment_context><cwd>/tmp/app</cwd></environment_context>", [
    "Build the sidebar",
  ]);

  const displayTrace = traceWithDisplayTitle(trace);

  assert.equal(displayTrace.title, "Build the sidebar");
  assert.equal(displayTrace.metadata.raw_title, trace.title);
});

function makeTrace(title: string, userMessages: string[]): Trace {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: "trace-title-test",
    source: "codex",
    source_session_id: "session-title-test",
    title,
    workspace: {
      name: "app",
      path: "/tmp/app",
    },
    started_at: "2026-06-12T00:00:00.000Z",
    messages: userMessages.map((content, index) => ({
      message_id: `message-${index}`,
      role: "user",
      content,
      created_at: "2026-06-12T00:00:00.000Z",
      tool_call_ids: [],
      privacy_findings: [],
      metadata: {},
    })),
    tool_calls: [],
    tool_results: [],
    file_changes: [],
    checkpoints: [],
    git: {
      repo_root: null,
      branch: null,
      head_sha: null,
      is_dirty: false,
      changed_files: [],
      untracked_files: [],
      metadata: {},
    },
    metadata: {},
  };
}
