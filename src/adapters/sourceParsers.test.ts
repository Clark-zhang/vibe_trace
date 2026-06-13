import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseClaudeCodeSessionFile } from "./claudeCodeAdapter.js";
import { classifyCodexSession, parseCodexSessionFile } from "./codexAdapter.js";

test("parses Claude Code JSONL into messages and tool calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibetrace-claude-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "ai-title", content: "Fix auth", timestamp: "2026-06-12T01:00:00.000Z", sessionId: "claude-1", cwd: "/tmp/app", gitBranch: "main" }),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-06-12T01:01:00.000Z", sessionId: "claude-1", cwd: "/tmp/app", message: { role: "user", content: "Please fix auth" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-06-12T01:02:00.000Z", sessionId: "claude-1", cwd: "/tmp/app", message: { role: "assistant", model: "claude", content: [{ type: "tool_use", id: "tool-1", name: "Edit", input: { file_path: "src/auth.ts" } }] } }),
      JSON.stringify({ type: "user", uuid: "t1", parentUuid: "a1", timestamp: "2026-06-12T01:03:00.000Z", sessionId: "claude-1", cwd: "/tmp/app", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } }),
    ].join("\n"),
  );

  const trace = await parseClaudeCodeSessionFile(file);

  assert.equal(trace.source, "claude_code");
  assert.equal(trace.messages.length, 3);
  assert.equal(trace.tool_calls.length, 1);
  assert.equal(trace.tool_results.length, 1);
  assert.equal(trace.file_changes[0]?.path, "src/auth.ts");
});

test("parses Codex JSONL into messages and tool calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibetrace-codex-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-06-12T01:00:00.000Z", payload: { id: "codex-1", cwd: "/tmp/app", timestamp: "2026-06-12T01:00:00.000Z" } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-06-12T01:00:01.000Z", payload: { cwd: "/tmp/app", model: "gpt-5" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-12T01:01:00.000Z", payload: { type: "message", role: "user", content: "Fix auth" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-12T01:02:00.000Z", payload: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"src/auth.ts\"}" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-12T01:03:00.000Z", payload: { type: "function_call_output", call_id: "call-1", output: "content" } }),
    ].join("\n"),
  );

  const trace = await parseCodexSessionFile(file);

  assert.equal(trace.source, "codex");
  assert.equal(trace.title, "Fix auth");
  assert.equal(trace.metadata.session_kind, "project");
  assert.equal(trace.messages.length, 1);
  assert.equal(trace.tool_calls.length, 1);
  assert.equal(trace.tool_results.length, 1);
});

test("classifies Codex dated scratch workspaces as chat sessions", () => {
  assert.equal(
    classifyCodexSession("/Users/clark/Documents/Codex/2026-06-11/ai-coding", {}),
    "chat",
  );
  assert.equal(classifyCodexSession("/Users/clark/Project/vibe_trace", {}), "project");
  assert.equal(classifyCodexSession("/Users/clark/Project/vibe_trace", { thread_source: "subagent" }), "subagent");
});
