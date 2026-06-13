import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseTraceFile } from "../parser/genericJsonParser.js";
import { validateTrace } from "../schema/validate.js";
import type { Trace } from "../schema/types.js";
import type {
  AgentAdapter,
  DetectResult,
  SourceSessionSummary,
} from "./types.js";

const supportedExtensions = new Set([".json", ".jsonl", ".ndjson"]);

export class ManualJsonAdapter implements AgentAdapter {
  readonly source = "manual_json" as const;

  constructor(private readonly importDir: string) {}

  async detect(): Promise<DetectResult> {
    const files = await this.getCandidateFiles();

    return {
      found: files.length > 0,
      path: this.importDir,
      session_count: files.length,
      message:
        files.length > 0
          ? `Found ${files.length} importable trace file(s).`
          : "No JSON or JSONL trace files found.",
    };
  }

  async listSessions(): Promise<SourceSessionSummary[]> {
    const files = await this.getCandidateFiles();

    return files.map((file) => ({
      source: this.source,
      source_session_id: path.basename(file),
      title: path.basename(file),
      raw_path: file,
    }));
  }

  async importSession(sessionId: string): Promise<Trace> {
    const files = await this.getCandidateFiles();
    const file = files.find((candidate) => path.basename(candidate) === sessionId);

    if (!file) {
      throw new Error(`No manual JSON session found for ${sessionId}`);
    }

    return parseTraceFile(file, {
      source: this.source,
      sourceSessionId: sessionId,
    });
  }

  async validateRaw(raw: unknown) {
    return validateTrace(raw);
  }

  private async getCandidateFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.importDir);
      const files = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(this.importDir, entry);
          const fileStat = await stat(fullPath);
          return fileStat.isFile() && supportedExtensions.has(path.extname(entry))
            ? fullPath
            : null;
        }),
      );

      return files.filter((file): file is string => Boolean(file)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}
