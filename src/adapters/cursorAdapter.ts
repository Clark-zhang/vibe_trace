import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  TRACE_SCHEMA_VERSION,
  type FileChange,
  type JsonObject,
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
  extractPathFromUri,
  stringifyContent,
} from "../parser/sourceContent.js";
import type { AgentAdapter, DetectResult, SourceSessionSummary } from "./types.js";

const execFileAsync = promisify(execFile);

export class CursorAdapter implements AgentAdapter {
  readonly source = "cursor" as const;

  constructor(
    private readonly stateDb = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  ) {}

  async detect(): Promise<DetectResult> {
    if (!(await sqliteAvailable())) {
      return {
        found: false,
        path: this.stateDb,
        message: "sqlite3 CLI is not available.",
      };
    }

    try {
      const count = Number(await sqliteScalar(this.stateDb, "select count(*) from cursorDiskKV where key like 'composerData:%';"));
      return {
        found: count > 0,
        path: this.stateDb,
        session_count: count,
        message: count > 0 ? `Found ${count} Cursor composer session(s).` : "No Cursor composer sessions found.",
      };
    } catch (error) {
      return {
        found: false,
        path: this.stateDb,
        message: error instanceof Error ? error.message : "Unable to inspect Cursor state database.",
      };
    }
  }

  async listSessions(): Promise<SourceSessionSummary[]> {
    const headers = await this.readComposerHeaders();

    return headers
      .filter((header) => typeof header.composerId === "string" && header.isDraft !== true)
      .map((header) => {
        const workspacePath = workspacePathFromCursorHeader(header);
        return {
          source: this.source,
          source_session_id: asString(header.composerId),
          title: compactTitle(asString(header.name, asString(header.subtitle)), `Cursor ${asString(header.composerId).slice(0, 8)}`),
          started_at: toIsoDate(header.createdAt ?? header.lastUpdatedAt),
          workspace_path: workspacePath ?? undefined,
          raw_path: this.stateDb,
        };
      })
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }

  async importSession(sessionId: string): Promise<Trace> {
    const headers = await this.readComposerHeaders();
    const header = headers.find((item) => item.composerId === sessionId) ?? {};
    return parseCursorComposer(sessionId, this.stateDb, header);
  }

  private async readComposerHeaders(): Promise<JsonObject[]> {
    const rows = await sqliteJsonRows<{ value: string }>(
      this.stateDb,
      "select cast(value as text) as value from ItemTable where key='composer.composerHeaders';",
    );
    const raw = rows[0]?.value;
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    const container = asRecord(parsed);
    const composers = Array.isArray(container.allComposers) ? container.allComposers : [];
    return composers.map(asRecord);
  }
}

export async function parseCursorComposer(sessionId: string, stateDb: string, header: JsonObject = {}): Promise<Trace> {
  const composerData = await readCursorJsonValue(stateDb, `composerData:${sessionId}`);
  const bubbleHeaders = Array.isArray(composerData.fullConversationHeadersOnly)
    ? composerData.fullConversationHeadersOnly.map(asRecord)
    : [];
  const bubbleMap = await readCursorBubbles(
    stateDb,
    sessionId,
    bubbleHeaders.map((bubble) => asString(bubble.bubbleId)).filter(Boolean),
  );
  const messages: TraceMessage[] = [];
  const fileChanges: FileChange[] = [];
  const workspacePath =
    workspacePathFromCursorHeader(header) ??
    asString(composerData.workspaceProjectDir) ??
    extractPathFromUri(Array.isArray(composerData.workspaceUris) ? composerData.workspaceUris[0] : null) ??
    process.cwd();
  const startedAt = toIsoDate(header.createdAt ?? composerData.createdAt);
  const endedAt = toIsoDate(header.lastUpdatedAt ?? header.conversationCheckpointLastUpdatedAt ?? composerData.createdAt);

  for (const [index, bubbleHeader] of bubbleHeaders.entries()) {
    const bubbleId = asString(bubbleHeader.bubbleId);
    const bubble = bubbleMap.get(bubbleId);
    if (!bubble) {
      continue;
    }

    const content = stringifyContent(bubble.text || bubble.richText || bubble.thinking);
    if (!content) {
      continue;
    }

    const role = bubble.type === 1 ? "user" : bubble.type === 2 ? "assistant" : "assistant";
    messages.push({
      message_id: stableId("msg", ["cursor", sessionId, bubbleId, index]),
      role,
      content,
      created_at: toIsoDate(bubble.createdAt ?? header.createdAt),
      model: asString(bubble.modelName, asString(asRecord(composerData.modelConfig).selectedModel)) || null,
      parent_id: messages.at(-1)?.message_id ?? null,
      tool_call_ids: [],
      privacy_findings: [],
      metadata: {
        bubble_id: bubbleId,
        bubble_type: bubble.type ?? null,
        request_id: bubble.requestId ?? null,
      },
    });

    fileChanges.push(...fileChangesFromCursorBubble(sessionId, bubbleId, bubble));
  }

  if (messages.length === 0) {
    const titleMessage = asString(header.subtitle, asString(composerData.text, asString(composerData.richText)));
    if (titleMessage) {
      messages.push({
        message_id: stableId("msg", ["cursor", sessionId, "summary"]),
        role: "assistant",
        content: titleMessage,
        created_at: startedAt,
        model: null,
        parent_id: null,
        tool_call_ids: [],
        privacy_findings: [],
        metadata: {
          synthesized_from: "composer_header",
        },
      });
    }
  }

  const headerTitle = compactTitle(asString(header.name, asString(header.subtitle)), `Cursor ${sessionId.slice(0, 8)}`);
  const traceId = stableId("trace", ["cursor", sessionId]);

  return assertValidTrace({
    ...createEmptyTrace(),
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: traceId,
    source: "cursor",
    source_session_id: sessionId,
    title: headerTitle,
    workspace: {
      name: path.basename(workspacePath) || "workspace",
      path: workspacePath,
      repo_url: null,
    },
    started_at: startedAt,
    ended_at: endedAt,
    messages,
    tool_calls: [],
    tool_results: [],
    file_changes: dedupeFileChanges(fileChanges),
    checkpoints: [],
    git: emptyGitState({
      repo_root: workspacePath,
      changed_files: fileChanges.map((change) => change.path),
    }),
    metadata: {
      adapter: "cursor",
      composer_id: sessionId,
      state_db: stateDb,
      unified_mode: header.unifiedMode ?? composerData.unifiedMode ?? null,
      total_lines_added: header.totalLinesAdded ?? composerData.totalLinesAdded ?? null,
      total_lines_removed: header.totalLinesRemoved ?? composerData.totalLinesRemoved ?? null,
      files_changed_count: header.filesChangedCount ?? null,
      is_archived: header.isArchived ?? composerData.isArchived ?? null,
    },
  });
}

