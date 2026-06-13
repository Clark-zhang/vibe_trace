import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "../adapters/index.js";
import { TRACE_SCHEMA_VERSION, type Trace } from "../schema/types.js";
import { LocalTraceStore } from "./store.js";
import { SyncService } from "./sync.js";

test("sync service imports changed sessions and skips unchanged sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibetrace-sync-"));
  const store = new LocalTraceStore(root);
  let title = "First title";
  let importCount = 0;
  const adapter: AgentAdapter = {
    source: "codex",
    async detect() {
      return {
        found: true,
        session_count: 1,
      };
    },
    async listSessions() {
      return [
        {
          source: "codex",
          source_session_id: "session-sync-test",
          title,
          started_at: "2026-06-12T00:00:00.000Z",
          workspace_path: "/tmp/sync-app",
        },
      ];
    },
    async importSession() {
      importCount += 1;
      return makeTrace(`Imported ${importCount}`);
    },
  };
  const service = new SyncService({
    store,
    adapters: [adapter],
    sources: ["codex"],
  });

  const first = await service.runNow();
  const second = await service.runNow();
  title = "Changed title";
  const third = await service.runNow();

  assert.equal(first.imported, 1);
  assert.equal(second.unchanged, 1);
  assert.equal(third.imported, 1);
  assert.equal(importCount, 2);

  const saved = JSON.parse(await readFile(store.tracePath("trace-sync-test"), "utf8")) as Trace;
  assert.equal(saved.messages[0]?.content, "Imported 2");
});

function makeTrace(content: string): Trace {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: "trace-sync-test",
    source: "codex",
    source_session_id: "session-sync-test",
    title: "Sync test",
    workspace: {
      name: "sync-app",
      path: "/tmp/sync-app",
    },
    started_at: "2026-06-12T00:00:00.000Z",
    messages: [
      {
        message_id: "message-sync-test",
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
    metadata: {},
  };
}
