import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Pause, Play, RefreshCw, Search, SkipBack, SkipForward, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { cn } from "./lib/utils";

const PROJECT_PAGE_SIZE = 12;
const PROJECT_PAGE_INCREMENT = 9;
const PREVIEW_TURN_LIMIT = 30;
const DETAIL_TURN_LIMIT = 1000;
const ACTIVE_SESSION_BUFFER_MS = 2600;

type TraceSource = "codex" | "claude_code" | "cursor" | "fixture" | string;

interface WorkspaceInfo {
  name: string;
  path: string;
  repo_url?: string | null;
}

interface TraceSummary {
  trace_id: string;
  title: string;
  source: TraceSource;
  session_kind?: string;
  workspace: WorkspaceInfo;
  started_at: string;
  ended_at?: string | null;
  message_count: number;
  token_count: number;
  tool_call_count: number;
  file_change_count: number;
  checkpoint_count: number;
  metadata?: Record<string, unknown>;
}

interface ProjectGroup {
  key: string;
  name: string;
  latest_at: string;
  traces: TraceSummary[];
  sources: Record<string, number>;
  source_summary: string;
  message_count: number;
  token_count: number;
  tool_call_count: number;
  file_change_count: number;
  checkpoint_count: number;
}

interface ReplayImage {
  index: number;
  src: string;
  mime_type: string;
}

interface CountSummary {
  name: string;
  count: number;
}

interface ReplayTurn {
  turn_id: string;
  trace_id: string;
  trace_title: string;
  session_id?: string;
  session_title?: string;
  session_started_at?: string;
  source: TraceSource;
  session_kind?: string;
  workspace: WorkspaceInfo;
  user: {
    content: string;
    created_at: string;
    images: ReplayImage[];
    is_truncated: boolean;
    character_count: number;
    estimated_token_count: number;
  };
  agent: {
    content: string;
    created_at: string | null;
    is_truncated: boolean;
    message_count: number;
    tool_call_count: number;
    tool_call_types: Array<{ name: string; count: number }>;
    file_change_count: number;
    checkpoint_count: number;
  };
}

interface ReplayResult {
  project: WorkspaceInfo | null;
  turns: ReplayTurn[];
  stats: {
    turn_count: number;
    shown_turn_count: number;
    message_count?: number;
    token_count?: number;
    trace_count: number;
    tool_call_count: number;
    tool_call_types?: CountSummary[];
    file_change_count: number;
    checkpoint_count: number;
    model_counts?: CountSummary[];
    source_counts?: CountSummary[];
  };
}

interface SyncSourceRunSummary {
  found: number;
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
  message?: string;
}

interface SyncRunSummary {
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
  by_source: Record<string, SyncSourceRunSummary>;
}

interface SyncStatus {
  running: boolean;
  syncing: boolean;
  interval_ms: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  last_summary: SyncRunSummary | null;
}

interface ReplayFrame {
  kind: "user" | "agent";
  turn: ReplayTurn;
  turnIndex: number;
}

interface ReplaySessionInfo {
  key: string;
  label: string;
  sourceLabel: string;
  startedAt: string;
  turnCount: number;
}

interface ReplayTimelineSession {
  key: string;
  label: string;
  sourceLabel: string;
  start: string;
  end: string;
  turnCount: number;
  events: Array<{
    time: string;
    label: string;
  }>;
}

type SortMode = "latest" | "name" | "sessions";

