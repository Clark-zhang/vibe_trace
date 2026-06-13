import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TRACE_SCHEMA_VERSION, type Trace } from "../schema/types.js";
import { LocalTraceStore } from "./store.js";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("summarizes user message images without embedding base64 in the list response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const store = new LocalTraceStore(root);
  const trace = makeTrace(
    [
      "Can this image render?",
      JSON.stringify({
        type: "input_image",
        image_url: `data:image/png;base64,${tinyPng}`,
        detail: "high",
      }),
    ].join("\n\n"),
  );

  await store.saveTrace(trace);

  const result = await store.listUserMessages();
  const message = result.messages[0];

  assert.equal(result.messages.length, 1);
  assert.equal(message.content, "Can this image render?");
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0]?.mime_type, "image/png");
  assert.equal(message.images[0]?.detail, "high");
  assert.match(message.images[0]?.src ?? "", /^\/api\/traces\/trace-image-test\/messages\/message-image-test\/images\/0$/);

  const image = await store.getUserMessageImage("trace-image-test", "message-image-test", 0);

  assert.equal(image?.mime_type, "image/png");
  assert.deepEqual(image?.data, Buffer.from(tinyPng, "base64"));
});

test("summarizes Claude image source blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const store = new LocalTraceStore(root);
  const trace = makeTrace(
    [
      "Inspect this snapshot.",
      JSON.stringify({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: tinyPng,
        },
      }),
    ].join("\n\n"),
    { source: "claude_code" },
  );

  await store.saveTrace(trace);

  const result = await store.listUserMessages();
  const message = result.messages[0];

  assert.equal(message.content, "Inspect this snapshot.");
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0]?.mime_type, "image/png");

  const image = await store.getUserMessageImage("trace-image-test", "message-image-test", 0);
  assert.deepEqual(image?.data, Buffer.from(tinyPng, "base64"));
});

test("summarizes Claude Code image cache source markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const imagePath = path.join(root, "5.png");
  await writeFile(imagePath, Buffer.from(tinyPng, "base64"));

  const store = new LocalTraceStore(root);
  const trace = makeTrace(`[Image: source: ${imagePath}]`, { source: "claude_code" });

  await store.saveTrace(trace);

  const result = await store.listUserMessages();
  const message = result.messages[0];

  assert.equal(result.messages.length, 1);
  assert.equal(message.content, "");
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0]?.mime_type, "image/png");
  assert.match(message.images[0]?.src ?? "", /^\/api\/traces\/trace-image-test\/messages\/message-image-test\/images\/0$/);

  const image = await store.getUserMessageImage("trace-image-test", "message-image-test", 0);
  assert.equal(image?.mime_type, "image/png");
  assert.deepEqual(image?.data, Buffer.from(tinyPng, "base64"));
});

test("does not treat ordinary JSON urls as user message images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const store = new LocalTraceStore(root);
  const trace = makeTrace(`# 本轮召唤

\`\`\`json
{
  "samples": [
    { "url": "https://progressreads.com/", "status": 200 },
    { "url": "https://progressreads.com/healthz", "status": 200 }
  ]
}
\`\`\`
`);

  await store.saveTrace(trace);

  const result = await store.listUserMessages();

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.images.length, 0);
});

test("builds project replay turns with compact agent activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const store = new LocalTraceStore(root);
  const trace = makeReplayTrace();

  await store.saveTrace(trace);

  const replay = await store.getProjectReplay({
    workspace: "/tmp/replay-app",
    limit: 10,
  });

  assert.equal(replay.stats.turn_count, 2);
  assert.equal(replay.stats.shown_turn_count, 2);
  assert.equal(replay.stats.tool_call_count, 2);
  assert.equal(replay.turns[0]?.user.content, "First request");
  assert.equal(replay.turns[0]?.agent.message_count, 1);
  assert.equal(replay.turns[0]?.agent.tool_call_count, 1);
  assert.equal(replay.turns[0]?.agent.file_change_count, 0);
  assert.deepEqual(replay.turns[0]?.agent.tool_call_types, [{ name: "exec_command", count: 1 }]);
  assert.equal(replay.turns[1]?.user.content, "Second request");
  assert.equal(replay.turns[1]?.agent.tool_call_count, 1);
  assert.equal(replay.turns[1]?.agent.file_change_count, 2);
  assert.deepEqual(replay.turns[1]?.agent.tool_call_types, [{ name: "apply_patch", count: 1 }]);
});

