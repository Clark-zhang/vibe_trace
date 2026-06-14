import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTitleCandidate, traceWithDisplayTitle } from "../parser/sourceContent.js";
import type { ToolCall, Trace, TraceMessage, TraceSource, TraceSummary, WorkspaceInfo } from "../schema/types.js";
import { assertValidTrace } from "../schema/validate.js";

export interface LocalStorePaths {
  root: string;
  traces: string;
  imports: string;
  checkpoints: string;
}

export interface TraceListFilters {
  query?: string;
  source?: string;
  workspace?: string;
}

export interface UserMessageListFilters extends TraceListFilters {
  limit?: number;
}

export interface ProjectReplayFilters extends TraceListFilters {
  limit?: number;
}

export interface UserMessageImageSummary {
  index: number;
  src: string;
  mime_type: string;
  detail?: string;
  byte_count?: number;
}

export interface UserMessageSummary {
  message_id: string;
  trace_id: string;
  trace_title: string;
  source: TraceSource;
  session_kind?: string;
  workspace: WorkspaceInfo;
  created_at: string;
  content: string;
  images: UserMessageImageSummary[];
  is_truncated: boolean;
  character_count: number;
  estimated_token_count: number;
  intent: string;
}

export interface UserMessageImageData {
  mime_type: string;
  data: Buffer;
}

export interface UserMessageAnalysis {
  total_messages: number;
  shown_messages: number;
  total_characters: number;
  average_characters: number;
  estimated_token_count: number;
  project_count: number;
  session_count: number;
  intent_counts: Array<{ intent: string; count: number }>;
  top_terms: Array<{ term: string; count: number }>;
  top_projects: Array<{ name: string; count: number }>;
}

export interface UserMessageListResult {
  messages: UserMessageSummary[];
  analysis: UserMessageAnalysis;
}

export interface ProjectReplayToolTypeSummary {
  name: string;
  count: number;
}

export interface ProjectReplayUserMessage {
  message_id: string;
  content: string;
  full_content: string;
  images: UserMessageImageSummary[];
  created_at: string;
  is_truncated: boolean;
  character_count: number;
  estimated_token_count: number;
}

export interface ProjectReplayAgentSummary {
  content: string;
  full_content: string;
  created_at: string | null;
  is_truncated: boolean;
  message_count: number;
  tool_call_count: number;
  tool_call_types: ProjectReplayToolTypeSummary[];
  file_change_count: number;
  checkpoint_count: number;
}

export interface ProjectReplayTurn {
  turn_id: string;
  trace_id: string;
  trace_title: string;
  session_id: string;
  session_title: string;
  session_started_at: string;
  source: TraceSource;
  session_kind?: string;
  workspace: WorkspaceInfo;
  trace_started_at: string;
  user: ProjectReplayUserMessage;
  agent: ProjectReplayAgentSummary;
}

export interface ProjectReplayResult {
  project: WorkspaceInfo | null;
  turns: ProjectReplayTurn[];
  stats: {
    turn_count: number;
    shown_turn_count: number;
    message_count: number;
    token_count: number;
    trace_count: number;
    tool_call_count: number;
    tool_call_types: ProjectReplayToolTypeSummary[];
    file_change_count: number;
    checkpoint_count: number;
    model_counts: ProjectReplayToolTypeSummary[];
    source_counts: ProjectReplayToolTypeSummary[];
  };
}

interface TraceSummaryCacheEntry {
  file: string;
  size: number;
  mtime_ms: number;
  summary: TraceSummary;
}

interface TraceSummaryCacheFile {
  version: string;
  entries: TraceSummaryCacheEntry[];
}

interface UserMessageCacheEntry {
  file: string;
  size: number;
  mtime_ms: number;
  messages: UserMessageSummary[];
}

interface UserMessageCacheFile {
  version: string;
  entries: UserMessageCacheEntry[];
}

interface ExtractedUserMessageImage {
  mime_type: string;
  base64?: string;
  file_path?: string;
  src?: string;
  detail?: string;
  byte_count?: number;
}

interface JsonBlockMatch {
  value: unknown;
  start: number;
  end: number;
}

const SUMMARY_CACHE_VERSION = "trace-summary-cache-v1";
const USER_MESSAGE_CACHE_VERSION = "user-message-cache-v5";
const USER_MESSAGE_PREVIEW_LIMIT = 1200;
const DEFAULT_USER_MESSAGE_LIMIT = 1000;
const MAX_USER_MESSAGE_LIMIT = 5000;
const PROJECT_REPLAY_USER_LIMIT = 1600;
const PROJECT_REPLAY_AGENT_LIMIT = 900;
const DEFAULT_PROJECT_REPLAY_LIMIT = 80;
const MAX_PROJECT_REPLAY_LIMIT = 1000;
const CLAUDE_IMAGE_SOURCE_PATTERN = /\[Image:\s*source:\s*([^\]\r\n]+?)\s*\]/gi;
const LOCAL_IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;

export class LocalTraceStore {
  readonly paths: LocalStorePaths;
  private summaryCache = new Map<string, TraceSummaryCacheEntry>();
  private summaryCacheDirty = false;
  private summaryCacheLoaded = false;
  private userMessageCache = new Map<string, UserMessageCacheEntry>();
  private userMessageCacheDirty = false;
  private userMessageCacheLoaded = false;