export function App() {
  const [status, setStatus] = useState("Ready");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [workspace, setWorkspace] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("latest");
  const [visibleCount, setVisibleCount] = useState(PROJECT_PAGE_SIZE);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [availableSources, setAvailableSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  useEffect(() => {
    void fetchJson<{ ok: boolean }>("/api/health")
      .then((health) => setStatus(health.ok ? "Local" : "Offline"))
      .catch(() => setStatus("Offline"));
  }, []);

  const loadTraces = useCallback((options: { signal?: AbortSignal; quiet?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (source !== "all") params.set("source", source);
    if (workspace) params.set("workspace", workspace);

    if (!options.quiet) setLoading(true);

    return fetchJson<{ traces: TraceSummary[] }>(`/api/traces?${params.toString()}`, { signal: options.signal })
      .then((data) => {
        setTraces(data.traces);
        setAvailableSources((existing) =>
          Array.from(new Set([...existing, ...data.traces.map((trace) => trace.source)])).sort(),
        );
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError" && !options.quiet) setTraces([]);
      })
      .finally(() => {
        if (!options.quiet) setLoading(false);
      });
  }, [query, source, workspace]);

  const refreshSyncStatus = useCallback(() => {
    return fetchJson<SyncStatus>("/api/sync/status")
      .then(setSyncStatus)
      .catch(() => setSyncStatus(null));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTraces({ signal: controller.signal });
    return () => controller.abort();
  }, [loadTraces]);

  useEffect(() => {
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void loadTraces({ quiet: true });
      void refreshSyncStatus();
    };
    const interval = window.setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [loadTraces, refreshSyncStatus]);

  const runSync = () => {
    setSyncBusy(true);
    fetchJson<{ summary: SyncRunSummary; status: SyncStatus }>("/api/sync/run", { method: "POST" })
      .then((result) => {
        setSyncStatus(result.status);
        return loadTraces({ quiet: true });
      })
      .catch(() => setStatus("Sync failed"))
      .finally(() => setSyncBusy(false));
  };

  const toggleSync = () => {
    const endpoint = syncStatus?.running ? "/api/sync/stop" : "/api/sync/start";
    fetchJson<SyncStatus>(endpoint, { method: "POST" })
      .then(setSyncStatus)
      .catch(() => setStatus("Sync failed"));
  };

  const groups = useMemo(
    () => sortProjectGroups(groupTracesByProject(traces), sortMode),
    [traces, sortMode],
  );
  const selectedGroup = selectedProjectKey ? groups.find((group) => group.key === selectedProjectKey) : null;
  const syncLabel = syncStatus?.syncing
    ? "Syncing"
    : syncStatus?.running
      ? "Auto sync"
      : "Manual sync";
  const syncCount = syncStatus?.last_summary?.imported ?? 0;

  return (
    <div className="min-h-screen bg-[#f6f7f4]">
      <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-[#fbfcf8]/95 px-5 py-3 shadow-sm backdrop-blur xl:px-10">
        <div className="grid gap-4 xl:grid-cols-[auto_minmax(420px,1fr)_auto] xl:items-center">
          <button
            className="grid text-left"
            type="button"
            onClick={() => {
              setSelectedProjectKey(null);
              setVisibleCount(PROJECT_PAGE_SIZE);
            }}
          >
            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Local</span>
            <span className="text-2xl font-black leading-none text-zinc-950">Vibe Trace</span>
          </button>

          <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_160px_minmax(180px,0.45fr)]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white pl-10 pr-3 text-sm outline-none ring-0 transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                placeholder="Search projects, prompts, agents"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(PROJECT_PAGE_SIZE);
                }}
              />
            </label>
            <select
              className="h-11 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-bold outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setVisibleCount(PROJECT_PAGE_SIZE);
              }}
            >
              <option value="all">All agents</option>
              {availableSources.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <input
              className="h-11 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
              placeholder="Workspace"
              value={workspace}
              onChange={(event) => {
                setWorkspace(event.target.value);
                setVisibleCount(PROJECT_PAGE_SIZE);
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={runSync}
              disabled={syncBusy || syncStatus?.syncing}
              title="Run history sync"
            >
              <RefreshCw className={cn("h-4 w-4", (syncBusy || syncStatus?.syncing) && "animate-spin")} />
              Sync
            </Button>
            <Button
              type="button"
              variant={syncStatus?.running ? "subtle" : "outline"}
              size="sm"
              onClick={toggleSync}
              title={syncStatus?.running ? "Stop auto sync" : "Start auto sync"}
            >
              {syncStatus?.running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {syncStatus?.running ? "Auto" : "Start"}
            </Button>
            <span className="inline-flex h-9 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-black text-emerald-800 sm:px-4 sm:text-sm">
              {status} · {syncLabel}{syncCount ? ` +${syncCount}` : ""}
            </span>
          </div>
        </div>
      </header>

      <main className="px-5 py-7 xl:px-10">
        {selectedGroup ? (
          <ProjectWatch group={selectedGroup} onBack={() => setSelectedProjectKey(null)} />
        ) : (
          <ProjectHome
            groups={groups}
            loading={loading}
            sortMode={sortMode}
            visibleCount={visibleCount}
            onSortChange={setSortMode}
            onLoadMore={() => setVisibleCount((count) => Math.min(groups.length, count + PROJECT_PAGE_INCREMENT))}
            onOpenProject={setSelectedProjectKey}
          />
        )}
      </main>
    </div>
  );
}

function ProjectHome({
  groups,
  loading,
  sortMode,
  visibleCount,
  onSortChange,
  onLoadMore,
  onOpenProject,
}: {
  groups: ProjectGroup[];
  loading: boolean;
  sortMode: SortMode;
  visibleCount: number;
  onSortChange: (value: SortMode) => void;
  onLoadMore: () => void;
  onOpenProject: (key: string) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleGroups = groups.slice(0, visibleCount);

  useEffect(() => {
    if (!sentinelRef.current || visibleCount >= groups.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "560px 0px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [groups.length, onLoadMore, visibleCount]);

  const totalMessages = groups.reduce((sum, group) => sum + group.message_count, 0);
  const totalTokens = groups.reduce((sum, group) => sum + group.token_count, 0);

  return (
    <section className="grid gap-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Replay Home</p>
          <h1 className="mt-1 text-4xl font-black tracking-tight text-zinc-950">Project Replays</h1>
          <p className="mt-2 text-sm text-zinc-600">
            {groups.length} projects · {formatCompactNumber(totalMessages)} messages · {formatCompactNumber(totalTokens)} tokens
          </p>
        </div>
        <label className="grid gap-1 text-xs font-black text-zinc-500">
          Sort
          <select
            className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-black text-zinc-950"
            value={sortMode}
            onChange={(event) => onSortChange(event.target.value as SortMode)}
          >
            <option value="latest">Recent</option>
            <option value="name">A-Z</option>
            <option value="sessions">Sessions</option>
          </select>
        </label>
      </div>

      {loading && <p className="text-sm font-bold text-zinc-500">Loading projects...</p>}

      <div className="grid grid-cols-1 gap-x-5 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
        {visibleGroups.map((group) => (
          <ProjectVideoCard key={group.key} group={group} onOpen={() => onOpenProject(group.key)} />
        ))}
      </div>

      {visibleCount < groups.length ? (
        <div ref={sentinelRef} className="grid min-h-24 place-items-center text-sm font-black text-zinc-500">
          Loading more projects
        </div>
      ) : (
        <p className="py-8 text-center text-sm font-bold text-zinc-500">{groups.length} projects loaded</p>
      )}
    </section>
  );
}

function ProjectVideoCard({ group, onOpen }: { group: ProjectGroup; onOpen: () => void }) {
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [error, setError] = useState(false);
  const [isUpgradingReplay, setIsUpgradingReplay] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchProjectReplay(group.key, PREVIEW_TURN_LIMIT, controller.signal)
      .then(setReplay)
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(true);
      });
    return () => controller.abort();
  }, [group.key]);

  const upgradeReplayForFullscreen = () => {
    if (isUpgradingReplay || !replay || replay.stats.shown_turn_count >= replay.stats.turn_count) return;

    setIsUpgradingReplay(true);
    fetchProjectReplay(group.key, DETAIL_TURN_LIMIT)
      .then(setReplay)
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(true);
      })
      .finally(() => setIsUpgradingReplay(false));
  };

  return (
    <motion.article layout className="grid min-w-0 gap-3" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden bg-zinc-950">
        {replay ? (
          <ReplayPlayer replay={replay} project={group} compact onFullscreenStart={upgradeReplayForFullscreen} />
        ) : (
          <div className="grid aspect-video place-items-center bg-zinc-950 text-sm font-bold text-zinc-400">
            {error ? "Replay unavailable" : "Loading replay"}
          </div>
        )}
      </Card>
      <div className="grid gap-1">
        <button className="min-w-0 text-left" type="button" onClick={onOpen}>
          <strong className="line-clamp-2 text-[15px] font-black leading-tight text-zinc-950">{group.name}</strong>
        </button>
        <p className="text-sm text-zinc-600">
          {formatCompactNumber(group.message_count)} messages · {formatCompactNumber(group.token_count)} tokens
        </p>
        <span className="truncate text-xs font-bold text-zinc-500">{group.source_summary || "unknown"}</span>
        {isUpgradingReplay ? <span className="text-xs font-black text-emerald-700">Loading full replay...</span> : null}
      </div>
    </motion.article>
  );
}

