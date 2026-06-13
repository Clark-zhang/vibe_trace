import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertValidTrace } from "../schema/validate.js";
import {
  TRACE_SCHEMA_VERSION,
  type Checkpoint,
  type FileChange,
  type JsonObject,
  type ToolCall,
  type ToolResult,
  type Trace,
  type TraceMessage,
  type TraceSource,
} from "../schema/types.js";
import {
  asNullableString,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  createEmptyTrace,
  emptyGitState,
  inferTraceTitle,
  normalizeCheckpointReason,
  normalizeFileChangeType,
  normalizeRole,
  normalizeSource,
  normalizeTestStatus,
  normalizeToolCallStatus,
  normalizeToolResultStatus,
  normalizeWorkspace,
  stableId,
  toIsoDate,
} from "./normalize.js";

export interface GenericParserOptions {
  source?: TraceSource;
  sourceSessionId?: string;
  workspacePath?: string;
  parserVersion?: string;
}

export async function parseTraceFile(
  filePath: string,
  options: GenericParserOptions = {},
): Promise<Trace> {
  const content = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".jsonl" || ext === ".ndjson") {
    const events = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);

    return parseGenericSession(
      {
        source: options.source ?? "manual_json",
        source_session_id: options.sourceSessionId ?? path.basename(filePath),
        workspace: {
          path: options.workspacePath ?? process.cwd(),
        },
        events,
      },
      options,
    );
  }

  return parseGenericSession(JSON.parse(content) as unknown, {
    source: options.source ?? "manual_json",
    sourceSessionId: options.sourceSessionId ?? path.basename(filePath),
    workspacePath: options.workspacePath,
    parserVersion: options.parserVersion,
  });
}

export async function parseGenericSession(
  input: unknown,
  options: GenericParserOptions = {},
): Promise<Trace> {
  const raw = asRecord(input);

  if (raw.schema_version === TRACE_SCHEMA_VERSION && Array.isArray(raw.messages)) {
    return assertValidTrace(raw);
  }

  const events = Array.isArray(raw.events) ? raw.events.map(asRecord) : [];
  const rawMessages = collectRecords(raw.messages, events, "message");
  const rawToolCalls = collectRecords(raw.tool_calls, events, "tool_call");
  const rawToolResults = collectRecords(raw.tool_results, events, "tool_result");
  const rawFileChanges = collectRecords(raw.file_changes, events, "file_change");
  const rawCheckpoints = collectRecords(raw.checkpoints, events, "checkpoint");
  const baseDate = new Date();
  const sourceSessionId =
    options.sourceSessionId ||
    asString(raw.source_session_id, asString(raw.session_id, stableId("session", [raw])));

  const traceId = asString(
    raw.trace_id,
    stableId("trace", [sourceSessionId, raw.started_at, raw.title]),
  );

  const messages = rawMessages.map((message, index) =>
    normalizeMessage(message, traceId, index, baseDate),
  );
  const toolCalls = rawToolCalls.map((toolCall, index) =>
    normalizeToolCall(toolCall, index, baseDate),
  );
  const toolResults = rawToolResults.map((toolResult, index) =>
    normalizeToolResult(toolResult, index, baseDate),
  );
  const fileChanges = rawFileChanges.map((fileChange, index) =>
    normalizeFileChange(fileChange, index),
  );
  const checkpoints = rawCheckpoints.map((checkpoint, index) =>
    normalizeCheckpoint(checkpoint, traceId, index, baseDate),
  );

  const startedAt =
    asNullableString(raw.started_at) ??
    messages[0]?.created_at ??
    toolCalls[0]?.created_at ??
    baseDate.toISOString();

  const trace = createEmptyTrace({
    trace_id: traceId,
    source: options.source ?? normalizeSource(raw.source),
    source_session_id: sourceSessionId,
    title: asString(raw.title, inferTraceTitle(messages, "Imported trace")),
    summary: asNullableString(raw.summary) ?? undefined,
    workspace: normalizeWorkspace({
      ...asRecord(raw.workspace),
      path:
        asRecord(raw.workspace).path ??
        options.workspacePath ??
        process.cwd(),
    }),
    started_at: toIsoDate(startedAt, baseDate),
    ended_at: asNullableString(raw.ended_at),
    messages,
    tool_calls: toolCalls,
    tool_results: toolResults,
    file_changes: fileChanges,
    checkpoints,
    git: emptyGitState(raw.git),
    artifacts: [],
    privacy_findings: [],
    redactions: [],
    metadata: {
      ...asRecord(raw.metadata),
      parser: "generic_json",
      parser_version: options.parserVersion ?? "0.1.0",
    },
  });

  return assertValidTrace(trace);
}