  constructor(root = defaultStoreRoot()) {
    this.paths = {
      root,
      traces: path.join(root, "traces"),
      imports: path.join(root, "imports"),
      checkpoints: path.join(root, "checkpoints"),
    };
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.traces, { recursive: true }),
      mkdir(this.paths.imports, { recursive: true }),
      mkdir(this.paths.checkpoints, { recursive: true }),
    ]);
  }

  async saveTrace(trace: Trace): Promise<Trace> {
    await this.ensure();
    const validTrace = await assertValidTrace(trace);
    const displayTrace = traceWithDisplayTitle(validTrace);
    const targetPath = this.tracePath(displayTrace.trace_id);
    await writeFile(targetPath, `${JSON.stringify(displayTrace, null, 2)}\n`);
    await this.upsertSummaryCacheEntry(path.basename(targetPath), displayTrace);
    await this.upsertUserMessageCacheEntry(path.basename(targetPath), displayTrace);
    return displayTrace;
  }

  async getTrace(traceId: string): Promise<Trace | null> {
    try {
      const raw = await readFile(this.tracePath(traceId), "utf8");
      const trace = await assertValidTrace(JSON.parse(raw) as unknown);
      return traceWithDisplayTitle(trace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async listTraces(filters: TraceListFilters = {}): Promise<TraceSummary[]> {
    await this.ensure();
    await this.loadSummaryCache();

    const files = await readdir(this.paths.traces);
    const traceFiles = files.filter((file) => file.endsWith(".json"));
    const liveFiles = new Set(traceFiles);

    for (const cachedFile of this.summaryCache.keys()) {
      if (!liveFiles.has(cachedFile)) {
        this.summaryCache.delete(cachedFile);
        this.summaryCacheDirty = true;
      }
    }

    const summaries = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => this.readTraceSummary(file)),
    );

    if (this.summaryCacheDirty) {
      await this.writeSummaryCache();
    }

    return summaries
      .filter((summary) => matchesFilters(summary, filters))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  async listUserMessages(filters: UserMessageListFilters = {}): Promise<UserMessageListResult> {
    await this.ensure();
    await this.loadUserMessageCache();

    const files = await readdir(this.paths.traces);
    const traceFiles = files.filter((file) => file.endsWith(".json"));
    const liveFiles = new Set(traceFiles);

    for (const cachedFile of this.userMessageCache.keys()) {
      if (!liveFiles.has(cachedFile)) {
        this.userMessageCache.delete(cachedFile);
        this.userMessageCacheDirty = true;
      }
    }

    const entries = await Promise.all(traceFiles.map(async (file) => this.readUserMessageEntry(file)));

    if (this.userMessageCacheDirty) {
      await this.writeUserMessageCache();
    }

    const matchingMessages = entries
      .flatMap((entry) => entry.messages)
      .filter((message) => matchesUserMessageFilters(message, filters))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = normalizedUserMessageLimit(filters.limit);
    const messages = matchingMessages.slice(0, limit);

    return {
      messages,
      analysis: analyzeUserMessages(matchingMessages, messages.length),
    };
  }

  async getProjectReplay(filters: ProjectReplayFilters = {}): Promise<ProjectReplayResult> {
    await this.ensure();

    const summaries = (await this.listTraces({ source: filters.source }))
      .filter((summary) => matchesProjectReplaySummary(summary, filters));
    const traces = (
      await Promise.all(summaries.map(async (summary) => this.getTrace(summary.trace_id)))
    ).filter((trace): trace is Trace => Boolean(trace));
    const turns = traces
      .flatMap((trace) => buildProjectReplayTurns(trace))
      .filter((turn) => matchesProjectReplayTurn(turn, filters))
      .sort((a, b) => a.user.created_at.localeCompare(b.user.created_at));
    const limit = normalizedProjectReplayLimit(filters.limit);
    const shownTurns = turns.slice(0, limit);

    return {
      project: traces[0]?.workspace ?? null,
      turns: shownTurns,
      stats: {
        turn_count: turns.length,
        shown_turn_count: shownTurns.length,
        message_count: summaries.reduce((sum, summary) => sum + summary.message_count, 0),
        token_count: summaries.reduce((sum, summary) => sum + summary.token_count, 0),
        trace_count: summaries.length,
        tool_call_count: summaries.reduce((sum, summary) => sum + summary.tool_call_count, 0),
        tool_call_types: summarizeReplayToolCalls(traces.flatMap((trace) => trace.tool_calls)),
        file_change_count: summaries.reduce((sum, summary) => sum + summary.file_change_count, 0),
        checkpoint_count: summaries.reduce((sum, summary) => sum + summary.checkpoint_count, 0),
        model_counts: summarizeReplayModels(traces),
        source_counts: summarizeReplaySources(summaries),
      },
    };
  }

  async getUserMessageImage(
    traceId: string,
    messageId: string,
    imageIndex: number,
  ): Promise<UserMessageImageData | null> {
    if (!Number.isInteger(imageIndex) || imageIndex < 0) {
      return null;
    }

    const trace = await this.getTrace(traceId);
    const message = trace?.messages.find((candidate) => candidate.message_id === messageId);
    if (!message) {
      return null;
    }

    const image = extractUserMessageImages(message.content)[imageIndex];
    if (!image) {
      return null;
    }

    if (image.base64) {
      return {
        mime_type: image.mime_type,
        data: Buffer.from(image.base64, "base64"),
      };
    }

    if (image.file_path) {
      try {
        return {
          mime_type: image.mime_type,
          data: await readFile(image.file_path),
        };
      } catch (error) {
        if (isMissingImageFileError(error)) {
          return null;
        }

        throw error;
      }
    }

    return null;
  }

  tracePath(traceId: string): string {
    return path.join(this.paths.traces, `${traceId}.json`);
  }

  private async readTraceSummary(file: string): Promise<TraceSummary> {
    const filePath = path.join(this.paths.traces, file);
    const fileStat = await stat(filePath);
    const cached = this.summaryCache.get(file);

    if (
      cached &&
      cached.size === fileStat.size &&
      cached.mtime_ms === fileStat.mtimeMs
    ) {
      return cached.summary;
    }

    const raw = await readFile(filePath, "utf8");
    const trace = await assertValidTrace(JSON.parse(raw) as unknown);
    const summary = toTraceSummary(trace);
    this.summaryCache.set(file, {
      file,
      size: fileStat.size,
      mtime_ms: fileStat.mtimeMs,
      summary,
    });
    this.summaryCacheDirty = true;

    return summary;
  }

  private async upsertSummaryCacheEntry(file: string, trace: Trace): Promise<void> {
    await this.loadSummaryCache();
    const filePath = path.join(this.paths.traces, file);
    const fileStat = await stat(filePath);

    this.summaryCache.set(file, {
      file,
      size: fileStat.size,
      mtime_ms: fileStat.mtimeMs,
      summary: toTraceSummary(trace),
    });
    await this.writeSummaryCache();
  }

  private async readUserMessageEntry(file: string): Promise<UserMessageCacheEntry> {
    const filePath = path.join(this.paths.traces, file);
    const fileStat = await stat(filePath);
    const cached = this.userMessageCache.get(file);

    if (
      cached &&
      cached.size === fileStat.size &&
      cached.mtime_ms === fileStat.mtimeMs
    ) {
      return cached;
    }

    const raw = await readFile(filePath, "utf8");
    const trace = await assertValidTrace(JSON.parse(raw) as unknown);
    const entry = toUserMessageCacheEntry(file, fileStat.size, fileStat.mtimeMs, trace);
    this.userMessageCache.set(file, entry);
    this.userMessageCacheDirty = true;

    return entry;
  }

  private async upsertUserMessageCacheEntry(file: string, trace: Trace): Promise<void> {
    await this.loadUserMessageCache();
    const filePath = path.join(this.paths.traces, file);
    const fileStat = await stat(filePath);

    this.userMessageCache.set(
      file,
      toUserMessageCacheEntry(file, fileStat.size, fileStat.mtimeMs, trace),
    );
    await this.writeUserMessageCache();
  }

  private async loadSummaryCache(): Promise<void> {
    if (this.summaryCacheLoaded) {
      return;
    }

    this.summaryCacheLoaded = true;

    try {
      const raw = await readFile(this.summaryCachePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<TraceSummaryCacheFile>;

      if (parsed.version !== SUMMARY_CACHE_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }

      this.summaryCache = new Map(
        parsed.entries
          .filter(isSummaryCacheEntry)
          .map((entry) => [entry.file, entry]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async loadUserMessageCache(): Promise<void> {
    if (this.userMessageCacheLoaded) {
      return;
    }

    this.userMessageCacheLoaded = true;

    try {
      const raw = await readFile(this.userMessageCachePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<UserMessageCacheFile>;

      if (parsed.version !== USER_MESSAGE_CACHE_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }

      this.userMessageCache = new Map(
        parsed.entries
          .filter(isUserMessageCacheEntry)
          .map((entry) => [entry.file, entry]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeSummaryCache(): Promise<void> {
    await this.ensure();
    const cacheFile: TraceSummaryCacheFile = {
      version: SUMMARY_CACHE_VERSION,
      entries: Array.from(this.summaryCache.values()),
    };
    await writeFile(this.summaryCachePath(), `${JSON.stringify(cacheFile)}\n`);
    this.summaryCacheDirty = false;
  }

  private async writeUserMessageCache(): Promise<void> {
    await this.ensure();
    const cacheFile: UserMessageCacheFile = {
      version: USER_MESSAGE_CACHE_VERSION,
      entries: Array.from(this.userMessageCache.values()),
    };
    await writeFile(this.userMessageCachePath(), `${JSON.stringify(cacheFile)}\n`);
    this.userMessageCacheDirty = false;
  }

  private summaryCachePath(): string {
    return path.join(this.paths.imports, "trace-summary-cache.json");
  }

  private userMessageCachePath(): string {
    return path.join(this.paths.imports, "user-message-cache.json");
  }
}

export function defaultStoreRoot(): string {
  return process.env.VIBETRACE_HOME || path.join(os.homedir(), ".vibetrace");
}

function isSummaryCacheEntry(value: unknown): value is TraceSummaryCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<TraceSummaryCacheEntry>;
  return (
    typeof entry.file === "string" &&
    typeof entry.size === "number" &&
    typeof entry.mtime_ms === "number" &&
    Boolean(entry.summary) &&
    typeof entry.summary === "object" &&
    typeof entry.summary.trace_id === "string"
  );
}

function isUserMessageCacheEntry(value: unknown): value is UserMessageCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<UserMessageCacheEntry>;
  return (
    typeof entry.file === "string" &&
    typeof entry.size === "number" &&
    typeof entry.mtime_ms === "number" &&
    Array.isArray(entry.messages)
  );
}

function toUserMessageCacheEntry(
  file: string,
  size: number,
  mtimeMs: number,
  trace: Trace,
): UserMessageCacheEntry {
  const displayTrace = traceWithDisplayTitle(trace);
  const traceSummary = toTraceSummary(displayTrace);

  return {
    file,
    size,
    mtime_ms: mtimeMs,
    messages: displayTrace.messages
      .filter((message) => message.role === "user")
      .map((message) => toUserMessageSummary(message, displayTrace, traceSummary))
      .filter((message): message is UserMessageSummary => Boolean(message)),
  };
}

function toUserMessageSummary(
  message: TraceMessage,
  trace: Trace,
  traceSummary: TraceSummary,
): UserMessageSummary | null {
  const images = extractUserMessageImages(message.content);
  const content = cleanUserMessageContent(message.content);

  if ((!content && images.length === 0) || (content && isLowSignalUserMessage(content) && images.length === 0)) {
    return null;
  }

  const characterCount = Array.from(content).length;

  return {
    message_id: message.message_id,
    trace_id: trace.trace_id,
    trace_title: trace.title,
    source: trace.source,
    session_kind: traceSummary.session_kind,
    workspace: trace.workspace,
    created_at: message.created_at,
    content: truncateContent(content, USER_MESSAGE_PREVIEW_LIMIT),
    images: images.map((image, index) => toUserMessageImageSummary(image, trace.trace_id, message.message_id, index)),
    is_truncated: characterCount > USER_MESSAGE_PREVIEW_LIMIT,
    character_count: characterCount,
    estimated_token_count: estimateTokens(content),
    intent: classifyUserIntent(content),
  };
}

function toUserMessageImageSummary(
  image: ExtractedUserMessageImage,
  traceId: string,
  messageId: string,
  index: number,
): UserMessageImageSummary {
  return {
    index,
    src: image.src ?? userMessageImagePath(traceId, messageId, index),
    mime_type: image.mime_type,
    detail: image.detail,
    byte_count: image.byte_count,
  };
}

function userMessageImagePath(traceId: string, messageId: string, index: number): string {
  return `/api/traces/${encodeURIComponent(traceId)}/messages/${encodeURIComponent(messageId)}/images/${index}`;
}

function imageIdentityKey(image: ExtractedUserMessageImage): string {
  if (image.src) {
    return image.src;
  }

  if (image.file_path) {
    return `file:${image.file_path}`;
  }

  return image.base64 ? `data:${image.mime_type};base64,${image.base64}` : `${image.mime_type}:`;
}

function cleanUserMessageContent(value: string): string {
  return stripUserMessageImages(cleanTitleCandidate(value))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripUserMessageImages(value: string): string {
  const ranges = extractImageBlockMatches(value)
    .filter((match) => Boolean(imageFromBlock(match.value)))
    .map((match) => ({ start: match.start, end: match.end }));

  return removeRanges(value, ranges)
    .replace(CLAUDE_IMAGE_SOURCE_PATTERN, "\n")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "\n");
}

function extractUserMessageImages(value: string): ExtractedUserMessageImage[] {
  const images: ExtractedUserMessageImage[] = [];
  const seen = new Set<string>();
  const dataImagePattern = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)/gi;

  for (const block of extractImageBlocks(value)) {
    const image = imageFromBlock(block);
    if (!image) {
      continue;
    }

    const key = imageIdentityKey(image);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    images.push(image);
  }

  for (const match of value.matchAll(CLAUDE_IMAGE_SOURCE_PATTERN)) {
    const image = imageFromSource(match[1] ?? "", imageDetailNear(value, match.index ?? 0));
    if (!image) {
      continue;
    }

    const key = imageIdentityKey(image);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    images.push(image);
  }

  for (const match of value.matchAll(dataImagePattern)) {
    const src = match[0];
    if (seen.has(src)) {
      continue;
    }

    seen.add(src);
    const base64 = match[2] ?? "";
    images.push({
      mime_type: (match[1] ?? "image/png").toLowerCase(),
      base64,
      detail: imageDetailNear(value, match.index ?? 0),
      byte_count: Buffer.byteLength(base64, "base64"),
    });
  }

  return images;
}

function extractImageBlocks(value: string): unknown[] {
  return extractImageBlockMatches(value).map((match) => match.value);
}

function extractImageBlockMatches(value: string): JsonBlockMatch[] {
  const blocks: JsonBlockMatch[] = [];
  const typePattern = /"type"\s*:\s*"(input_image|image_url|image)"/gi;

  for (const match of value.matchAll(typePattern)) {
    const start = findJsonObjectStart(value, match.index ?? 0);
    if (start < 0) {
      continue;
    }

    const end = findJsonObjectEnd(value, start);
    if (end < 0) {
      continue;
    }

    try {
      blocks.push({
        value: JSON.parse(value.slice(start, end + 1)) as unknown,
        start,
        end,
      });
    } catch {
      // Ignore non-JSON snippets that merely resemble image blocks.
    }
  }

  return blocks;
}

function removeRanges(value: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) {
    return value;
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = "";

  for (const range of sorted) {
    if (range.start < cursor) {
      continue;
    }

    output += value.slice(cursor, range.start);
    output += "\n";
    cursor = range.end + 1;
  }

  output += value.slice(cursor);
  return output;
}

function imageFromBlock(value: unknown): ExtractedUserMessageImage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const block = value as Record<string, unknown>;
  const type = typeof block.type === "string" ? block.type : "";
  const detail = typeof block.detail === "string" ? block.detail : undefined;

  if (type === "image") {
    const source = block.source && typeof block.source === "object" && !Array.isArray(block.source)
      ? (block.source as Record<string, unknown>)
      : {};
    const base64 = typeof source.data === "string" ? source.data : "";
    const mediaType = typeof source.media_type === "string" ? source.media_type : undefined;
    const url = typeof source.url === "string" ? source.url : "";

    if (base64) {
      return {
        mime_type: mediaType ?? "image/png",
        base64,
        detail,
        byte_count: Buffer.byteLength(base64, "base64"),
      };
    }

    return imageFromSource(url, detail);
  }

  if (type === "input_image" || type === "image_url") {
    const imageUrl = imageUrlFromBlock(block);
    if (!imageUrl) {
      return null;
    }

    const dataUrl = imageUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
    if (dataUrl) {
      const base64 = dataUrl[2] ?? "";
      return {
        mime_type: (dataUrl[1] ?? "image/png").toLowerCase(),
        base64,
        detail,
        byte_count: Buffer.byteLength(base64, "base64"),
      };
    }

    return imageFromSource(imageUrl, detail);
  }

  return null;
}

function imageUrlFromBlock(block: Record<string, unknown>): string | null {
  if (typeof block.image_url === "string") {
    return block.image_url;
  }

  if (block.image_url && typeof block.image_url === "object" && !Array.isArray(block.image_url)) {
    const imageUrl = block.image_url as Record<string, unknown>;
    return typeof imageUrl.url === "string" ? imageUrl.url : null;
  }

  return null;
}

function imageFromSource(value: string, detail?: string): ExtractedUserMessageImage | null {
  const source = value.trim();
  const filePath = localImagePathFromSource(source);

  if (filePath) {
    return {
      mime_type: mimeTypeFromImageSource(filePath),
      file_path: filePath,
      detail,
    };
  }

  if (isRemoteImageUrl(source)) {
    return {
      mime_type: mimeTypeFromImageSource(source),
      src: source,
      detail,
    };
  }

  return null;
}

function localImagePathFromSource(value: string): string | null {
  if (value.startsWith("file://")) {
    try {
      const filePath = fileURLToPath(value);
      return isLocalImagePath(filePath) ? filePath : null;
    } catch {
      return null;
    }
  }

  return isLocalImagePath(value) ? value : null;
}

function findJsonObjectStart(value: string, index: number): number {
  return value.lastIndexOf("{", index);
}

function findJsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\/.+\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(value);
}

function isLocalImagePath(value: string): boolean {
  return path.isAbsolute(value) && LOCAL_IMAGE_EXTENSION_PATTERN.test(value);
}

function imageDetailNear(value: string, index: number): string | undefined {
  const start = Math.max(0, index - 500);
  const end = Math.min(value.length, index + 500);
  const detail = value.slice(start, end).match(/"detail"\s*:\s*"([^"]+)"/i)?.[1];
  return detail || undefined;
}

function mimeTypeFromImageSource(value: string): string {
  const clean = value.split("?")[0]?.toLowerCase() ?? "";

  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (clean.endsWith(".gif")) {
    return "image/gif";
  }

  if (clean.endsWith(".webp")) {
    return "image/webp";
  }

  if (clean.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "image/png";
}

function isMissingImageFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "EACCES";
}

function isLowSignalUserMessage(value: string): boolean {
  const content = value.trim();
  return (
    content.length < 2 ||
    content.startsWith("/") ||
    /^<[\w-]+(?:\s[^>]*)?>/i.test(content)
  );
}

function truncateContent(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function classifyUserIntent(value: string): string {
  const content = value.toLowerCase();

  if (/(报错|错误|失败|不对|修复|修一下|debug|bug|error|failed?|issue)/i.test(content)) {
    return "debug";
  }

  if (/(分析|原因|为什么|看看|看一下|review|解释|总结|对比|diagnose|analy[sz]e)/i.test(content)) {
    return "analysis";
  }

  if (/(设计|方案|规划|架构|产品|流程|怎么做|计划|strategy|plan|design)/i.test(content)) {
    return "planning";
  }

  if (/(优化|调整|改一下|改成|体验|样式|交互|布局|ui|ux|style|polish)/i.test(content)) {
    return "polish";
  }

  if (/(实现|开发|新增|添加|帮我做|写一个|页面|功能|接口|schema|parser|build|create|add|implement)/i.test(content)) {
    return "build";
  }

  if (/(刷新|打开|点击|选择|展示|显示|列表|页面|navigate|open|show)/i.test(content)) {
    return "navigate";
  }

  if (/[?？]|(吗|什么|如何|能否|可以|是不是)/.test(content)) {
    return "question";
  }

  return "other";
}

function matchesUserMessageFilters(message: UserMessageSummary, filters: UserMessageListFilters): boolean {
  const query = filters.query?.trim().toLowerCase();
  const source = filters.source?.trim();
  const workspace = filters.workspace?.trim().toLowerCase();

  if (source && source !== "all" && message.source !== source) {
    return false;
  }

  if (
    workspace &&
    !message.workspace.name.toLowerCase().includes(workspace) &&
    !message.workspace.path.toLowerCase().includes(workspace)
  ) {
    return false;
  }

  if (!query) {
    return true;
  }

  return [
    message.content,
    message.intent,
    message.trace_title,
    message.source,
    message.workspace.name,
    message.workspace.path,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function normalizedUserMessageLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_USER_MESSAGE_LIMIT;
  }

  return Math.max(1, Math.min(MAX_USER_MESSAGE_LIMIT, Math.round(value)));
}

function analyzeUserMessages(
  messages: UserMessageSummary[],
  shownMessages: number,
): UserMessageAnalysis {
  const intentCounts = new Map<string, number>();
  const termCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  const traceIds = new Set<string>();
  const projectKeys = new Set<string>();
  let totalCharacters = 0;
  let estimatedTokenCount = 0;

  for (const message of messages) {
    intentCounts.set(message.intent, (intentCounts.get(message.intent) ?? 0) + 1);
    traceIds.add(message.trace_id);
    projectKeys.add(message.workspace.path || message.workspace.name);
    projectCounts.set(message.workspace.name, (projectCounts.get(message.workspace.name) ?? 0) + 1);
    totalCharacters += message.character_count;
    estimatedTokenCount += message.estimated_token_count;

    for (const term of extractUserMessageTerms(message.content)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  return {
    total_messages: messages.length,
    shown_messages: shownMessages,
    total_characters: totalCharacters,
    average_characters: messages.length ? Math.round(totalCharacters / messages.length) : 0,
    estimated_token_count: estimatedTokenCount,
    project_count: projectKeys.size,
    session_count: traceIds.size,
    intent_counts: topEntries(intentCounts, 8).map(([intent, count]) => ({ intent, count })),
    top_terms: topEntries(termCounts, 16).map(([term, count]) => ({ term, count })),
    top_projects: topEntries(projectCounts, 8).map(([name, count]) => ({ name, count })),
  };
}

function buildProjectReplayTurns(trace: Trace): ProjectReplayTurn[] {
  const displayTrace = traceWithDisplayTitle(trace);
  const traceSummary = toTraceSummary(displayTrace);
  const messages = [...displayTrace.messages].sort(compareCreatedAt);
  const userEntries = messages
    .map((message, index) => ({
      index,
      message,
      user: message.role === "user" ? toProjectReplayUserMessage(message, displayTrace) : null,
    }))
    .filter((entry): entry is { index: number; message: TraceMessage; user: ProjectReplayUserMessage } =>
      Boolean(entry.user),
    );
  const turns: ProjectReplayTurn[] = [];

  for (let entryIndex = 0; entryIndex < userEntries.length; entryIndex += 1) {
    const entry = userEntries[entryIndex];
    const nextEntry = userEntries[entryIndex + 1];
    const nextUserIndex = nextEntry?.index ?? -1;
    const endIndex = nextEntry ? nextEntry.index : messages.length;
    const segment = messages.slice(entry.index, endIndex);

    const toolCalls = projectReplayToolCallsForSegment(
      displayTrace.tool_calls,
      segment,
      entry.message.created_at,
      nextUserIndex === -1 ? null : nextEntry.message.created_at,
    );
    const checkpoints = displayTrace.checkpoints.filter((checkpoint) =>
      isWithinReplayWindow(
        checkpoint.created_at,
        entry.message.created_at,
        nextUserIndex === -1 ? null : nextEntry.message.created_at,
      ),
    );
    const agentMessages = segment.filter((message) => message.role === "assistant");

    turns.push({
      turn_id: `${displayTrace.trace_id}:${entry.message.message_id}`,
      trace_id: displayTrace.trace_id,
      trace_title: displayTrace.title,
      session_id: displayTrace.source_session_id || displayTrace.trace_id,
      session_title: displayTrace.title,
      session_started_at: displayTrace.started_at,
      source: displayTrace.source,
      session_kind: traceSummary.session_kind,
      workspace: displayTrace.workspace,
      trace_started_at: displayTrace.started_at,
      user: entry.user,
      agent: {
        ...toProjectReplayAgentSummary(agentMessages, toolCalls, checkpoints.length),
        file_change_count: 0,
      },
    });
  }

  const finalTurn = turns.at(-1);
  if (finalTurn) {
    finalTurn.agent.file_change_count = displayTrace.file_changes.length;
  }

  return turns;
}

function toProjectReplayUserMessage(
  message: TraceMessage,
  trace: Trace,
): ProjectReplayUserMessage | null {
  const images = extractUserMessageImages(message.content);
  const content = cleanUserMessageContent(message.content);

  if ((!content && images.length === 0) || (content && isLowSignalUserMessage(content) && images.length === 0)) {
    return null;
  }

  const characterCount = Array.from(content).length;

  return {
    message_id: message.message_id,
    content: truncateContent(content, PROJECT_REPLAY_USER_LIMIT),
    full_content: content,
    images: images.map((image, index) => toUserMessageImageSummary(image, trace.trace_id, message.message_id, index)),
    created_at: message.created_at,
    is_truncated: characterCount > PROJECT_REPLAY_USER_LIMIT,
    character_count: characterCount,
    estimated_token_count: estimateTokens(content),
  };
}

function toProjectReplayAgentSummary(
  messages: TraceMessage[],
  toolCalls: ToolCall[],
  checkpointCount: number,
): Omit<ProjectReplayAgentSummary, "file_change_count"> {
  const rawContent = messages.map((message) => message.content).join("\n\n");
  const content = cleanReplayAgentContent(rawContent);
  const characterCount = Array.from(content).length;
  const createdAt = latestCreatedAt([
    ...messages.map((message) => message.created_at),
    ...toolCalls.map((toolCall) => toolCall.created_at),
  ]);

  return {
    content: truncateContent(content, PROJECT_REPLAY_AGENT_LIMIT),
    full_content: content,
    created_at: createdAt,
    is_truncated: characterCount > PROJECT_REPLAY_AGENT_LIMIT,
    message_count: messages.length,
    tool_call_count: toolCalls.length,
    tool_call_types: summarizeReplayToolCalls(toolCalls),
    checkpoint_count: checkpointCount,
  };
}

function projectReplayToolCallsForSegment(
  toolCalls: ToolCall[],
  segment: TraceMessage[],
  startedAt: string,
  endedAt: string | null,
): ToolCall[] {
  const messageIds = new Set(segment.map((message) => message.message_id));
  const toolCallIds = new Set(segment.flatMap((message) => message.tool_call_ids));

  return toolCalls.filter((toolCall) => {
    if (toolCallIds.has(toolCall.tool_call_id)) {
      return true;
    }

    if (toolCall.message_id && messageIds.has(toolCall.message_id)) {
      return true;
    }

    return isWithinReplayWindow(toolCall.created_at, startedAt, endedAt);
  });
}

function summarizeReplayToolCalls(toolCalls: ToolCall[]): ProjectReplayToolTypeSummary[] {
  const counts = new Map<string, number>();

  for (const toolCall of toolCalls) {
    const name = toolCall.name || "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return topEntries(counts, 6).map(([name, count]) => ({ name, count }));
}

function summarizeReplayModels(traces: Trace[]): ProjectReplayToolTypeSummary[] {
  const counts = new Map<string, number>();

  for (const message of traces.flatMap((trace) => trace.messages)) {
    const model = message.model?.trim();
    if (model) {
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }

  return topEntries(counts, 6).map(([name, count]) => ({ name, count }));
}

function summarizeReplaySources(summaries: TraceSummary[]): ProjectReplayToolTypeSummary[] {
  const counts = new Map<string, number>();

  for (const summary of summaries) {
    const name = summary.session_kind ? `${summary.source} ${summary.session_kind}` : summary.source;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return topEntries(counts, 6).map(([name, count]) => ({ name, count }));
}

function cleanReplayAgentContent(value: string): string {
  return cleanTitleCandidate(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[image]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchesProjectReplaySummary(summary: TraceSummary, filters: ProjectReplayFilters): boolean {
  const source = filters.source?.trim();
  const workspace = filters.workspace?.trim().toLowerCase();

  if (isCodexChatSummary(summary)) {
    return false;
  }

  if (source && source !== "all" && summary.source !== source) {
    return false;
  }

  if (
    workspace &&
    !summary.workspace.name.toLowerCase().includes(workspace) &&
    !summary.workspace.path.toLowerCase().includes(workspace)
  ) {
    return false;
  }

  return true;
}

function isCodexChatSummary(summary: TraceSummary): boolean {
  return summary.source === "codex" && summary.session_kind === "chat";
}

function matchesProjectReplayTurn(turn: ProjectReplayTurn, filters: ProjectReplayFilters): boolean {
  const query = filters.query?.trim().toLowerCase();

  if (!query) {
    return true;
  }

  return [
    turn.user.content,
    turn.agent.content,
    turn.trace_title,
    turn.source,
    turn.session_kind ?? "",
    turn.workspace.name,
    turn.workspace.path,
    ...turn.agent.tool_call_types.map((toolType) => toolType.name),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function normalizedProjectReplayLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PROJECT_REPLAY_LIMIT;
  }

  return Math.max(1, Math.min(MAX_PROJECT_REPLAY_LIMIT, Math.round(value)));
}

function isWithinReplayWindow(value: string, startedAt: string, endedAt: string | null): boolean {
  const timestamp = Date.parse(value);
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(timestamp) || !Number.isFinite(start)) {
    return false;
  }

  return timestamp >= start && timestamp < end;
}

function latestCreatedAt(values: string[]): string | null {
  const dates = values.filter(Boolean).sort((a, b) => b.localeCompare(a));
  return dates[0] ?? null;
}

function compareCreatedAt(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at.localeCompare(b.created_at);
}

function extractUserMessageTerms(value: string): string[] {
  const content = value.toLowerCase();
  const terms = new Set<string>();
  const importantTerms = [
    "开发",
    "优化",
    "页面",
    "项目",
    "用户",
    "消息",
    "分析",
    "刷新",
    "工具",
    "历史",
    "聊天",
    "搜索",
    "导入",
    "展示",
    "缓存",
    "标题",
    "列表",
    "设计",
    "产品",
    "本地",
    "数据",
    "文件",
    "代码",
    "前端",
    "后端",
    "交互",
    "样式",
    "schema",
    "parser",
    "session",
    "tokens",
    "codex",
    "claude",
    "cursor",
  ];

  for (const term of importantTerms) {
    if (content.includes(term)) {
      terms.add(term);
    }
  }

  for (const match of content.matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const term = match[0];
    if (!USER_MESSAGE_STOP_WORDS.has(term)) {
      terms.add(term);
    }
  }

  return Array.from(terms);
}

function topEntries<T>(counts: Map<T, number>, limit: number): Array<[T, number]> {
  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit);
}

const USER_MESSAGE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "you",
  "can",
  "are",
  "but",
  "not",
  "from",
  "have",
  "has",
  "into",
  "local",
]);

export function toTraceSummary(trace: Trace): TraceSummary {
  const displayTrace = traceWithDisplayTitle(trace);

  return {
    trace_id: displayTrace.trace_id,
    title: displayTrace.title,
    source: displayTrace.source,
    session_kind: inferSessionKind(displayTrace),
    workspace: displayTrace.workspace,
    started_at: displayTrace.started_at,
    ended_at: displayTrace.ended_at,
    message_count: displayTrace.messages.length,
    token_count: traceTokenCount(displayTrace),
    tool_call_count: displayTrace.tool_calls.length,
    file_change_count: displayTrace.file_changes.length,
    checkpoint_count: displayTrace.checkpoints.length,
    privacy_finding_count:
      (displayTrace.privacy_findings?.length ?? 0) +
      displayTrace.messages.reduce(
        (count, message) => count + message.privacy_findings.length,
        0,
      ),
  };
}

function inferSessionKind(trace: Trace): string | undefined {
  if (typeof trace.metadata.session_kind === "string") {
    return trace.metadata.session_kind;
  }

  if (trace.source !== "codex") {
    return undefined;
  }

  const workspacePath = trace.workspace.path;
  if (/\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(workspacePath)) {
    return "chat";
  }

  if (workspacePath) {
    return "project";
  }

  return undefined;
}

function matchesFilters(summary: TraceSummary, filters: TraceListFilters): boolean {
  const query = filters.query?.trim().toLowerCase();
  const source = filters.source?.trim();
  const workspace = filters.workspace?.trim().toLowerCase();

  if (source && source !== "all" && summary.source !== source) {
    return false;
  }

  if (workspace && !summary.workspace.name.toLowerCase().includes(workspace)) {
    return false;
  }

  if (!query) {
    return true;
  }

  return [
    summary.title,
    summary.source,
    summary.workspace.name,
    summary.workspace.path,
    summary.workspace.repo_url ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function traceTokenCount(trace: Trace): number {
  const explicitTokenCount = readTokenCount(trace.metadata);

  if (explicitTokenCount > 0) {
    return explicitTokenCount;
  }

  return Math.max(
    1,
    estimateTokens(
      [
        trace.title,
        trace.summary ?? "",
        ...trace.messages.map((message) => message.content),
        ...trace.tool_results.map((result) => result.content),
      ].join("\n"),
    ),
  );
}

function readTokenCount(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }

  const object = value as Record<string, unknown>;
  const directTotal = numberValue(
    object.total_tokens ??
      object.totalTokens ??
      object.tokens ??
      object.token_count ??
      object.tokenCount,
  );

  if (directTotal > 0) {
    return directTotal;
  }

  const inputOutputTotal =
    numberValue(object.input_tokens ?? object.inputTokens ?? object.prompt_tokens ?? object.promptTokens) +
    numberValue(object.output_tokens ?? object.outputTokens ?? object.completion_tokens ?? object.completionTokens);

  if (inputOutputTotal > 0) {
    return inputOutputTotal;
  }

  return Object.values(object).reduce<number>(
    (sum, child) => Math.max(sum, readTokenCount(child)),
    0,
  );
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function estimateTokens(text: string): number {
  const cjkMatches = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkCount = cjkMatches?.length ?? 0;
  const withoutCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ");
  const wordCount = withoutCjk.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const symbolCount = withoutCjk.replace(/[A-Za-z0-9_\s]/g, "").length;

  return cjkCount + wordCount + Math.ceil(symbolCount / 2);
}
