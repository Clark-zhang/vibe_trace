import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseGenericSession } from "./genericJsonParser.js";
import { validateTrace } from "../schema/validate.js";

const fixturePath = fileURLToPath(
  new URL("../../examples/traces/login-flow.vibetrace.json", import.meta.url),
);

test("validates the canonical fixture trace", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const result = await validateTrace(raw);

  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("parses a generic raw event session into the unified schema", async () => {
  const trace = await parseGenericSession({
    source: "unknown",
    session_id: "raw-session-1",
    title: "Raw session import",
    workspace: {
      name: "demo",
      path: "/tmp/demo",
    },
    events: [
      {
        type: "message",
        role: "user",
        content: "Build a trace list",
        timestamp: "2026-06-12T07:10:00.000Z",
      },
      {
        type: "tool_call",
        name: "read_file",
        arguments: {
          path: "README.md",
        },
        timestamp: "2026-06-12T07:11:00.000Z",
      },
      {
        type: "file_change",
        path: "src/app.ts",
        change_type: "modified",
        additions: 12,
        deletions: 3,
      },
    ],
  });

  assert.equal(trace.schema_version, "0.1.0");
  assert.equal(trace.messages.length, 1);
  assert.equal(trace.tool_calls.length, 1);
  assert.equal(trace.file_changes.length, 1);
  assert.equal(trace.workspace.name, "demo");
});
