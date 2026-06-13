import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  type FileChange,
  type ToolCall,
  type ToolResult,
  type Trace,
  type TraceMessage,
} from "../schema/types.js";
import { assertValidTrace } from "../schema/validate.js";
import {
  asNumber,
  asRecord,
  asString,
  createEmptyTrace,
  emptyGitState,
  normalizeFileChangeType,
  stableId,
  toIsoDate,
} from "../parser/normalize.js";
import {
  compactTitle,
  mapRole,
  parseJsonObject,
  parseJsonl,
  stringifyContent,
} from "../parser/sourceContent.js";
import { walkFiles } from "./fileWalk.js";
import type { AgentAdapter, DetectResult, SourceSessionSummary } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  readonly source = "codex" as const;

  constructor(
    private readonly sessionRoots = [
      path.join(os.homedir(), ".codex", "sessions"),
      path.join(os.homedir(), ".codex", "archived_sessions"),
    ],
  ) {}

  async detect(): Promise<DetectResult> {
    const files = await this.getSessionFiles();

    return {
      found: files.length > 0,
      path: this.sessionRoots.join(", "),
      session_count: files.length,
      message: files.length > 0 ? `Found ${files.length} Codex JSONL session(s).` : "No Codex sessions found.",
    };
  }

  async listSessions(): Promise<SourceSessionSummary[]> {
    const files = await this.getSessionFiles();
    const summaries = await Promise.all(files.map((file) => this.summarizeFile(file)));
    return summaries.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }

  async importSession(sessionId: string): Promise<Trace> {
    return parseCodexSessionFile(sessionId);
  }

  private async getSessionFiles(): Promise<string[]> {
    const nested = await Promise.all(
      this.sessionRoots.map((root) =>
        walkFiles(root, (filePath) => filePath.endsWith(".jsonl") && !filePath.includes(`${path.sep}.tmp${path.sep}`)),
      ),
    );
    return nested.flat().sort();
  }

  private async summarizeFile(filePath: string): Promise<SourceSessionSummary> {
    const trace = await parseCodexSessionFile(filePath, { summaryOnly: true });

    return {
      source: this.source,
      source_session_id: filePath,
      title: trace.title,
      started_at: trace.started_at,
      workspace_path: trace.workspace.path,
      raw_path: filePath,
    };
  }
}

interface ParseOptions {
  summaryOnly?: boolean;
}