function ProjectWatch({ group, onBack }: { group: ProjectGroup; onBack: () => void }) {
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [jumpTo, setJumpTo] = useState<{ index: number; nonce: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setReplay(null);
    fetchProjectReplay(group.key, DETAIL_TURN_LIMIT, controller.signal).then(setReplay);
    return () => controller.abort();
  }, [group.key]);

  const frames = useMemo(() => projectReplayFrames(replay), [replay]);

  return (
    <section className="grid gap-4">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Project Watch</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-end gap-x-5 gap-y-2">
            <h1 className="min-w-0 text-3xl font-black tracking-tight text-zinc-950 sm:text-4xl">{group.name}</h1>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-xs text-zinc-500">
              <ProjectMetric label="Turns" value={formatCompactNumber(replay?.stats.turn_count ?? 0)} />
              <ProjectMetric label="Messages" value={formatCompactNumber(group.message_count)} />
              <ProjectMetric label="Tools" value={formatCompactNumber(group.tool_call_count)} />
              <ProjectMetric label="Files" value={formatCompactNumber(group.file_change_count)} />
            </div>
          </div>
          <p className="mt-1 max-w-4xl truncate text-xs font-medium text-zinc-400">{group.key}</p>
        </div>
        <Button className="justify-self-start xl:justify-self-end" variant="outline" size="sm" onClick={onBack}>
          Back to home
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,0.65fr)]">
        <div>{replay ? <ReplayPlayer replay={replay} project={group} jumpTo={jumpTo} /> : <ReplaySkeleton />}</div>
        <aside className="grid max-h-[calc(100vh-8rem)] gap-3 overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 xl:sticky xl:top-28">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black">Messages</h2>
            <span className="text-sm font-bold text-zinc-500">{frames.length}</span>
          </div>
          <div className="grid min-h-0 gap-2 overflow-y-auto pr-1">
            {frames.map((frame, index) => (
              <TranscriptItem
                key={`${frame.turn.turn_id}-${frame.kind}-${index}`}
                frame={frame}
                onClick={() => setJumpTo({ index, nonce: Date.now() })}
              />
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function ReplayPlayer({
  replay,
  project,
  compact = false,
  jumpTo,
  onFullscreenStart,
}: {
  replay: ReplayResult;
  project?: ProjectGroup;
  compact?: boolean;
  jumpTo?: { index: number; nonce: number } | null;
  onFullscreenStart?: () => void;
}) {
  const frames = useMemo(() => projectReplayFrames(replay), [replay]);
  const replaySessions = useMemo(() => replaySessionsFromTurns(replay.turns), [replay.turns]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pausedByScroll, setPausedByScroll] = useState(false);
  const [activeSessionKeys, setActiveSessionKeys] = useState<Set<string>>(() => new Set());
  const [speed, setSpeed] = useState(1);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const activeSessionKeysRef = useRef<Set<string>>(new Set());
  const hideSessionTimersRef = useRef<Record<string, number | undefined>>({});
  const shellRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const suppressScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);

  const clampedIndex = normalizeFrameIndex(frameIndex, frames.length);
  const visibleFrames = frames.slice(0, clampedIndex + 1);
  const currentFrame = frames[clampedIndex];
  const loadedFrameCount = frames.length;
  const totalFrameCount = loadedFrameCount;
  const isSplitReplay = replaySessions.length > 1;
  const showReplaySummary = frames.length > 0 && clampedIndex >= frames.length - 1 && !playing;
  const showAgentTyping =
    playing &&
    currentFrame?.kind === "user" &&
    frames[clampedIndex + 1]?.kind === "agent";
  const pendingAgentFrame = showAgentTyping ? frames[clampedIndex + 1] : null;
  const currentSessionKey = currentFrame ? sessionKeyForTurn(currentFrame.turn) : "";
  const pendingSessionKey = pendingAgentFrame ? sessionKeyForTurn(pendingAgentFrame.turn) : "";
  const activeReplaySessions = useMemo(() => {
    if (!isSplitReplay) return replaySessions;
    const keys = new Set(activeSessionKeys);
    if (currentSessionKey) keys.add(currentSessionKey);
    if (pendingSessionKey) keys.add(pendingSessionKey);
    return replaySessions.filter((session) => keys.has(session.key));
  }, [activeSessionKeys, currentSessionKey, isSplitReplay, pendingSessionKey, replaySessions]);

  useEffect(() => {
    activeSessionKeysRef.current = activeSessionKeys;
  }, [activeSessionKeys]);

  useEffect(() => {
    activeSessionKeysRef.current = new Set();
    setActiveSessionKeys(new Set());
    for (const timer of Object.values(hideSessionTimersRef.current)) {
      if (timer) window.clearTimeout(timer);
    }
    hideSessionTimersRef.current = {};
  }, [replay]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(hideSessionTimersRef.current)) {
        if (timer) window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!isSplitReplay) return;
    const activeNow = [currentSessionKey, pendingSessionKey].filter(Boolean);
    if (activeNow.length === 0) return;

    setActiveSessionKeys((previous) => {
      const next = new Set(previous);
      for (const key of activeNow) next.add(key);
      activeSessionKeysRef.current = next;
      return next;
    });

    for (const key of activeNow) {
      const timer = hideSessionTimersRef.current[key];
      if (timer) {
        window.clearTimeout(timer);
        delete hideSessionTimersRef.current[key];
      }
    }

    for (const session of replaySessions) {
      if (activeNow.includes(session.key)) continue;
      if (!activeSessionKeysRef.current.has(session.key) || hideSessionTimersRef.current[session.key]) continue;

      hideSessionTimersRef.current[session.key] = window.setTimeout(() => {
        setActiveSessionKeys((previous) => {
          const next = new Set(previous);
          next.delete(session.key);
          activeSessionKeysRef.current = next;
          return next;
        });
        delete hideSessionTimersRef.current[session.key];
      }, ACTIVE_SESSION_BUFFER_MS);
    }
  }, [currentSessionKey, isSplitReplay, pendingSessionKey, replaySessions]);

  useEffect(() => {
    if (!jumpTo) return;
    setPlaying(false);
    setPausedByScroll(false);
    setFrameIndex(normalizeFrameIndex(jumpTo.index, frames.length));
    requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
  }, [frames.length, isSplitReplay, jumpTo]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (clampedIndex >= frames.length - 1) {
      setPlaying(false);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      setFrameIndex((index) => normalizeFrameIndex(index + 1, frames.length));
      requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
    }, replayFrameDuration(currentFrame, speed) * (compact ? 0.78 : 1));

    return () => clearReplayTimer(timerRef);
  }, [clampedIndex, compact, currentFrame, frames.length, isSplitReplay, playing, speed]);

  useEffect(() => {
    requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
  }, [clampedIndex, isSplitReplay]);

  useEffect(() => {
    if (showAgentTyping) {
      requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
    }
  }, [isSplitReplay, showAgentTyping]);

  const playOrPause = () => {
    if (playing) {
      setPlaying(false);
      setPausedByScroll(false);
      clearReplayTimer(timerRef);
      return;
    }

    setPlaying(true);
    setPausedByScroll(false);
    if (clampedIndex >= frames.length - 1) setFrameIndex(0);
    requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
  };

  const jump = (index: number) => {
    setPausedByScroll(false);
    setFrameIndex(normalizeFrameIndex(index, frames.length));
    requestAnimationFrame(() => scrollReplayToLatest(feedRef.current, paneRefs.current, suppressScrollRef, isSplitReplay));
  };

  const handleReplayScroll = (target: HTMLElement | null) => {
    if (suppressScrollRef.current || !target) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;

    const atLatest = isReplayFeedAtLatest(target);
    if (!atLatest && playing) {
      setPlaying(false);
      setPausedByScroll(true);
      clearReplayTimer(timerRef);
    }
    if (atLatest && pausedByScroll && clampedIndex < frames.length - 1) {
      const panesAreAtLatest = !isSplitReplay || replayPanesAtLatest(paneRefs.current);
      if (panesAreAtLatest) {
        setPausedByScroll(false);
        setPlaying(true);
      }
    }
  };
  const markUserScrollIntent = () => {
    userScrollIntentUntilRef.current = Date.now() + 1800;
  };

  return (
    <div
      ref={shellRef}
      className={cn(
        "replay-player-shell grid overflow-hidden rounded-lg border border-zinc-200 bg-white",
        compact ? "aspect-video grid-rows-[minmax(0,1fr)_auto]" : "grid-rows-[auto_minmax(0,1fr)_auto]",
      )}
    >
      <ReplayPlayerHeader replay={replay} project={project} compact={compact} />
      <div
        ref={feedRef}
        className={cn(
          "replay-player-main bg-gradient-to-b from-zinc-50 to-emerald-50/50 p-3",
          isSplitReplay ? "overflow-hidden" : "grid content-start gap-3 overflow-y-auto",
          compact ? "min-h-0" : isSplitReplay ? "h-[72vh] min-h-[520px]" : "min-h-[520px] max-h-[72vh]",
        )}
        onScroll={() => {
          if (!isSplitReplay) handleReplayScroll(feedRef.current);
        }}
        onWheel={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
      >
        {showReplaySummary ? (
          <ProjectReplaySummary replay={replay} sessions={replaySessions} compact={compact} />
        ) : isSplitReplay ? (
          <SplitReplayGrid
            activeSessions={activeReplaySessions}
            visibleFrames={visibleFrames}
            pendingAgentFrame={pendingAgentFrame}
            total={totalFrameCount}
            compact={compact}
            paneRefs={paneRefs}
            onPaneScroll={handleReplayScroll}
            onPaneScrollIntent={markUserScrollIntent}
          />
        ) : (
          <AnimatePresence initial={false}>
            {visibleFrames.map((frame, index) => (
              <ReplayBubble
                key={`${frame.turn.turn_id}-${frame.kind}`}
                frame={frame}
                index={index}
                total={totalFrameCount}
                compact={compact}
              />
            ))}
            {pendingAgentFrame ? (
              <ReplayBubble
                key={`${pendingAgentFrame.turn.turn_id}-${pendingAgentFrame.kind}`}
                frame={pendingAgentFrame}
                index={clampedIndex + 1}
                total={totalFrameCount}
                compact={compact}
                pending
              />
            ) : null}
          </AnimatePresence>
        )}
      </div>

      <div className={cn("grid gap-3 border-t border-zinc-200 bg-white p-3", compact ? "grid-cols-[auto_1fr_auto]" : "grid-cols-[auto_minmax(180px,1fr)_auto_auto]")}>
        <div className="flex gap-2">
          <Button variant="outline" size={compact ? "icon" : "sm"} onClick={() => jump(clampedIndex - 1)} disabled={frames.length === 0}>
            <SkipBack className="h-4 w-4" />
            {!compact && "Prev"}
          </Button>
          <Button variant={playing ? "subtle" : "default"} size={compact ? "icon" : "sm"} onClick={playOrPause} disabled={frames.length === 0}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {!compact && (playing ? "Pause" : "Play")}
          </Button>
          {!compact && (
            <Button variant="outline" size="sm" onClick={() => jump(clampedIndex + 1)} disabled={frames.length === 0}>
              <SkipForward className="h-4 w-4" />
              Next
            </Button>
          )}
        </div>

        <label className="grid min-w-0 gap-1">
          {!compact && (
            <span className="truncate text-xs font-black text-zinc-500">
              {currentFrame ? replayFrameStatus(currentFrame, clampedIndex, loadedFrameCount, totalFrameCount) : "0 / 0"}
            </span>
          )}
          <input
            className="w-full accent-emerald-700"
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={clampedIndex}
            onChange={(event) => jump(Number(event.target.value))}
          />
        </label>

        {!compact && (
          <select
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2 text-sm font-black"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <option value={0.75}>0.75x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
        )}

        <Button
          variant="outline"
          size={compact ? "icon" : "sm"}
          onClick={() => {
            onFullscreenStart?.();
            void shellRef.current?.requestFullscreen?.();
          }}
        >
          <Maximize2 className="h-4 w-4" />
          {!compact && "Fullscreen"}
        </Button>
      </div>
    </div>
  );
}

