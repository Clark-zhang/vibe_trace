import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  type CheckpointReason,
  type FileChangeType,
  type GitState,
  type JsonObject,
  type MessageRole,
  type TestStatus,
  type ToolCallStatus,
  type ToolResultStatus,
  type Trace,
  type TraceMessage,
  type TraceSource,
  type WorkspaceInfo,
} from "../schema/types.js";

export function stableId(prefix: string, parts: unknown[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${hash}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function asRecord(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toIsoDate(value: unknown, fallback = new Date()): string {
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isFinite(date.valueOf())) {
      return date.toISOString();
    }
  }

  return fallback.toISOString();
}

export function normalizeSource(value: unknown): TraceSource {
  const source = asString(value, "unknown");
  const known: TraceSource[] = [
    "codex",
    "claude_code",
    "cursor",
    "cline",
    "kiro",
    "copilot",
    "manual_json",
    "fixture",
    "unknown",
  ];

  return known.includes(source as TraceSource) ? (source as TraceSource) : "unknown";
}

export function normalizeRole(value: unknown): MessageRole {
  const role = asString(value, "assistant");

  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  return "assistant";
}

export function normalizeToolCallStatus(value: unknown): ToolCallStatus {
  const status = asString(value, "unknown");
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "unknown"
  ) {
    return status;
  }

  return "unknown";
}

export function normalizeToolResultStatus(value: unknown): ToolResultStatus {
  const status = asString(value, "unknown");
  return status === "succeeded" || status === "failed" ? status : "unknown";
}

export function normalizeFileChangeType(value: unknown): FileChangeType {
  const changeType = asString(value, "unknown");
  if (
    changeType === "added" ||
    changeType === "modified" ||
    changeType === "deleted" ||
    changeType === "renamed" ||
    changeType === "unknown"
  ) {
    return changeType;
  }

  return "unknown";
}

export function normalizeCheckpointReason(value: unknown): CheckpointReason {
  const reason = asString(value, "user_marked");
  if (
    reason === "before_agent" ||
    reason === "after_edit" ||
    reason === "tests_passed" ||
    reason === "pre_commit" ||
    reason === "commit" ||
    reason === "user_marked"
  ) {
    return reason;
  }

  return "user_marked";
}

export function normalizeTestStatus(value: unknown): TestStatus {
  const status = asString(value, "unknown");
  return status === "passed" || status === "failed" ? status : "unknown";
}

export function normalizeWorkspace(input: unknown): WorkspaceInfo {
  const workspace = asRecord(input);
  const workspacePath = asString(workspace.path, process.cwd());

  return {
    name: asString(workspace.name, path.basename(workspacePath) || "workspace"),
    path: workspacePath,
    repo_url: asNullableString(workspace.repo_url),
  };
}

export function emptyGitState(input: unknown = {}): GitState {
  const git = asRecord(input);

  return {
    repo_root: asNullableString(git.repo_root),
    remote_url: asNullableString(git.remote_url),
    branch: asNullableString(git.branch),
    head_sha: asNullableString(git.head_sha),
    is_dirty: Boolean(git.is_dirty),
    changed_files: asStringArray(git.changed_files),
    untracked_files: asStringArray(git.untracked_files),
    diff: asNullableString(git.diff),
    commit_message: asNullableString(git.commit_message),
    pr_url: asNullableString(git.pr_url),
    issue_url: asNullableString(git.issue_url),
    test_command: asNullableString(git.test_command),
    test_result: normalizeTestStatus(git.test_result),
    metadata: asRecord(git.metadata),
  };
}

export function inferTraceTitle(messages: TraceMessage[], fallback: string): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const rawTitle = firstUserMessage?.content.trim() || fallback;
  const title = rawTitle.replace(/\s+/g, " ").slice(0, 80);
  return title || "Untitled trace";
}

export function createEmptyTrace(overrides: Partial<Trace> = {}): Trace {
  const now = new Date().toISOString();

  return {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: newId("trace"),
    source: "unknown",
    source_session_id: "",
    title: "Untitled trace",
    workspace: normalizeWorkspace({}),
    started_at: now,
    ended_at: null,
    messages: [],
    tool_calls: [],
    tool_results: [],
    file_changes: [],
    checkpoints: [],
    git: emptyGitState(),
    artifacts: [],
    privacy_findings: [],
    redactions: [],
    metadata: {},
    ...overrides,
  };
}
