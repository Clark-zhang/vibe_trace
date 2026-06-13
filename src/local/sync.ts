import { EventEmitter } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeCodeAdapter, CodexAdapter, CursorAdapter, type AgentAdapter, type DetectResult, type SourceSessionSummary } from "../adapters/index.js";
import type { TraceSource } from "../schema/types.js";
import { LocalTraceStore } from "./store.js";

const SYNC_STATE_VERSION = "sync-state-v1";
const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export interface SyncServiceOptions {
  store?: LocalTraceStore;
  adapters?: AgentAdapter[];
  sources?: Iterable<TraceSource>;
  intervalMs?: number;
  limitPerSource?: number;
}

export interface SyncSourceRunSummary {
  found: number;
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
  message?: string;
}

export interface SyncRunSummary {
  started_at: string;
  ended_at: string | null;
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
  by_source: Record<string, SyncSourceRunSummary>;
}

export interface SyncStatus {
  running: boolean;
  syncing: boolean;
  interval_ms: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  last_summary: SyncRunSummary | null;
  store: string;
}

interface SyncSessionState {
  fingerprint: string;
  title?: string;
  raw_path?: string;
  workspace_path?: string;
  trace_id?: string;
  message_count?: number;
  last_seen_at: string;
  last_imported_at?: string;
  last_error?: string | null;
}

interface SyncSourceState {
  sessions: Record<string, SyncSessionState>;
  last_seen_at?: string;
  last_error?: string | null;
}

interface SyncStateFile {
  version: typeof SYNC_STATE_VERSION;
  sources: Record<string, SyncSourceState>;
}

export function createDefaultAgentAdapters(): AgentAdapter[] {
  return [
    new CursorAdapter(),
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
  ];
}

export class SyncService extends EventEmitter {
  private readonly store: LocalTraceStore;
  private readonly adapters: AgentAdapter[];
  private readonly sources: Set<TraceSource>;
  private readonly intervalMs: number;
  private readonly limitPerSource?: number;
  private stateLoaded = false;
  private state: SyncStateFile = createEmptySyncState();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private runPromise: Promise<SyncRunSummary> | null = null;
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private lastError: string | null = null;
  private lastSummary: SyncRunSummary | null = null;

  constructor(options: SyncServiceOptions = {}) {
    super();
    this.store = options.store ?? new LocalTraceStore();
    this.adapters = options.adapters ?? createDefaultAgentAdapters();
    this.sources = new Set(options.sources ?? this.adapters.map((adapter) => adapter.source));
    this.intervalMs = normalizeIntervalMs(options.intervalMs);
    this.limitPerSource = options.limitPerSource;
  }

  start(): SyncStatus {
    if (this.running) {
      return this.getStatus();
    }

    this.running = true;
    void this.runAndSchedule();
    return this.getStatus();
  }

  stop(): SyncStatus {
    this.running = false;
    this.nextRunAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.getStatus();
  }

  async runNow(): Promise<SyncRunSummary> {
    if (this.runPromise) {
      return this.runPromise;
    }

    this.runPromise = this.runOnce()
      .then((summary) => {
        this.lastSummary = summary;
        this.lastRunAt = summary.ended_at;
        this.lastError = null;
        this.emit("synced", summary);
        return summary;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.runPromise = null;
      });

    return this.runPromise;
  }