async function readCursorJsonValue(stateDb: string, key: string): Promise<JsonObject> {
  const rows = await sqliteJsonRows<{ value: string }>(
    stateDb,
    `select cast(value as text) as value from cursorDiskKV where key=${sqlString(key)};`,
  );
  const raw = rows[0]?.value;
  return raw ? asRecord(JSON.parse(raw) as unknown) : {};
}

async function readCursorBubbles(stateDb: string, composerId: string, bubbleIds: string[]): Promise<Map<string, JsonObject>> {
  const prefix = `bubbleId:${composerId}:`;
  if (bubbleIds.length === 0) {
    return new Map();
  }

  const keys = bubbleIds.map((bubbleId) => `${prefix}${bubbleId}`);
  const rows = await sqliteJsonRows<{
    key: string;
    bubbleId?: string;
    type?: number;
    text?: string;
    richText?: string;
    createdAt?: string;
    requestId?: string;
    modelName?: string;
    workspaceProjectDir?: string;
  }>(
    stateDb,
    `select
      key,
      json_extract(cast(value as text), '$.bubbleId') as bubbleId,
      json_extract(cast(value as text), '$.type') as type,
      json_extract(cast(value as text), '$.text') as text,
      json_extract(cast(value as text), '$.richText') as richText,
      json_extract(cast(value as text), '$.createdAt') as createdAt,
      json_extract(cast(value as text), '$.requestId') as requestId,
      json_extract(cast(value as text), '$.modelInfo.name') as modelName,
      json_extract(cast(value as text), '$.workspaceProjectDir') as workspaceProjectDir
    from cursorDiskKV
    where key in (${keys.map(sqlString).join(",")});`,
  );
  const map = new Map<string, JsonObject>();

  for (const row of rows) {
    const bubbleId = asString(row.bubbleId, row.key.slice(prefix.length));
    map.set(bubbleId, asRecord(row));
  }

  return map;
}

function fileChangesFromCursorBubble(sessionId: string, bubbleId: string, bubble: JsonObject): FileChange[] {
  const candidates = [
    ...arrayRecords(bubble.assistantSuggestedDiffs),
    ...arrayRecords(bubble.gitDiffs),
    ...arrayRecords(bubble.diffsSinceLastApply),
    ...arrayRecords(bubble.humanChanges),
  ];

  const fileChanges: Array<FileChange | null> = candidates.map((candidate, index) => {
      const filePath = asString(
        candidate.path,
        asString(candidate.filePath, asString(candidate.relativeWorkspacePath, asString(candidate.uri))),
      );
      const resolvedPath = extractPathFromUri(filePath) ?? filePath;
      if (!resolvedPath) {
        return null;
      }

      return {
        file_change_id: stableId("file", ["cursor", sessionId, bubbleId, index, resolvedPath]),
        path: resolvedPath,
        change_type: normalizeFileChangeType(candidate.change_type ?? candidate.type ?? "modified"),
        additions: asNumber(candidate.additions) ?? 0,
        deletions: asNumber(candidate.deletions) ?? 0,
        diff: typeof candidate.diff === "string" ? candidate.diff : null,
        metadata: {
          bubble_id: bubbleId,
        },
      };
    });

  return fileChanges.filter((change): change is FileChange => Boolean(change));
}

function workspacePathFromCursorHeader(header: JsonObject): string | null {
  const workspaceIdentifier = asRecord(header.workspaceIdentifier);
  const uri = asRecord(workspaceIdentifier.uri);
  const trackedGitRepos = Array.isArray(header.trackedGitRepos) ? header.trackedGitRepos.map(asRecord) : [];

  return (
    asString(uri.fsPath) ||
    extractPathFromUri(asString(uri.external)) ||
    asString(trackedGitRepos[0]?.repoPath) ||
    null
  );
}

function arrayRecords(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
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

async function sqliteAvailable(): Promise<boolean> {
  try {
    await execFileAsync("sqlite3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function sqliteScalar(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

async function sqliteJsonRows<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