function SplitReplayGrid({
  activeSessions,
  visibleFrames,
  pendingAgentFrame,
  total,
  compact,
  paneRefs,
  onPaneScroll,
  onPaneScrollIntent,
}: {
  activeSessions: ReplaySessionInfo[];
  visibleFrames: ReplayFrame[];
  pendingAgentFrame: ReplayFrame | null;
  total: number;
  compact?: boolean;
  paneRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onPaneScroll: (target: HTMLElement | null) => void;
  onPaneScrollIntent: () => void;
}) {
  return (
    <div className="grid h-full min-h-0 gap-3" style={splitGridStyle(activeSessions.length)}>
      <AnimatePresence initial={false} mode="popLayout">
        {activeSessions.map((session) => {
          const sessionFrames = visibleFrames.filter((frame) => sessionKeyForTurn(frame.turn) === session.key);
          const pendingForSession = pendingAgentFrame && sessionKeyForTurn(pendingAgentFrame.turn) === session.key ? pendingAgentFrame : null;
          const accent = sessionColorByKey(session.key);
          const playedSessionCount = sessionFrames.filter((frame) => frame.kind === "user").length;

          return (
            <motion.section
              key={session.key}
              layout
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -8 }}
              transition={{ duration: 0.22 }}
              className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border bg-white/80 shadow-sm"
              style={{ borderColor: accent.border }}
            >
              <header className={cn("flex items-center justify-between gap-3 border-b px-3 py-2", compact && "px-2 py-1.5")} style={{ borderColor: accent.border }}>
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-2 text-xs font-black text-zinc-950">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent.strong }} />
                    <span className="truncate">{session.label}</span>
                  </p>
                  {!compact ? <p className="mt-0.5 truncate text-[11px] font-bold text-zinc-500">{session.sourceLabel}</p> : null}
                </div>
                <span className="shrink-0 text-[11px] font-black text-zinc-500">
                  {playedSessionCount}/{session.turnCount}
                </span>
              </header>

              <div
                ref={(node) => {
                  paneRefs.current[session.key] = node;
                }}
                className="grid content-start gap-2 overflow-y-auto p-2"
                onScroll={() => onPaneScroll(paneRefs.current[session.key])}
                onWheel={onPaneScrollIntent}
                onPointerDown={onPaneScrollIntent}
                onTouchStart={onPaneScrollIntent}
              >
                <AnimatePresence initial={false}>
                  {sessionFrames.map((frame) => (
                    <ReplayBubble
                      key={`${frame.turn.turn_id}-${frame.kind}`}
                      frame={frame}
                      index={visibleFrames.indexOf(frame)}
                      total={total}
                      compact={compact}
                      inPane
                    />
                  ))}
                  {pendingForSession ? (
                    <ReplayBubble
                      key={`${pendingForSession.turn.turn_id}-${pendingForSession.kind}`}
                      frame={pendingForSession}
                      index={visibleFrames.length}
                      total={total}
                      compact={compact}
                      pending
                      inPane
                    />
                  ) : null}
                </AnimatePresence>
              </div>
            </motion.section>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function ReplayBubble({
  frame,
  index,
  total,
  compact,
  pending = false,
  inPane = false,
}: {
  frame: ReplayFrame;
  index: number;
  total: number;
  compact?: boolean;
  pending?: boolean;
  inPane?: boolean;
}) {
  const isAgent = frame.kind === "agent";
  const content = pending ? "" : isAgent ? frame.turn.agent.content || "Agent activity" : frame.turn.user.content;
  const images = isAgent ? [] : frame.turn.user.images;
  const sessionAccent = sessionColor(frame.turn);
  const speakerName = isAgent ? agentDisplayName(frame.turn.source) : "User";
  const speakerMeta = pending ? "replying" : isAgent ? agentReplyMeta(frame.turn) : formatTime(frame.turn.user.created_at);
  const contentClassName = cn(
    "overflow-hidden whitespace-pre-wrap break-words text-sm leading-6 text-zinc-800",
    isAgent && "replay-agent-content",
    isAgent && compact && "replay-agent-content-compact",
    !isAgent && compact && "max-h-20 text-xs leading-5",
  );

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={cn("grid", isAgent && "justify-items-end")}
    >
      <div
        className={cn(
          "grid w-[88%] gap-2 rounded-r-lg border border-l-4 bg-white p-3 shadow-sm",
          inPane && "w-[96%]",
          compact && "w-[94%] p-2",
        )}
        style={{
          borderLeftColor: sessionAccent.strong,
          backgroundColor: isAgent ? sessionAccent.agentBackground : sessionAccent.userBackground,
        }}
      >
        <header className={cn("flex items-center gap-3 text-xs font-black", isAgent ? "justify-end text-right" : "justify-between")}>
          <strong className={cn("flex min-w-0 items-center gap-2", isAgent && "justify-end")}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: sessionAccent.strong }} />
            <span>{speakerName}</span>
            <span className="truncate text-zinc-500">{speakerMeta}</span>
            {!compact ? <span className="truncate text-zinc-400">{sessionLabel(frame.turn)}</span> : null}
          </strong>
          {compact && !pending ? <span className="shrink-0 text-zinc-500">{index + 1}/{total}</span> : null}
        </header>
        {pending ? (
          <div className={cn(contentClassName, "flex items-center")}>
            <ReplayTypingDots />
          </div>
        ) : content ? (
          <p className={contentClassName}>
            {content}
            {(isAgent ? frame.turn.agent.is_truncated : frame.turn.user.is_truncated) ? "..." : ""}
          </p>
        ) : null}
        {images.length > 0 ? <ReplayImageStrip images={images} compact={compact} /> : null}
        {isAgent ? (
          <div className="flex min-h-7 flex-wrap gap-1.5 text-[11px] font-bold text-zinc-600">
            {pending ? (
              <Pill>replying</Pill>
            ) : (
              <>
                <Pill>{frame.turn.agent.message_count} replies</Pill>
                <Pill>{frame.turn.agent.tool_call_count} tools</Pill>
                {frame.turn.agent.file_change_count ? <Pill>{frame.turn.agent.file_change_count} files</Pill> : null}
              </>
            )}
          </div>
        ) : (
          !compact && (
            <footer className="flex flex-wrap gap-2 text-xs font-bold text-zinc-500">
              <span>{formatCompactNumber(frame.turn.user.character_count)} chars</span>
              <span>{formatCompactNumber(frame.turn.user.estimated_token_count)} tokens</span>
              {images.length > 0 ? <span>{images.length} images</span> : null}
            </footer>
          )
        )}
      </div>
    </motion.article>
  );
}

function ReplayTypingDots() {
  return (
    <span className="flex items-center gap-2">
      <span className="replay-typing-dot" />
      <span className="replay-typing-dot" />
      <span className="replay-typing-dot" />
    </span>
  );
}

function TranscriptItem({ frame, onClick }: { frame: ReplayFrame; onClick: () => void }) {
  const isAgent = frame.kind === "agent";
  const content = isAgent ? frame.turn.agent.content || "Agent activity" : frame.turn.user.content;
  const sessionAccent = sessionColor(frame.turn);
  const speakerName = isAgent ? agentDisplayName(frame.turn.source) : "User";
  const speakerMeta = isAgent ? agentReplyMeta(frame.turn) : formatTime(frame.turn.user.created_at);

  return (
    <button
      className="grid gap-1 rounded-r-lg border border-l-4 bg-white p-3 text-left transition hover:border-blue-300 hover:shadow-sm"
      style={{
        borderLeftColor: sessionAccent.strong,
        backgroundColor: isAgent ? sessionAccent.agentBackground : sessionAccent.userBackground,
      }}
      type="button"
      onClick={onClick}
    >
      <span className={cn("flex gap-3 text-xs font-black", isAgent ? "justify-end text-right" : "justify-between")}>
        <strong className="min-w-0 truncate">{speakerName} · {speakerMeta} · {sessionLabel(frame.turn)}</strong>
      </span>
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-zinc-700">{content}</p>
      <small className="text-xs font-bold text-zinc-500">
        {isAgent
          ? `${frame.turn.agent.tool_call_count} tools`
          : `${formatCompactNumber(frame.turn.user.estimated_token_count)} tokens${
              frame.turn.user.images.length ? ` · ${frame.turn.user.images.length} images` : ""
            }`}
      </small>
    </button>
  );
}

function ReplayPlayerHeader({
  replay,
  project,
  compact,
}: {
  replay: ReplayResult;
  project?: ProjectGroup;
  compact?: boolean;
}) {
  const projectName = project?.name ?? replay.project?.name ?? "Project replay";
  const sourceSummary = project?.source_summary || formatSummaryList(replay.stats.source_counts, "Unknown source");
  const modelSummary = formatSummaryList(replay.stats.model_counts, "Unknown model", 3);
  const toolSummary = formatSummaryList(replay.stats.tool_call_types, "No tools", 3);

  return (
    <div
      className={cn(
        "replay-player-header grid gap-3 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur md:grid-cols-[minmax(0,1fr)_auto] md:items-start",
        compact && "hidden",
      )}
    >
      <div className="min-w-0 overflow-hidden">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-700">Project Replay</p>
        <h2 className="mt-0.5 truncate text-lg font-black text-zinc-950">{projectName}</h2>
        <p className="mt-1 truncate text-xs font-bold text-zinc-500">{sourceSummary}</p>
      </div>

      <div className="flex min-w-0 flex-wrap gap-2 text-xs md:justify-end">
        <HeaderMetric label="Models" value={modelSummary} />
        <HeaderMetric label="Tools" value={toolSummary} />
        <HeaderMetric label="Messages" value={formatCompactNumber(project?.message_count ?? replay.stats.message_count ?? 0)} />
        <HeaderMetric label="Tokens" value={formatCompactNumber(project?.token_count ?? replay.stats.token_count ?? 0)} />
        <HeaderMetric label="Turns" value={`${formatCompactNumber(replay.stats.shown_turn_count)} / ${formatCompactNumber(replay.stats.turn_count)}`} />
      </div>
    </div>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="max-w-[220px] rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
      <span className="block text-[10px] font-black uppercase tracking-wide text-zinc-500">{label}</span>
      <strong className="block truncate text-xs font-black text-zinc-950">{value}</strong>
    </div>
  );
}

function ProjectReplaySummary({
  replay,
  sessions,
  compact,
}: {
  replay: ReplayResult;
  sessions: ReplaySessionInfo[];
  compact?: boolean;
}) {
  const timeline = replayTimelineSummary(replay, sessions);

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid h-full min-h-0 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
    >
      <div className="grid content-start gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">Replay Complete</p>
            <h3 className={cn("mt-1 font-black text-zinc-950", compact ? "text-lg" : "text-2xl")}>Session Timeline</h3>
            <p className="mt-1 text-sm font-bold text-zinc-500">
              {timeline.start ? formatDateTime(timeline.start) : "Unknown start"} - {timeline.end ? formatDateTime(timeline.end) : "Unknown end"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <HeaderMetric label="Sessions" value={formatCompactNumber(timeline.sessions.length)} />
            <HeaderMetric label="Turns" value={formatCompactNumber(replay.stats.turn_count)} />
            <HeaderMetric label="Tools" value={formatCompactNumber(replay.stats.tool_call_count)} />
          </div>
        </div>

        <div className="relative grid gap-4 pl-4">
          <div className="absolute bottom-2 left-[1.05rem] top-2 w-px bg-zinc-200" />
          {timeline.sessions.map((session, index) => {
            const accent = sessionColorByKey(session.key);
            return (
              <div key={session.key} className="relative grid gap-2">
                <div className="absolute left-[-0.2rem] top-2 h-3 w-3 rounded-full ring-4 ring-white" style={{ backgroundColor: accent.strong }} />
                <div className="ml-5 rounded-lg border bg-white p-3 shadow-sm" style={{ borderColor: accent.border }}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-wide text-zinc-400">Branch {index + 1}</p>
                      <h4 className="truncate text-sm font-black text-zinc-950">{session.label}</h4>
                      <p className="mt-1 text-xs font-bold text-zinc-500">
                        {session.sourceLabel} · {formatDateTime(session.start)} - {formatDateTime(session.end)}
                      </p>
                    </div>
                    <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-black text-zinc-600">
                      {session.turnCount} chats
                    </span>
                  </div>

                  <div className="mt-3 flex min-w-0 items-center gap-2 overflow-hidden">
                    <div className="h-px w-8 shrink-0" style={{ backgroundColor: accent.strong }} />
                    <div className="flex min-w-0 flex-wrap gap-2">
                      {session.events.map((event) => (
                        <span
                          key={`${session.key}-${event.time}-${event.label}`}
                          className="inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-bold text-zinc-600"
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent.strong }} />
                          <span>{formatShortDateTime(event.time)}</span>
                          <span className="truncate text-zinc-400">{event.label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.section>
  );
}

function ReplayImageStrip({ images, compact }: { images: ReplayImage[]; compact?: boolean }) {
  const visibleImages = images.slice(0, compact ? 2 : 6);
  const hiddenCount = images.length - visibleImages.length;

  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3")}>
      {visibleImages.map((image) => (
        <a
          key={image.index}
          className={cn(
            "group relative overflow-hidden rounded-lg border border-zinc-200 bg-white",
            compact ? "h-16" : "h-40",
          )}
          href={image.src}
          target="_blank"
          rel="noreferrer"
        >
          <img
            className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]"
            src={image.src}
            alt={`User attached image ${image.index + 1}`}
            loading="lazy"
          />
          <span className="absolute bottom-1 right-1 rounded-full bg-zinc-950/75 px-2 py-0.5 text-[10px] font-black uppercase text-white">
            {image.mime_type.split("/").pop() || "image"}
          </span>
        </a>
      ))}
      {hiddenCount > 0 ? (
        <div className={cn("grid place-items-center rounded-lg border border-dashed border-zinc-300 bg-white text-sm font-black text-zinc-500", compact ? "h-16" : "h-40")}>
          +{hiddenCount} images
        </div>
      ) : null}
    </div>
  );
}

function ReplaySkeleton() {
  return (
    <Card className="grid min-h-[560px] place-items-center bg-white">
      <div className="grid justify-items-center gap-3 text-zinc-500">
        <Sparkles className="h-6 w-6" />
        <p className="text-sm font-bold">Loading project replay</p>
      </div>
    </Card>
  );
}

function ProjectMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="font-black uppercase tracking-wide text-zinc-400">{label}</span>
      <strong className="font-black text-zinc-700">{value}</strong>
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-zinc-200 bg-white px-2 py-1">{children}</span>;
}

function groupTracesByProject(traces: TraceSummary[]) {
  const projects = new Map<string, ProjectGroup>();

  for (const trace of traces.filter((trace) => !isCodexChatTrace(trace))) {
    const key = trace.workspace.path || trace.workspace.name || "unknown";
    const name = trace.workspace.name || projectNameFromPath(key);
    const group =
      projects.get(key) ??
      {
        key,
        name,
        latest_at: trace.started_at,
        traces: [],
        sources: {},
        source_summary: "",
        message_count: 0,
        token_count: 0,
        tool_call_count: 0,
        file_change_count: 0,
        checkpoint_count: 0,
      };

    group.traces.push(trace);
    group.message_count += trace.message_count;
    group.token_count += trace.token_count ?? Math.max(1, trace.message_count);
    group.tool_call_count += trace.tool_call_count;
    group.file_change_count += trace.file_change_count;
    group.checkpoint_count += trace.checkpoint_count;
    group.latest_at = trace.started_at > group.latest_at ? trace.started_at : group.latest_at;
    const sourceKey = trace.session_kind ? `${trace.source} ${trace.session_kind}` : trace.source;
    group.sources[sourceKey] = (group.sources[sourceKey] ?? 0) + 1;
    projects.set(key, group);
  }

  return Array.from(projects.values()).map((group) => ({
    ...group,
    traces: group.traces.sort((a, b) => b.started_at.localeCompare(a.started_at)),
    source_summary: Object.entries(group.sources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => `${source} ${count}`)
      .join(" · "),
  }));
}

function isCodexChatTrace(trace: TraceSummary) {
  return trace.source === "codex" && trace.session_kind === "chat";
}

function sortProjectGroups(groups: ProjectGroup[], sortMode: SortMode) {
  return [...groups].sort((a, b) => {
    if (sortMode === "name") return a.name.localeCompare(b.name) || b.latest_at.localeCompare(a.latest_at);
    if (sortMode === "sessions") return b.traces.length - a.traces.length || b.latest_at.localeCompare(a.latest_at);
    return b.latest_at.localeCompare(a.latest_at) || a.name.localeCompare(b.name);
  });
}

function projectReplayFrames(replay: ReplayResult | null): ReplayFrame[] {
  return (replay?.turns ?? []).flatMap((turn, turnIndex) => [
    { kind: "user" as const, turn, turnIndex },
    { kind: "agent" as const, turn, turnIndex },
  ]);
}

function replaySessionsFromTurns(turns: ReplayTurn[]): ReplaySessionInfo[] {
  const sessions = new Map<string, ReplaySessionInfo>();

  for (const turn of turns) {
    const key = sessionKeyForTurn(turn);
    const existing = sessions.get(key);
    if (existing) {
      existing.turnCount += 1;
      continue;
    }

    sessions.set(key, {
      key,
      label: sessionLabel(turn),
      sourceLabel: `${turn.source}${turn.session_kind ? ` ${turn.session_kind}` : ""}`,
      startedAt: turn.session_started_at ?? turn.user.created_at,
      turnCount: 1,
    });
  }

  return Array.from(sessions.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function fetchProjectReplay(projectKey: string, limit: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ workspace: projectKey, limit: String(limit) });
  return fetchJson<ReplayResult>(`/api/projects/replay?${params.toString()}`, { signal });
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function normalizeFrameIndex(index: number, frameCount: number) {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(frameCount - 1, Number.isFinite(index) ? Math.round(index) : 0));
}

function replayFrameStatus(frame: ReplayFrame, index: number, loadedTotal: number, projectTotal: number) {
  const countLabel = projectTotal > loadedTotal ? `${index + 1} / ${loadedTotal} loaded · ${projectTotal} total` : `${index + 1} / ${projectTotal}`;
  return `${countLabel} · Turn ${frame.turnIndex + 1} · ${frame.kind === "user" ? "User" : "Agent"}`;
}

function replayFrameDuration(frame: ReplayFrame | undefined, speed: number) {
  if (!frame) return 300;
  const content = frame.kind === "user" ? frame.turn.user.content : frame.turn.agent.content;
  const base = frame.kind === "user" ? 800 : 620;
  const lengthDelay = Math.min(900, Array.from(content || "").length * 4);
  return Math.max(220, Math.round((base + lengthDelay) / speed));
}

function clearReplayTimer(timerRef: React.MutableRefObject<number | null>) {
  if (timerRef.current) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function isReplayFeedAtLatest(feed: HTMLElement) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 28;
}

function scrollReplayToLatest(
  feed: HTMLElement | null,
  panes: Record<string, HTMLElement | null>,
  suppressRef: React.MutableRefObject<boolean>,
  splitReplay: boolean,
) {
  suppressRef.current = true;

  if (splitReplay) {
    for (const pane of Object.values(panes)) {
      if (pane) pane.scrollTop = pane.scrollHeight;
    }
  } else if (feed) {
    feed.scrollTop = feed.scrollHeight;
  }

  requestAnimationFrame(() => {
    suppressRef.current = false;
  });
}

function replayPanesAtLatest(panes: Record<string, HTMLElement | null>) {
  return Object.values(panes)
    .filter((pane): pane is HTMLElement => Boolean(pane))
    .every((pane) => isReplayFeedAtLatest(pane));
}

function splitGridStyle(sessionCount: number) {
  if (sessionCount <= 1) return undefined;

  return {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gridTemplateRows: sessionCount > 2 ? `repeat(${Math.ceil(sessionCount / 2)}, minmax(0, 1fr))` : "minmax(0, 1fr)",
  };
}

function formatReplayTime(frame: ReplayFrame) {
  const value = frame.kind === "user" ? frame.turn.user.created_at : frame.turn.agent.created_at;
  return value ? formatTime(value) : "";
}

function agentDisplayName(source: TraceSource) {
  if (source === "codex") return "Codex";
  if (source === "claude_code") return "ClaudeCode";
  if (source === "cursor") return "Cursor";
  return source
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function agentReplyMeta(turn: ReplayTurn) {
  if (!turn.agent.created_at) return "no reply";

  const duration = durationBetween(turn.user.created_at, turn.agent.created_at);
  return duration ? `${formatTime(turn.agent.created_at)} · ${duration}` : formatTime(turn.agent.created_at);
}

function durationBetween(startValue: string, endValue: string) {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function replayTimelineSummary(replay: ReplayResult, sessions: ReplaySessionInfo[]) {
  const sessionInfo = new Map(sessions.map((session) => [session.key, session]));
  const turnsBySession = new Map<string, ReplayTurn[]>();

  for (const turn of replay.turns) {
    const key = sessionKeyForTurn(turn);
    const turns = turnsBySession.get(key) ?? [];
    turns.push(turn);
    turnsBySession.set(key, turns);
  }

  const timelineSessions: ReplayTimelineSession[] = Array.from(turnsBySession.entries())
    .map(([key, turns]) => {
      const info = sessionInfo.get(key);
      const sortedTurns = [...turns].sort((a, b) => a.user.created_at.localeCompare(b.user.created_at));
      const start = sortedTurns[0]?.user.created_at ?? info?.startedAt ?? "";
      const end = sortedTurns.reduce((latest, turn) => {
        const candidate = turn.agent.created_at ?? turn.user.created_at;
        return candidate > latest ? candidate : latest;
      }, start);

      return {
        key,
        label: info?.label ?? sessionLabel(sortedTurns[0] as ReplayTurn),
        sourceLabel: info?.sourceLabel ?? "",
        start,
        end,
        turnCount: sortedTurns.length,
        events: sampleTimelineTurns(sortedTurns).map((turn) => ({
          time: turn.user.created_at,
          label: compactTimelineLabel(turn.user.content || turn.trace_title),
        })),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  return {
    start: timelineSessions.reduce((earliest, session) => (!earliest || session.start < earliest ? session.start : earliest), ""),
    end: timelineSessions.reduce((latest, session) => (session.end > latest ? session.end : latest), ""),
    sessions: timelineSessions,
  };
}

function sampleTimelineTurns(turns: ReplayTurn[]) {
  if (turns.length <= 6) return turns;
  const lastIndex = turns.length - 1;
  const indexes = new Set([
    0,
    Math.floor(lastIndex * 0.25),
    Math.floor(lastIndex * 0.5),
    Math.floor(lastIndex * 0.75),
    lastIndex,
  ]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => turns[index])
    .filter((turn): turn is ReplayTurn => Boolean(turn));
}

function compactTimelineLabel(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > 18 ? `${chars.slice(0, 18).join("")}...` : clean || "chat";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDateTime(value: string) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function formatSummaryList(entries: CountSummary[] | undefined, fallback: string, limit = 2) {
  if (!entries || entries.length === 0) return fallback;
  return entries
    .slice(0, limit)
    .map((entry) => `${entry.name} ${formatCompactNumber(entry.count)}`)
    .join(" · ");
}

function sessionKeyForTurn(turn: ReplayTurn) {
  return turn.session_id || turn.trace_id;
}

function sessionLabel(turn: ReplayTurn) {
  return turn.session_title || turn.trace_title || shortSessionId(sessionKeyForTurn(turn));
}

function shortSessionId(value: string) {
  const clean = value.split("/").pop() || value;
  return clean.length > 20 ? `${clean.slice(0, 8)}...${clean.slice(-6)}` : clean;
}

function sessionColor(turn: ReplayTurn) {
  return sessionColorByKey(sessionKeyForTurn(turn));
}

function sessionColorByKey(key: string) {
  const palette = SESSION_COLORS[stableHash(key) % SESSION_COLORS.length];
  return palette ?? SESSION_COLORS[0];
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

const SESSION_COLORS = [
  {
    strong: "#047857",
    border: "#a7f3d0",
    userBackground: "#ecfdf5",
    agentBackground: "#eff6ff",
  },
  {
    strong: "#4f46e5",
    border: "#c7d2fe",
    userBackground: "#eef2ff",
    agentBackground: "#f5f3ff",
  },
  {
    strong: "#be123c",
    border: "#fecdd3",
    userBackground: "#fff1f2",
    agentBackground: "#fff7ed",
  },
  {
    strong: "#0e7490",
    border: "#a5f3fc",
    userBackground: "#ecfeff",
    agentBackground: "#f0fdfa",
  },
  {
    strong: "#a16207",
    border: "#fde68a",
    userBackground: "#fefce8",
    agentBackground: "#fff7ed",
  },
  {
    strong: "#7c3aed",
    border: "#ddd6fe",
    userBackground: "#f5f3ff",
    agentBackground: "#fdf2f8",
  },
] as const;

function projectNameFromPath(projectPath: string) {
  const clean = projectPath.replace(/\/$/, "");
  return clean.split("/").pop() || "Unknown project";
}
