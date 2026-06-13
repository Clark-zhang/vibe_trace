import type { JsonObject, MessageRole, Trace } from "../schema/types.js";
import { asRecord, asString } from "./normalize.js";

export function mapRole(value: unknown): MessageRole {
  const role = asString(value, "assistant");

  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  if (role === "developer") {
    return "system";
  }

  return "assistant";
}

export function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stringifyContentBlock).filter(Boolean).join("\n\n");
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return stringifyContentBlock(value);
  }

  return String(value);
}

export function stringifyContentBlock(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return value === undefined || value === null ? "" : String(value);
  }

  const block = asRecord(value);
  const type = asString(block.type);

  if (type === "text") {
    return asString(block.text);
  }

  if (type === "tool_use") {
    return `[tool_use:${asString(block.name, "unknown_tool")}]`;
  }

  if (type === "tool_result") {
    return stringifyContent(block.content) || "[tool_result]";
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  if (typeof block.message === "string") {
    return block.message;
  }

  return JSON.stringify(block);
}

export function parseJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : { value };
    } catch {
      return { value };
    }
  }

  return {};
}

export function parseJsonl(content: string): JsonObject[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter((value): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

export function compactTitle(value: string, fallback: string): string {
  const title = normalizeTitleText(cleanTitleCandidate(value)).slice(0, 100);
  return title || fallback;
}

export function traceWithDisplayTitle(trace: Trace): Trace {
  const title = deriveTraceDisplayTitle(trace);

  if (title === trace.title) {
    return trace;
  }

  return {
    ...trace,
    title,
    metadata: {
      ...trace.metadata,
      raw_title: typeof trace.metadata.raw_title === "string" ? trace.metadata.raw_title : trace.title,
    },
  };
}

export function deriveTraceDisplayTitle(trace: Trace): string {
  const originalTitle = trace.title.trim();
  const cleanedOriginal = compactTitle(originalTitle, "");

  if (!isInternalTitle(originalTitle) && cleanedOriginal) {
    return cleanedOriginal;
  }

  for (const message of trace.messages) {
    if (message.role !== "user") {
      continue;
    }

    const candidate = compactTitle(message.content, "");
    if (isSubstantiveTitle(candidate)) {
      return candidate;
    }
  }

  if (isSubstantiveTitle(cleanedOriginal)) {
    return cleanedOriginal;
  }

  return cleanedOriginal || trace.workspace.name || "Untitled trace";
}

export function cleanTitleCandidate(value: string): string {
  const commandArgs = extractTagContent(value, "command-args");
  if (commandArgs) {
    return commandArgs;
  }

  const commandName = extractTagContent(value, "command-name");
  const stripped = stripLeadingInternalBlocks(value);
  if (stripped) {
    return stripped;
  }

  if (commandName) {
    return commandName.startsWith("/") ? commandName : `/${commandName}`;
  }

  return value;
}

export function isInternalTitle(value: string): boolean {
  return /^\s*<(environment_context|codex_internal_context|local-command-|command-|system-|developer-)/i.test(value);
}

function isSubstantiveTitle(value: string): boolean {
  const title = value.trim();
  return Boolean(title) && !isInternalTitle(title) && !title.startsWith("/") && title.length > 2;
}

function normalizeTitleText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingInternalBlocks(value: string): string {
  let text = value.trim();
  let previous = "";

  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(
        /^\s*<(environment_context|codex_internal_context|local-command-caveat|local-command-stdout|command-message|command-name)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i,
        "",
      )
      .trim();
  }

  return text;
}

function extractTagContent(value: string, tagName: string): string | null {
  const match = value.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const content = match?.[1]?.trim();
  return content || null;
}

export function extractPathFromUri(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.startsWith("file://")) {
    return decodeURIComponent(value.replace(/^file:\/\//, ""));
  }

  return value;
}