function collectRecords(
  directValue: unknown,
  events: JsonObject[],
  eventType: string,
): JsonObject[] {
  const directRecords = Array.isArray(directValue) ? directValue.map(asRecord) : [];
  const eventRecords = events
    .filter((event) => asString(event.type) === eventType)
    .map((event) => asRecord(event.payload ?? event));

  return [...directRecords, ...eventRecords];
}

function normalizeMessage(
  raw: JsonObject,
  traceId: string,
  index: number,
  fallbackDate: Date,
): TraceMessage {
  return {
    message_id: asString(
      raw.message_id,
      stableId("msg", [traceId, index, raw.role, raw.content, raw.created_at]),
    ),
    role: normalizeRole(raw.role),
    content: asString(raw.content, ""),
    created_at: toIsoDate(raw.created_at ?? raw.timestamp, fallbackDate),
    model: asNullableString(raw.model),
    parent_id: asNullableString(raw.parent_id),
    tool_call_ids: asStringArray(raw.tool_call_ids),
    privacy_findings: [],
    metadata: asRecord(raw.metadata),
  };
}

function normalizeToolCall(
  raw: JsonObject,
  index: number,
  fallbackDate: Date,
): ToolCall {
  const toolCallId = asString(
    raw.tool_call_id,
    stableId("tool", [index, raw.name, raw.created_at, raw.arguments]),
  );

  return {
    tool_call_id: toolCallId,
    message_id: asNullableString(raw.message_id),
    name: asString(raw.name, asString(raw.tool_name, "unknown_tool")),
    created_at: toIsoDate(raw.created_at ?? raw.timestamp, fallbackDate),
    status: normalizeToolCallStatus(raw.status),
    arguments: asRecord(raw.arguments ?? raw.input),
    metadata: asRecord(raw.metadata),
  };
}

function normalizeToolResult(
  raw: JsonObject,
  index: number,
  fallbackDate: Date,
): ToolResult {
  const toolCallId = asString(raw.tool_call_id, stableId("tool", [index, raw.name]));

  return {
    tool_result_id: asString(
      raw.tool_result_id,
      stableId("result", [toolCallId, index, raw.content, raw.created_at]),
    ),
    tool_call_id: toolCallId,
    created_at: toIsoDate(raw.created_at ?? raw.timestamp, fallbackDate),
    status: normalizeToolResultStatus(raw.status),
    content: asString(raw.content, asString(raw.output, "")),
    privacy_findings: [],
    metadata: asRecord(raw.metadata),
  };
}

function normalizeFileChange(raw: JsonObject, index: number): FileChange {
  const filePath = asString(raw.path, asString(raw.file_path, "unknown"));

  return {
    file_change_id: asString(
      raw.file_change_id,
      stableId("file", [index, filePath, raw.change_type, raw.diff]),
    ),
    path: filePath,
    change_type: normalizeFileChangeType(raw.change_type ?? raw.status),
    old_path: asNullableString(raw.old_path),
    language: asNullableString(raw.language),
    additions: asNumber(raw.additions),
    deletions: asNumber(raw.deletions),
    diff: asNullableString(raw.diff),
    metadata: asRecord(raw.metadata),
  };
}

function normalizeCheckpoint(
  raw: JsonObject,
  traceId: string,
  index: number,
  fallbackDate: Date,
): Checkpoint {
  const git = asRecord(raw.git);

  return {
    checkpoint_id: asString(
      raw.checkpoint_id,
      stableId("checkpoint", [traceId, index, raw.label, raw.created_at]),
    ),
    trace_id: asString(raw.trace_id, traceId),
    label: asString(raw.label, `Checkpoint ${index + 1}`),
    kind: asString(raw.kind) === "auto" ? "auto" : "manual",
    reason: normalizeCheckpointReason(raw.reason),
    created_at: toIsoDate(raw.created_at ?? raw.timestamp, fallbackDate),
    git: {
      repo_root: asNullableString(git.repo_root),
      branch: asNullableString(git.branch),
      head_sha: asNullableString(git.head_sha),
      hidden_ref: asNullableString(git.hidden_ref),
      is_dirty: Boolean(git.is_dirty),
    },
    diff_ref: asNullableString(raw.diff_ref),
    test_status: normalizeTestStatus(raw.test_status),
    metadata: asRecord(raw.metadata),
  };
}
