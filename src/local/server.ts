import express, { type Request, type Response } from "express";
import { createServer as createHttpServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGenericSession, parseTraceFile } from "../parser/genericJsonParser.js";
import { LocalTraceStore } from "./store.js";
import { seedExampleTrace } from "./seed.js";
import { SyncService } from "./sync.js";

export interface LocalServerOptions {
  port?: number;
  host?: string;
  store?: LocalTraceStore;
  sync?: SyncService;
  enableSync?: boolean;
  syncIntervalMs?: number;
  publicDir?: string;
}

const defaultPublicDir = fileURLToPath(new URL("../../public", import.meta.url));

export function createLocalApp(options: LocalServerOptions = {}) {
  const app = express();
  const store = options.store ?? new LocalTraceStore();
  const sync = options.sync ?? new SyncService({
    store,
    intervalMs: options.syncIntervalMs ?? syncIntervalFromEnv(),
  });
  const publicDir = options.publicDir ?? defaultPublicDir;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(publicDir));

  app.get("/api/health", async (_request, response) => {
    await store.ensure();
    response.json({
      ok: true,
      store: store.paths.root,
    });
  });

  app.get("/api/traces", async (request, response, next) => {
    try {
      const traces = await store.listTraces({
        query: stringQuery(request, "q"),
        source: stringQuery(request, "source"),
        workspace: stringQuery(request, "workspace"),
      });

      response.json({
        traces,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/traces/:traceId", async (request, response, next) => {
    try {
      const trace = await store.getTrace(request.params.traceId);

      if (!trace) {
        response.status(404).json({
          error: "Trace not found",
        });
        return;
      }

      response.json({
        trace,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/user-messages", async (request, response, next) => {
    try {
      const result = await store.listUserMessages({
        query: stringQuery(request, "q"),
        source: stringQuery(request, "source"),
        workspace: stringQuery(request, "workspace"),
        limit: numberQuery(request, "limit"),
      });

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/replay", async (request, response, next) => {
    try {
      const workspace = stringQuery(request, "workspace");

      if (!workspace) {
        response.status(400).json({
          error: "workspace is required",
        });
        return;
      }

      const result = await store.getProjectReplay({
        query: stringQuery(request, "q"),
        source: stringQuery(request, "source"),
        workspace,
        limit: numberQuery(request, "limit"),
      });

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sync/status", (_request, response) => {
    response.json(sync.getStatus());
  });

  app.post("/api/sync/run", async (_request, response, next) => {
    try {
      const summary = await sync.runNow();
      response.json({
        summary,
        status: sync.getStatus(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sync/start", (_request, response) => {
    response.json(sync.start());
  });

  app.post("/api/sync/stop", (_request, response) => {
    response.json(sync.stop());
  });

  app.get("/api/traces/:traceId/messages/:messageId/images/:imageIndex", async (request, response, next) => {
    try {
      const image = await store.getUserMessageImage(
        request.params.traceId,
        request.params.messageId,
        Number(request.params.imageIndex),
      );

      if (!image) {
        response.status(404).json({
          error: "Image not found",
        });
        return;
      }

      response
        .type(image.mime_type)
        .set("Cache-Control", "private, max-age=86400")
        .send(image.data);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/traces/import", async (request, response, next) => {
    try {
      const body = request.body as {
        path?: string;
        raw?: unknown;
      };

      const trace = body.path
        ? await parseTraceFile(body.path, { source: "manual_json" })
        : await parseGenericSession(body.raw, { source: "manual_json" });

      const savedTrace = await store.saveTrace(trace);
      response.status(201).json({
        trace: savedTrace,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("*splat", async (_request, response, next) => {
    try {
      response.type("html").send(await readFile(path.join(publicDir, "index.html"), "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    response.status(500).json({
      error: message,
    });
  });

  return {
    app,
    store,
    sync,
  };
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<Server> {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const preferredPort = options.port ?? Number(process.env.PORT || 4317);
  const { app, store, sync } = createLocalApp(options);

  await store.ensure();
  await seedExampleTrace(store);

  for (let offset = 0; offset < 20; offset += 1) {
    const port = preferredPort + offset;
    try {
      const server = await listen(app, port, host);
      console.log(`Vibe Trace local UI: http://${host}:${port}`);
      console.log(`Trace store: ${store.paths.root}`);
      if (options.enableSync ?? syncEnabledFromEnv()) {
        sync.start();
        console.log(`History sync: every ${sync.getStatus().interval_ms}ms`);
      }
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(`No available port found starting at ${preferredPort}`);
}

function listen(app: express.Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(app);

    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function stringQuery(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

function numberQuery(request: Request, key: string): number | undefined {
  const value = request.query[key];
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function syncEnabledFromEnv(): boolean {
  const value = process.env.VIBETRACE_SYNC;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function syncIntervalFromEnv(): number | undefined {
  const value = process.env.VIBETRACE_SYNC_INTERVAL_MS ?? process.env.VIBETRACE_SYNC_INTERVAL;
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startLocalServer();
}
