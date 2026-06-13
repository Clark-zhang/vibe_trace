import type { TraceSource } from "../schema/types.js";
import { LocalTraceStore } from "./store.js";
import { SyncService, createDefaultAgentAdapters } from "./sync.js";

interface ImportOptions {
  sources: Set<TraceSource>;
  limitPerSource?: number;
  watch?: boolean;
  intervalMs?: number;
}

const adapters = createDefaultAgentAdapters();

export async function importLocalAgentSessions(options = parseCliArgs(process.argv.slice(2))) {
  const store = new LocalTraceStore();
  await store.ensure();

  const summary = {
    imported: 0,
    failed: 0,
    by_source: {} as Record<string, { found: number; imported: number; failed: number }>,
  };

  for (const adapter of adapters) {
    if (!options.sources.has(adapter.source)) {
      continue;
    }

    const detect = await adapter.detect();
    const sourceStats = {
      found: detect.session_count ?? 0,
      imported: 0,
      failed: 0,
    };
    summary.by_source[adapter.source] = sourceStats;

    if (!detect.found) {
      console.log(`[${adapter.source}] ${detect.message ?? "not found"}`);
      continue;
    }

    const sessions = await adapter.listSessions();
    sourceStats.found = sessions.length;
    const selected = options.limitPerSource ? sessions.slice(0, options.limitPerSource) : sessions;
    console.log(`[${adapter.source}] importing ${selected.length}/${sessions.length} session(s)`);

    for (const session of selected) {
      try {
        const trace = await adapter.importSession(session.source_session_id);
        if (trace.messages.length === 0) {
          continue;
        }
        await store.saveTrace(trace);
        sourceStats.imported += 1;
        summary.imported += 1;
      } catch (error) {
        sourceStats.failed += 1;
        summary.failed += 1;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        console.warn(`[${adapter.source}] failed ${session.source_session_id}: ${message}`);
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Trace store: ${store.paths.traces}`);
  return summary;
}

function parseCliArgs(args: string[]): ImportOptions {
  const sources = new Set<TraceSource>(["cursor", "claude_code", "codex"]);
  let limitPerSource: number | undefined;
  let watch = false;
  let intervalMs: number | undefined;

  for (const arg of args) {
    if (arg === "--watch") {
      watch = true;
    }

    if (arg.startsWith("--sources=")) {
      sources.clear();
      for (const source of arg.slice("--sources=".length).split(",")) {
        if (isImportSource(source)) {
          sources.add(source);
        }
      }
    }

    if (arg.startsWith("--limit-per-source=")) {
      const value = Number(arg.slice("--limit-per-source=".length));
      if (Number.isFinite(value) && value > 0) {
        limitPerSource = value;
      }
    }

    if (arg.startsWith("--interval=")) {
      const value = Number(arg.slice("--interval=".length));
      if (Number.isFinite(value) && value > 0) {
        intervalMs = value;
      }
    }
  }

  return {
    sources,
    limitPerSource,
    watch,
    intervalMs,
  };
}

function isImportSource(value: string): value is TraceSource {
  return value === "cursor" || value === "claude_code" || value === "codex";
}

export async function watchLocalAgentSessions(options = parseCliArgs(process.argv.slice(2))): Promise<void> {
  const service = new SyncService({
    sources: options.sources,
    intervalMs: options.intervalMs,
    limitPerSource: options.limitPerSource,
  });

  service.on("synced", (summary) => {
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Next sync: ${service.getStatus().next_run_at ?? "not scheduled"}`);
  });

  console.log(`Watching local agent history every ${service.getStatus().interval_ms}ms`);
  service.start();
  await waitForStopSignal(service);
}

function waitForStopSignal(service: SyncService): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      service.stop();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.watch) {
    await watchLocalAgentSessions(options);
  } else {
    await importLocalAgentSessions(options);
  }
}
