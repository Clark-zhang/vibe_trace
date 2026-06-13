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

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly source = "claude_code" as const;

  constructor(private readonly projectsDir = path.join(os.homedir(), ".claude", "projects")) {}

  async detect(): Promise<DetectResult> {
    const files = await this.getSessionFiles();

    return {
      found: files.length > 0,
      path: this.projectsDir,
      session_count: files.length,
      message: files.length > 0 ? `Found ${files.length} Claude Code JSONL session(s).` : "No Claude Code project sessions found.",
    };
  }

  async listSessions(): Promise<SourceSessionSummary[]> {
    const files = await this.getSessionFiles();
    const summaries = await Promise.all(files.map((file) => this.summarizeFile(file)));
    return summaries.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }

  async importSession(sessionId: string): Promise<Trace> {
    return parseClaudeCodeSessionFile(sessionId);
  }

  private async getSessionFiles(): Promise<string[]> {
    return walkFiles(
      this.projectsDir,
      (filePath) => filePath.endsWith(".jsonl") && !filePath.includes(`${path.sep}subagents${path.sep}`),
    );
  }

  private async summarizeFile(filePath: string): Promise<SourceSessionSummary> {
    const trace = await parseClaudeCodeSessionFile(filePath, { summaryOnly: true });

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

export async function parseClaudeCodeSessionFile(filePath: string, options: ParseOptions = {}): Promise<Trace> {
  const events = parseJsonl(await readFile(filePath, "utf8"));
  const sessionId = asString(events.find((event) => typeof event.sessionId === "string")?.sessionId, path.basename(filePath, ".jsonl"));
  const cwd = asString(events.find((event) => typeof event.cwd === "string")?.cwd, inferWorkspaceFromClaudePath(filePath));
  const gitBranch = asString(events.find((event) => typeof event.gitBranch === "string")?.gitBranch);
  const titleEvent = events.find((event) => event.type === "ai-title" && typeof event.content === "string");
  const messages: TraceMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const fileChanges: FileChange[] = [];
  const baseDate = new Date();

  for (const [index, event] of events.entries()) {
    const rawMessage = asRecord(event.message);
    if (Object.keys(rawMessage).length === 0) {
      continue;
    }

    const content = rawMessage.content;
    const contentBlocks = Array.isArray(content) ? content.map(asRecord) : [];
    const toolUseBlocks = contentBlocks.filter((block) => block.type === "tool_use");
    const toolResultBlocks = contentBlocks.filter((block) => block.type === "tool_result");
    const messageId = asString(event.uuid, stableId("msg", ["claude", sessionId, index, event.timestamp]));
    const role = toolResultBlocks.length > 0 && toolResultBlocks.length === contentBlocks.length ? "tool" : mapRole(rawMessage.role);

    messages.push({
      message_id: messageId,
      role,
      content: stringifyContent(content),
      created_at: toIsoDate(event.timestamp, baseDate),
      model: asString(rawMessage.model) || null,
      parent_id: asString(event.parentUuid) || null,
      tool_call_ids: toolUseBlocks.map((block) => asString(block.id, stableId("tool", ["claude", sessionId, index, block.name]))),
      privacy_findings: [],
      metadata: {
        raw_type: event.type,
        is_sidechain: Boolean(event.isSidechain),
      },
    });

    for (const [blockIndex, block] of toolUseBlocks.entries()) {
      const toolCallId = asString(block.id, stableId("tool", ["claude", sessionId, index, blockIndex]));
      const args = parseJsonObject(block.input);
      toolCalls.push({
        tool_call_id: toolCallId,
        message_id: messageId,
        name: asString(block.name, "unknown_tool"),
        created_at: toIsoDate(event.timestamp, baseDate),
        status: "unknown",
        arguments: args,
        metadata: {},
      });

      const change = fileChangeFromToolUse(toolCallId, block, args);
      if (change) {
        fileChanges.push(change);
      }
    }

    for (const [blockIndex, block] of toolResultBlocks.entries()) {
      const toolCallId = asString(block.tool_use_id, stableId("tool", ["claude", sessionId, index, blockIndex]));
      toolResults.push({
        tool_result_id: stableId("result", ["claude", sessionId, index, blockIndex, toolCallId]),
        tool_call_id: toolCallId,
        created_at: toIsoDate(event.timestamp, baseDate),
        status: block.is_error === true ? "failed" : "unknown",
        content: stringifyContent(block.content) || stringifyContent(event.toolUseResult),
        privacy_findings: [],
        metadata: {},
      });
    }

    if (options.summaryOnly && messages.length >= 2) {
      break;
    }
  }

  const startedAt = toIsoDate(events[0]?.timestamp ?? messages[0]?.created_at, baseDate);
  const endedAt = events.length > 0 ? toIsoDate(events[events.length - 1]?.timestamp, baseDate) : null;
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "";
  const title = compactTitle(asString(titleEvent?.content, firstUserMessage), `Claude Code ${path.basename(filePath, ".jsonl")}`);
  const traceId = stableId("trace", ["claude_code", filePath, sessionId]);

  return assertValidTrace({
    ...createEmptyTrace(),
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: traceId,
    source: "claude_code",
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
      branch: gitBranch || null,
      changed_files: fileChanges.map((change) => change.path),
    }),
    metadata: {
      adapter: "claude_code",
      raw_path: filePath,
      event_count: events.length,
    },
  });
}

function fileChangeFromToolUse(toolCallId: string, block: Record<string, unknown>, args: Record<string, unknown>): FileChange | null {
  const toolName = asString(block.name).toLowerCase();
  if (!["edit", "multiedit", "write", "notebookedit"].includes(toolName)) {
    return null;
  }

  const filePath = asString(args.file_path, asString(args.path));
  if (!filePath) {
    return null;
  }

  return {
    file_change_id: stableId("file", ["claude", toolCallId, filePath]),
    path: filePath,
    change_type: normalizeFileChangeType(toolName === "write" ? "added" : "modified"),
    additions: 0,
    deletions: 0,
    diff: null,
    metadata: {
      tool_call_id: toolCallId,
      tool_name: block.name,
    },
  };
}

function inferWorkspaceFromClaudePath(filePath: string): string {
  const projectsIndex = filePath.split(path.sep).lastIndexOf("projects");
  if (projectsIndex === -1) {
    return process.cwd();
  }

  const encoded = filePath.split(path.sep)[projectsIndex + 1] ?? "";
  if (!encoded || encoded === "-") {
    return process.cwd();
  }

  return encoded.replace(/^-/, path.sep).replaceAll("-", path.sep);
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