export async function parseCodexSessionFile(filePath: string, options: ParseOptions = {}): Promise<Trace> {
  const events = parseJsonl(await readFile(filePath, "utf8"));
  const baseDate = new Date();
  const sessionMeta = asRecord(events.find((event) => event.type === "session_meta")?.payload);
  const firstTurnContext = asRecord(events.find((event) => event.type === "turn_context")?.payload);
  const sessionId = asString(sessionMeta.id, path.basename(filePath, ".jsonl"));
  const cwd = asString(sessionMeta.cwd, asString(firstTurnContext.cwd, process.cwd()));
  const sessionKind = classifyCodexSession(cwd, sessionMeta);
  const messages: TraceMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const fileChanges: FileChange[] = [];

  for (const [index, event] of events.entries()) {
    const payload = asRecord(event.payload);
    const payloadType = asString(payload.type, asString(event.type));

    if (event.type === "response_item" && payloadType === "message") {
      const role = mapRole(payload.role);
      const content = stringifyContent(payload.content);
      if (content || role !== "system") {
        messages.push({
          message_id: stableId("msg", ["codex", sessionId, index, role, event.timestamp]),
          role,
          content,
          created_at: toIsoDate(event.timestamp, baseDate),
          model: asString(firstTurnContext.model) || null,
          parent_id: messages.at(-1)?.message_id ?? null,
          tool_call_ids: [],
          privacy_findings: [],
          metadata: {
            raw_type: event.type,
            payload_type: payloadType,
          },
        });
      }
    }

    if (event.type === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const toolCallId = asString(payload.call_id, stableId("tool", ["codex", sessionId, index, payload.name]));
      toolCalls.push({
        tool_call_id: toolCallId,
        message_id: messages.at(-1)?.message_id ?? null,
        name: asString(payload.name, payloadType),
        created_at: toIsoDate(event.timestamp, baseDate),
        status: payload.status === "failed" ? "failed" : "unknown",
        arguments: parseJsonObject(payload.arguments ?? payload.input),
        metadata: {
          payload_type: payloadType,
        },
      });
      continue;
    }

    if (event.type === "response_item" && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      const toolCallId = asString(payload.call_id, stableId("tool", ["codex", sessionId, index]));
      toolResults.push({
        tool_result_id: stableId("result", ["codex", sessionId, index, toolCallId]),
        tool_call_id: toolCallId,
        created_at: toIsoDate(event.timestamp, baseDate),
        status: "unknown",
        content: stringifyContent(payload.output),
        privacy_findings: [],
        metadata: {
          payload_type: payloadType,
        },
      });
      continue;
    }

    if (event.type === "event_msg" && payloadType === "patch_apply_end") {
      fileChanges.push(...fileChangesFromCodexPatch(sessionId, index, payload));
    }
  }

  const startedAt = toIsoDate(sessionMeta.timestamp ?? events[0]?.timestamp, baseDate);
  const endedAt = events.length > 0 ? toIsoDate(events[events.length - 1]?.timestamp, baseDate) : null;
  const firstUserMessage = firstVisibleCodexUserMessage(events, messages);
  const title = compactTitle(firstUserMessage, `Codex ${path.basename(filePath, ".jsonl")}`);
  const traceId = stableId("trace", ["codex", filePath, sessionId]);

  return assertValidTrace({
    ...createEmptyTrace(),
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: traceId,
    source: "codex",
    source_session_id: sessionId,
    title,
    workspace: {
      name: path.basename(cwd) || "workspace",
      path: cwd,
      repo_url: null,
    },
    started_at: startedAt,
    ended_at: endedAt,
    messages,
    tool_calls: options.summaryOnly ? [] : toolCalls,
    tool_results: options.summaryOnly ? [] : toolResults,
    file_changes: options.summaryOnly ? [] : dedupeFileChanges(fileChanges),
    checkpoints: [],
    git: emptyGitState({
      repo_root: cwd,
      changed_files: fileChanges.map((change) => change.path),
    }),
    metadata: {
      adapter: "codex",
      raw_path: filePath,
      event_count: events.length,
      originator: sessionMeta.originator ?? null,
      cli_version: sessionMeta.cli_version ?? null,
      codex_source: sessionMeta.source ?? null,
      thread_source: sessionMeta.thread_source ?? null,
      session_kind: sessionKind,
    },
  });
}

export function classifyCodexSession(cwd: string, sessionMeta: Record<string, unknown>): "project" | "chat" | "subagent" {
  if (sessionMeta.thread_source === "subagent") {
    return "subagent";
  }

  if (/\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(cwd)) {
    return "chat";
  }

  if (cwd) {
    return "project";
  }

  return "chat";
}

function firstVisibleCodexUserMessage(events: Record<string, unknown>[], messages: TraceMessage[]): string {
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.type === "event_msg" && payload.type === "user_message") {
      const content = stringifyContent(payload.message ?? payload.text_elements ?? payload.content);
      if (content && !isCodexEnvironmentContext(content)) {
        return content;
      }
    }
  }

  return (
    messages.find(
      (message) => message.role === "user" && !isCodexEnvironmentContext(message.content),
    )?.content ?? ""
  );
}

function isCodexEnvironmentContext(content: string): boolean {
  return content.trim().startsWith("<environment_context>");
}

function fileChangesFromCodexPatch(sessionId: string, index: number, payload: Record<string, unknown>): FileChange[] {
  const changes = Array.isArray(payload.changes) ? payload.changes.map(asRecord) : [];

  const fileChanges: Array<FileChange | null> = changes.map((change, changeIndex) => {
      const filePath = asString(change.path, asString(change.file, asString(change.file_path)));
      if (!filePath) {
        return null;
      }

      return {
        file_change_id: stableId("file", ["codex", sessionId, index, changeIndex, filePath]),
        path: filePath,
        change_type: normalizeFileChangeType(change.change_type ?? change.type ?? "modified"),
        additions: asNumber(change.additions) ?? 0,
        deletions: asNumber(change.deletions) ?? 0,
        diff: null,
        metadata: {
          call_id: payload.call_id ?? null,
          status: payload.status ?? null,
        },
      };
    });

  return fileChanges.filter((change): change is FileChange => Boolean(change));
}

function dedupeFileChanges(changes: FileChange[]): FileChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.path}:${change.change_type}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