test("excludes Codex chat sessions from project replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-store-"));
  const store = new LocalTraceStore(root);
  const projectTrace = makeReplayTrace();
  const chatTrace = makeReplayTrace();

  chatTrace.trace_id = "trace-replay-chat-test";
  chatTrace.source_session_id = "session-replay-chat-test";
  chatTrace.title = "Codex chat scratch";
  chatTrace.metadata = {
    session_kind: "chat",
  };
  chatTrace.messages = chatTrace.messages.map((message) => ({
    ...message,
    content: message.role === "user" ? `Chat ${message.content}` : message.content,
  }));

  await store.saveTrace(projectTrace);
  await store.saveTrace(chatTrace);

  const replay = await store.getProjectReplay({
    workspace: "/tmp/replay-app",
    limit: 10,
  });

  assert.equal(replay.stats.trace_count, 1);
  assert.equal(replay.stats.turn_count, 2);
  assert.equal(replay.turns.some((turn) => turn.session_kind === "chat"), false);
  assert.equal(replay.turns.some((turn) => turn.user.content.startsWith("Chat ")), false);
});

function makeTrace(content: string, options: Partial<Pick<Trace, "source">> = {}): Trace {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: "trace-image-test",
    source: options.source ?? "codex",
    source_session_id: "session-image-test",
    title: "Image test",
    workspace: {
      name: "image-app",
      path: "/tmp/image-app",
    },
    started_at: "2026-06-12T00:00:00.000Z",
    messages: [
      {
        message_id: "message-image-test",
        role: "user",
        content,
        created_at: "2026-06-12T00:00:00.000Z",
        tool_call_ids: [],
        privacy_findings: [],
        metadata: {},
      },
    ],
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
    metadata: {
      session_kind: "project",
    },
  };
}

function makeReplayTrace(): Trace {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: "trace-replay-test",
    source: "codex",
    source_session_id: "session-replay-test",
    title: "Replay test",
    workspace: {
      name: "replay-app",
      path: "/tmp/replay-app",
    },
    started_at: "2026-06-12T00:00:00.000Z",
    ended_at: "2026-06-12T00:12:00.000Z",
    messages: [
      {
        message_id: "user-1",
        role: "user",
        content: "First request",
        created_at: "2026-06-12T00:01:00.000Z",
        tool_call_ids: [],
        privacy_findings: [],
        metadata: {},
      },
      {
        message_id: "assistant-1",
        role: "assistant",
        content: "I inspected the app.",
        created_at: "2026-06-12T00:02:00.000Z",
        tool_call_ids: ["tool-1"],
        privacy_findings: [],
        metadata: {},
      },
      {
        message_id: "user-2",
        role: "user",
        content: "Second request",
        created_at: "2026-06-12T00:08:00.000Z",
        tool_call_ids: [],
        privacy_findings: [],
        metadata: {},
      },
      {
        message_id: "assistant-2",
        role: "assistant",
        content: "I patched the UI.",
        created_at: "2026-06-12T00:09:00.000Z",
        tool_call_ids: ["tool-2"],
        privacy_findings: [],
        metadata: {},
      },
    ],
    tool_calls: [
      {
        tool_call_id: "tool-1",
        message_id: "assistant-1",
        name: "exec_command",
        created_at: "2026-06-12T00:02:10.000Z",
        arguments: {},
        metadata: {},
      },
      {
        tool_call_id: "tool-2",
        message_id: "assistant-2",
        name: "apply_patch",
        created_at: "2026-06-12T00:09:10.000Z",
        arguments: {},
        metadata: {},
      },
    ],
    tool_results: [],
    file_changes: [
      {
        file_change_id: "file-1",
        path: "public/app.js",
        change_type: "modified",
        additions: 20,
        deletions: 4,
        metadata: {},
      },
      {
        file_change_id: "file-2",
        path: "public/styles.css",
        change_type: "modified",
        additions: 30,
        deletions: 2,
        metadata: {},
      },
    ],
    checkpoints: [
      {
        checkpoint_id: "checkpoint-1",
        trace_id: "trace-replay-test",
        label: "after patch",
        kind: "auto",
        reason: "after_edit",
        created_at: "2026-06-12T00:09:30.000Z",
        git: {
          repo_root: "/tmp/replay-app",
          branch: "main",
          head_sha: "abcdef123456",
          hidden_ref: null,
          is_dirty: true,
        },
        test_status: "unknown",
        metadata: {},
      },
    ],
    git: {
      repo_root: "/tmp/replay-app",
      branch: "main",
      head_sha: "abcdef123456",
      is_dirty: true,
      changed_files: ["public/app.js", "public/styles.css"],
      untracked_files: [],
      metadata: {},
    },
    metadata: {
      session_kind: "project",
    },
  };
}