  getStatus(): SyncStatus {
    return {
      running: this.running,
      syncing: Boolean(this.runPromise),
      interval_ms: this.intervalMs,
      last_run_at: this.lastRunAt,
      next_run_at: this.nextRunAt,
      last_error: this.lastError,
      last_summary: this.lastSummary,
      store: this.store.paths.root,
    };
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      // Keep the background loop alive; the status endpoint exposes the failure.
    } finally {
      this.scheduleNextRun();
    }
  }

  private scheduleNextRun(): void {
    if (!this.running) {
      return;
    }

    this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAt = null;
      void this.runAndSchedule();
    }, this.intervalMs);
  }

  private async runOnce(): Promise<SyncRunSummary> {
    await this.store.ensure();
    await this.loadState();

    const startedAt = new Date().toISOString();
    const summary: SyncRunSummary = {
      started_at: startedAt,
      ended_at: null,
      imported: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      by_source: {},
    };

    for (const adapter of this.adapters) {
      if (!this.sources.has(adapter.source)) {
        continue;
      }

      const sourceStats: SyncSourceRunSummary = {
        found: 0,
        imported: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
      };
      summary.by_source[adapter.source] = sourceStats;
      const sourceState = this.syncSourceState(adapter.source);

      try {
        const detect = await adapter.detect();
        sourceStats.message = detect.message;
        sourceState.last_seen_at = new Date().toISOString();

        if (!detect.found) {
          sourceState.last_error = null;
          continue;
        }

        const sessions = await adapter.listSessions();
        sourceStats.found = sessions.length;
        const selected = this.limitPerSource ? sessions.slice(0, this.limitPerSource) : sessions;

        for (const session of selected) {
          await this.syncSession(adapter, session, detect, sourceStats, summary);
        }

        sourceState.last_error = null;
      } catch (error) {
        sourceStats.failed += 1;
        summary.failed += 1;
        sourceState.last_error = firstErrorLine(error);
      }
    }

    summary.ended_at = new Date().toISOString();
    await this.writeState();
    return summary;
  }

  private async syncSession(
    adapter: AgentAdapter,
    session: SourceSessionSummary,
    detect: DetectResult,
    sourceStats: SyncSourceRunSummary,
    summary: SyncRunSummary,
  ): Promise<void> {
    const sourceState = this.syncSourceState(adapter.source);
    const existing = sourceState.sessions[session.source_session_id];
    const fingerprint = await fingerprintSession(session, detect);
    const now = new Date().toISOString();

    if (existing?.fingerprint === fingerprint) {
      existing.last_seen_at = now;
      existing.last_error = null;
      sourceStats.unchanged += 1;
      summary.unchanged += 1;
      return;
    }

    try {
      const trace = await adapter.importSession(session.source_session_id);
      sourceState.sessions[session.source_session_id] = {
        fingerprint,
        title: session.title,
        raw_path: session.raw_path,
        workspace_path: session.workspace_path,
        trace_id: trace.trace_id,
        message_count: trace.messages.length,
        last_seen_at: now,
        last_imported_at: trace.messages.length > 0 ? now : existing?.last_imported_at,
        last_error: null,
      };

      if (trace.messages.length === 0) {
        sourceStats.skipped += 1;
        summary.skipped += 1;
        return;
      }

      await this.store.saveTrace(trace);
      sourceStats.imported += 1;
      summary.imported += 1;
    } catch (error) {
      sourceState.sessions[session.source_session_id] = {
        fingerprint: existing?.fingerprint ?? fingerprint,
        title: session.title,
        raw_path: session.raw_path,
        workspace_path: session.workspace_path,
        trace_id: existing?.trace_id,
        message_count: existing?.message_count,
        last_seen_at: now,
        last_imported_at: existing?.last_imported_at,
        last_error: firstErrorLine(error),
      };
      sourceStats.failed += 1;
      summary.failed += 1;
    }
  }

  private syncSourceState(source: TraceSource): SyncSourceState {
    this.state.sources[source] ??= {
      sessions: {},
    };
    return this.state.sources[source];
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }

    this.stateLoaded = true;

    try {
      const raw = await readFile(this.statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
      if (parsed.version === SYNC_STATE_VERSION && parsed.sources && typeof parsed.sources === "object") {
        this.state = {
          version: SYNC_STATE_VERSION,
          sources: parsed.sources as Record<string, SyncSourceState>,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeState(): Promise<void> {
    await this.store.ensure();
    await writeFile(this.statePath(), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private statePath(): string {
    return path.join(this.store.paths.imports, "sync-state.json");
  }
}

function createEmptySyncState(): SyncStateFile {
  return {
    version: SYNC_STATE_VERSION,
    sources: {},
  };
}

function normalizeIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1000) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }

  return Math.round(value);
}

async function fingerprintSession(session: SourceSessionSummary, detect: DetectResult): Promise<string> {
  const statPath = session.raw_path ?? detect.path;

  if (statPath) {
    try {
      const fileStat = await stat(statPath);
      return `stat:${statPath}:${fileStat.size}:${fileStat.mtimeMs}`;
    } catch {
      // Fall back to summary fields if a source reports a non-stat-able location.
    }
  }

  return [
    "summary",
    session.source_session_id,
    session.started_at ?? "",
    session.title,
    session.workspace_path ?? "",
  ].join(":");
}

function firstErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
