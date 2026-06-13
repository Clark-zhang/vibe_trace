const state = {
  traces: [],
  selectedTraceId: null,
  selectedTrace: null,
  selectedProjectKey: null,
  openProjects: new Set(),
  availableSources: [],
  mainView: "projects",
  projectMetric: "tokens",
  projectSort: "latest",
  projectVisibleCount: 12,
  projectReplayCache: new Map(),
  projectPreviewTimers: new Map(),
  projectGridObserver: null,
  projectReplayFrameIndex: 0,
  projectReplayPlaying: false,
  projectReplayPausedByScroll: false,
  projectReplaySpeed: 1,
  projectReplayTimer: null,
  query: "",
  source: "all",
  workspace: "",
};

const PROJECT_PAGE_SIZE = 12;
const PROJECT_PAGE_INCREMENT = 9;
const PROJECT_PREVIEW_TURN_LIMIT = 10;

const elements = {
  status: document.querySelector("[data-testid='store-status']"),
  list: document.querySelector("[data-testid='trace-list']"),
  detail: document.querySelector("[data-testid='trace-detail']"),
  homeRefresh: document.querySelector("[data-home-refresh]"),
  search: document.querySelector("[data-testid='trace-search']"),
  source: document.querySelector("[data-testid='source-filter']"),
  workspace: document.querySelector("[data-testid='workspace-filter']"),
};

elements.homeRefresh.addEventListener("click", refreshHome);

elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  resetProjectGridState();
  loadTraces();
});

elements.source.addEventListener("change", () => {
  state.source = elements.source.value;
  resetProjectGridState();
  loadTraces();
});

elements.workspace.addEventListener("input", () => {
  state.workspace = elements.workspace.value;
  resetProjectGridState();
  loadTraces();
});

await initialize();

async function initialize() {
  const health = await fetchJson("/api/health");
  elements.status.textContent = health.ok ? "Local" : "Offline";
  await loadTraces();
}

async function loadTraces() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.source && state.source !== "all") params.set("source", state.source);
  if (state.workspace) params.set("workspace", state.workspace);

  const data = await fetchJson(`/api/traces?${params.toString()}`);
  state.traces = data.traces;

  if (state.availableSources.length === 0) {
    state.availableSources = Array.from(new Set(data.traces.map((trace) => trace.source))).sort();
  }

  renderSourceFilter();

  if (state.selectedTraceId && !state.traces.some((trace) => trace.trace_id === state.selectedTraceId)) {
    state.selectedTraceId = null;
    state.selectedTrace = null;
    state.mainView = "projects";
  }

  if (state.selectedProjectKey && !groupTracesByProject(state.traces).some((group) => group.key === state.selectedProjectKey)) {
    state.selectedProjectKey = null;
    if (state.mainView === "project") {
      state.mainView = "projects";
    }
  }

  renderTraceList();

  if (state.mainView === "messages") {
    await renderUserMessagesPage();
  } else if (state.mainView === "project" && state.selectedProjectKey) {
    const group = groupTracesByProject(state.traces).find((candidate) => candidate.key === state.selectedProjectKey);
    if (group) {
      await renderProjectFocus(group);
    } else {
      state.mainView = "projects";
      renderProjectOverview();
    }
  } else if (state.mainView === "projects" || !state.selectedTraceId) {
    state.mainView = "projects";
    renderProjectOverview();
  }
}

function renderSourceFilter() {
  const sources = state.availableSources;
  const current = elements.source.value;
  elements.source.innerHTML = [
    `<option value="all">All</option>`,
    ...sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`),
  ].join("");
  elements.source.value = sources.includes(current) ? current : "all";
}

function renderProjectOverview() {
  stopProjectReplay();
  clearProjectPreviewTimers();
  disconnectProjectGridObserver();

  if (state.traces.length === 0) {
    renderEmptyState();
    return;
  }

  const groups = sortProjectGroups(groupTracesByProject(state.traces));
  const visibleGroups = groups.slice(0, state.projectVisibleCount);
  const totalMessages = groups.reduce((sum, group) => sum + group.message_count, 0);
  const totalTokens = groups.reduce((sum, group) => sum + group.token_count, 0);

  elements.detail.innerHTML = `
    <section class="project-overview project-home" aria-label="Project replay home">
      <div class="project-overview-header">
        <div>
          <p class="eyebrow">Replay Home</p>
          <h2>Project Replays</h2>
          <p>${groups.length} projects · ${formatCompactNumber(totalMessages)} messages · ${formatCompactNumber(totalTokens)} tokens</p>
        </div>
        <div class="overview-actions">
          <label class="project-sort-control">
            <span>Sort</span>
            ${renderProjectSortSelect()}
          </label>
          <button class="view-button" type="button" data-user-messages>User Messages</button>
        </div>
      </div>
      <div class="project-video-grid">
        ${visibleGroups.map(renderProjectVideoCard).join("")}
      </div>
      ${
        visibleGroups.length < groups.length
          ? `<div class="project-load-sentinel" data-project-grid-sentinel>Loading more projects</div>`
          : `<p class="empty-line project-grid-end">${groups.length} projects loaded</p>`
      }
    </section>
  `;

  wireProjectSortControls();
  wireUserMessagesButtons();
  wireProjectVideoCards(visibleGroups);
  wireProjectGridInfiniteScroll(groups.length);
  loadProjectPreviewReplays(visibleGroups);
}

function renderProjectVideoCard(group) {
  const sourceLabel = group.source_summary || "unknown";
  const title = `${group.name} · ${formatCompactNumber(group.message_count)} messages · ${formatCompactNumber(group.token_count)} tokens`;

  return `
    <article class="project-video-card" data-project-card-key="${escapeHtml(group.key)}" title="${escapeHtml(title)}">
      <div class="project-preview-window" data-project-preview-window>
        <div class="project-preview-feed" data-project-preview-feed data-project-preview-key="${escapeHtml(group.key)}">
          ${emptyLine("Loading replay")}
        </div>
        <div class="project-preview-controls">
          <button type="button" data-preview-play disabled>Play</button>
          <button type="button" data-preview-fullscreen>Fullscreen</button>
        </div>
      </div>
      <div class="project-video-meta">
        <button type="button" data-project-open="${escapeHtml(group.key)}">
          <strong>${formatProjectName(group.name)}</strong>
        </button>
        <p>${formatCompactNumber(group.message_count)} messages · ${formatCompactNumber(group.token_count)} tokens</p>
        <span>${escapeHtml(sourceLabel)}</span>
      </div>
    </article>
  `;
}

function renderProjectTile(group, maxValue) {
  const metricValue = projectMetricValue(group);
  const span = projectTileSpan(metricValue, maxValue);
  const tileSize = span * 96 + (span - 1) * 12;
  const sourceLabel = group.source_summary || "unknown";
  const title = `${group.name} · ${formatCompactNumber(group.message_count)} messages · ${formatCompactNumber(group.token_count)} tokens`;

  return `
    <button
      class="project-tile project-tile-${span}"
      style="--tile-size:${tileSize}px"
      data-project-key="${escapeHtml(group.key)}"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
    >
      <strong>${formatProjectName(group.name)}</strong>
      <span>${formatCompactNumber(group.message_count)} messages</span>
      <span>${formatCompactNumber(group.token_count)} tokens</span>
      <small>${escapeHtml(sourceLabel)}</small>
    </button>
  `;
}

function wireProjectVideoCards(groups) {
  const groupByKey = new Map(groups.map((group) => [group.key, group]));

  for (const button of elements.detail.querySelectorAll("[data-project-open]")) {
    button.addEventListener("click", () => openProject(button.dataset.projectOpen));
  }

  for (const button of elements.detail.querySelectorAll("[data-preview-fullscreen]")) {
    button.addEventListener("click", async () => {
      const card = button.closest("[data-project-card-key]");
      const target = card?.querySelector("[data-project-preview-window]");

      if (target?.requestFullscreen) {
        await target.requestFullscreen();
      }
    });
  }

  for (const button of elements.detail.querySelectorAll("[data-preview-play]")) {
    button.addEventListener("click", async () => {
      const card = button.closest("[data-project-card-key]");
      const group = card ? groupByKey.get(card.dataset.projectCardKey) : null;

      if (!card || !group) {
        return;
      }

      const replay = await fetchProjectReplay(group, PROJECT_PREVIEW_TURN_LIMIT);
      toggleProjectPreview(card, replay);
    });
  }
}

function wireProjectGridInfiniteScroll(totalCount) {
  const sentinel = elements.detail.querySelector("[data-project-grid-sentinel]");
  if (!sentinel || state.projectVisibleCount >= totalCount) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    sentinel.addEventListener("click", () => {
      state.projectVisibleCount = Math.min(totalCount, state.projectVisibleCount + PROJECT_PAGE_INCREMENT);
      renderProjectOverview();
    });
    return;
  }

  state.projectGridObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      disconnectProjectGridObserver();
      state.projectVisibleCount = Math.min(totalCount, state.projectVisibleCount + PROJECT_PAGE_INCREMENT);
      renderProjectOverview();
    },
    {
      rootMargin: "560px 0px",
    },
  );
  state.projectGridObserver.observe(sentinel);
}

async function loadProjectPreviewReplays(groups) {
  await Promise.all(
    groups.map(async (group) => {
      const card = elements.detail.querySelector(`[data-project-card-key="${cssEscape(group.key)}"]`);
      if (!card) {
        return;
      }

      try {
        const replay = await fetchProjectReplay(group, PROJECT_PREVIEW_TURN_LIMIT);
        const currentCard = elements.detail.querySelector(`[data-project-card-key="${cssEscape(group.key)}"]`);

        if (state.mainView !== "projects" || !currentCard) {
          return;
        }

        renderProjectPreview(currentCard, replay);
      } catch (error) {
        const feed = card.querySelector("[data-project-preview-feed]");
        if (feed) {
          feed.innerHTML = emptyLine("Replay unavailable");
        }
      }
    }),
  );
}

async function fetchProjectReplay(group, limit) {
  const cacheKey = projectReplayCacheKey(group.key, limit);
  const cached = state.projectReplayCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = fetchJson(`/api/projects/replay?${buildFilterParams({ limit, workspace: group.key }).toString()}`)
    .catch((error) => {
      state.projectReplayCache.delete(cacheKey);
      throw error;
    });
  state.projectReplayCache.set(cacheKey, promise);
  const replay = await promise;
  state.projectReplayCache.set(cacheKey, replay);
  return replay;
}

function renderProjectPreview(card, replay) {
  const frames = projectReplayFrames(replay);
  const feed = card.querySelector("[data-project-preview-feed]");
  const playButton = card.querySelector("[data-preview-play]");

  if (!feed || !playButton) {
    return;
  }

  const frameIndex = normalizeReplayFrameIndex(Number(card.dataset.previewFrameIndex ?? 0), frames.length);
  card.dataset.previewFrameIndex = String(frameIndex);
  feed.innerHTML = frames.length ? renderProjectPreviewFeed(frames, frameIndex) : emptyLine("No replay");
  playButton.disabled = frames.length === 0;
  playButton.textContent = card.dataset.previewPlaying === "true" ? "Pause" : "Play";
  wireProjectPreviewScroll(card, replay);
  wireTraceDetailButtons(feed);
}

function renderProjectPreviewFeed(frames, frameIndex) {
  return frames
    .slice(0, frameIndex + 1)
    .map((frame, index) => renderProjectPreviewMessage(frame, index, frames.length))
    .join("");
}

function renderProjectPreviewMessage(frame, frameIndex, frameCount) {
  const turn = frame.turn;
  const user = turn.user;
  const agent = turn.agent;
  const isAgent = frame.kind === "agent";
  const content = isAgent ? agent.content || "Agent activity" : user.content || "";

  return `
    <article class="replay-message-row replay-message-row-${frame.kind}">
      <div class="replay-bubble replay-bubble-${frame.kind}">
        <header>
          <strong>${isAgent ? "Agent" : "User"}</strong>
          <span>${frameIndex + 1}/${frameCount}</span>
        </header>
        <p>${escapeHtml(content)}${isAgent && agent.is_truncated ? "..." : ""}${!isAgent && user.is_truncated ? "..." : ""}</p>
        ${
          isAgent
            ? `<div class="replay-metrics">${renderReplayMetric("tools", agent.tool_call_count)}${agent.file_change_count ? renderReplayMetric("files", agent.file_change_count) : ""}</div>`
            : ""
        }
      </div>
    </article>
  `;
}

function toggleProjectPreview(card, replay) {
  if (card.dataset.previewPlaying === "true") {
    stopProjectPreview(card);
    renderProjectPreview(card, replay);
    return;
  }

  const frames = projectReplayFrames(replay);
  const currentIndex = normalizeReplayFrameIndex(Number(card.dataset.previewFrameIndex ?? 0), frames.length);
  if (currentIndex >= frames.length - 1) {
    card.dataset.previewFrameIndex = "0";
  }

  card.dataset.previewPlaying = "true";
  card.dataset.previewPausedByScroll = "false";
  renderProjectPreview(card, replay);
  scrollProjectPreviewToLatest(card);
  scheduleProjectPreviewAdvance(card, replay);
}

function scheduleProjectPreviewAdvance(card, replay) {
  const key = card.dataset.projectCardKey;
  const frames = projectReplayFrames(replay);
  clearProjectPreviewTimer(key);

  if (card.dataset.previewPlaying !== "true") {
    return;
  }

  const currentIndex = normalizeReplayFrameIndex(Number(card.dataset.previewFrameIndex ?? 0), frames.length);
  if (currentIndex >= frames.length - 1) {
    card.dataset.previewPlaying = "false";
    renderProjectPreview(card, replay);
    return;
  }

  const timer = window.setTimeout(() => {
    card.dataset.previewFrameIndex = String(currentIndex + 1);
    renderProjectPreview(card, replay);
    scrollProjectPreviewToLatest(card);
    scheduleProjectPreviewAdvance(card, replay);
  }, Math.max(180, Math.round(projectReplayFrameDuration(frames[currentIndex]) * 0.78)));

  state.projectPreviewTimers.set(key, timer);
}

function wireProjectPreviewScroll(card, replay) {
  const feed = card.querySelector("[data-project-preview-feed]");
  if (!feed || feed.dataset.previewScrollWired === "true") {
    return;
  }

  feed.dataset.previewScrollWired = "true";
  feed.addEventListener("scroll", () => {
    if (feed.dataset.suppressScrollHandling === "true") {
      return;
    }

    const atLatest = isReplayFeedAtLatest(feed);

    if (!atLatest && card.dataset.previewPlaying === "true") {
      card.dataset.previewPlaying = "false";
      card.dataset.previewPausedByScroll = "true";
      clearProjectPreviewTimer(card.dataset.projectCardKey);
      renderProjectPreview(card, replay);
      return;
    }

    if (atLatest && card.dataset.previewPausedByScroll === "true") {
      card.dataset.previewPlaying = "true";
      card.dataset.previewPausedByScroll = "false";
      renderProjectPreview(card, replay);
      scheduleProjectPreviewAdvance(card, replay);
    }
  });
}

function scrollProjectPreviewToLatest(card) {
  const feed = card.querySelector("[data-project-preview-feed]");
  if (!feed) {
    return;
  }

  feed.dataset.suppressScrollHandling = "true";
  feed.scrollTop = feed.scrollHeight;
  window.requestAnimationFrame(() => {
    feed.dataset.suppressScrollHandling = "false";
  });
}

function stopProjectPreview(card) {
  card.dataset.previewPlaying = "false";
  card.dataset.previewPausedByScroll = "false";
  clearProjectPreviewTimer(card.dataset.projectCardKey);
}

function clearProjectPreviewTimer(key) {
  const timer = state.projectPreviewTimers.get(key);
  if (timer) {
    window.clearTimeout(timer);
    state.projectPreviewTimers.delete(key);
  }
}

function clearProjectPreviewTimers() {
  for (const timer of state.projectPreviewTimers.values()) {
    window.clearTimeout(timer);
  }

  state.projectPreviewTimers.clear();
}

function projectReplayCacheKey(projectKey, limit) {
  return [state.query, state.source, state.workspace, projectKey, limit].join("|");
}

function resetProjectGridState() {
  state.projectVisibleCount = PROJECT_PAGE_SIZE;
  state.projectReplayCache.clear();
  clearProjectPreviewTimers();
  disconnectProjectGridObserver();
}

function disconnectProjectGridObserver() {
  if (state.projectGridObserver) {
    state.projectGridObserver.disconnect();
    state.projectGridObserver = null;
  }
}

async function renderUserMessagesPage() {
  stopProjectReplay();
  clearProjectPreviewTimers();
  state.mainView = "messages";
  state.selectedTraceId = null;
  state.selectedTrace = null;
  state.selectedProjectKey = null;
  renderTraceList();

  elements.detail.innerHTML = `
    <section class="user-message-page" aria-label="User messages">
      <div class="user-message-header">
        <div>
          <p class="eyebrow">User Messages</p>
          <h2>User Messages</h2>
          <p>Loading message patterns...</p>
        </div>
        <button class="view-button" type="button" data-project-overview>Projects</button>
      </div>
    </section>
  `;
  wireProjectOverviewButton();

  const data = await fetchJson(`/api/user-messages?${buildFilterParams({ limit: 1000 }).toString()}`);
  renderUserMessagesResult(data);
}

function renderUserMessagesResult(data) {
  const analysis = data.analysis;
  const messages = data.messages;

  elements.detail.innerHTML = `
    <section class="user-message-page" aria-label="User messages">
      <div class="user-message-header">
        <div>
          <p class="eyebrow">User Messages</p>
          <h2>User Messages</h2>
          <p>${analysis.total_messages} messages · ${analysis.project_count} projects</p>
        </div>
        <button class="view-button" type="button" data-project-overview>Projects</button>
      </div>

      <div class="insight-grid" aria-label="User message stats">
        ${insightItem("Messages", formatCompactNumber(analysis.total_messages))}
        ${insightItem("Avg length", `${formatCompactNumber(analysis.average_characters)} chars`)}
        ${insightItem("Tokens", formatCompactNumber(analysis.estimated_token_count))}
        ${insightItem("Shown", `${formatCompactNumber(analysis.shown_messages)} latest`)}
      </div>

      <section class="message-analysis-grid" aria-label="User message analysis">
        <div>
          <div class="section-heading">
            <h3>Intent Mix</h3>
            <span>${analysis.intent_counts.length}</span>
          </div>
          <div class="intent-list">
            ${analysis.intent_counts.length ? analysis.intent_counts.map((item) => renderIntentRow(item, analysis.total_messages)).join("") : emptyLine("No intent signals")}
          </div>
        </div>
        <div>
          <div class="section-heading">
            <h3>Common Terms</h3>
            <span>${analysis.top_terms.length}</span>
          </div>
          <div class="term-cloud">
            ${analysis.top_terms.length ? analysis.top_terms.map(renderTerm).join("") : emptyLine("No repeated terms")}
          </div>
        </div>
        <div>
          <div class="section-heading">
            <h3>Active Projects</h3>
            <span>${analysis.top_projects.length}</span>
          </div>
          <div class="intent-list">
            ${analysis.top_projects.length ? analysis.top_projects.map((item) => renderProjectMessageRow(item, analysis.total_messages)).join("") : emptyLine("No projects")}
          </div>
        </div>
      </section>

      <section class="detail-section">
        <div class="section-heading">
          <h3>Message List</h3>
          <span>${analysis.shown_messages} of ${analysis.total_messages}</span>
        </div>
        <div class="user-message-list">
          ${messages.length ? messages.map(renderUserMessageItem).join("") : emptyLine("No user messages")}
        </div>
      </section>
    </section>
  `;

  wireProjectOverviewButton();
  wireTraceDetailButtons(elements.detail);
}

async function openProject(projectKey) {
  if (!projectKey) return;

  const groups = groupTracesByProject(state.traces);
  const group = groups.find((candidate) => candidate.key === projectKey);

  if (!group) return;

  clearProjectPreviewTimers();
  resetProjectReplay();
  state.mainView = "project";
  state.selectedProjectKey = projectKey;
  state.selectedTraceId = null;
  state.selectedTrace = null;
  renderTraceList();
  await renderProjectFocus(group);
}

async function renderProjectFocus(group) {
  const stats = projectStats(group);

  elements.detail.innerHTML = `
    <section class="project-focus project-watch-page" aria-label="Project">
      <div class="project-overview-header">
        <div>
          <p class="eyebrow">Project</p>
          <h2>${escapeHtml(group.name)}</h2>
          <p>${escapeHtml(group.key)}</p>
        </div>
        <div class="overview-actions">
          <button class="view-button" type="button" data-user-messages>User Messages</button>
          <button class="view-button" type="button" data-project-overview>Projects</button>
        </div>
      </div>
      <div class="insight-grid" aria-label="Project stats">
        ${insightItem("Messages", formatCompactNumber(stats.message_count))}
        ${insightItem("Tokens", formatCompactNumber(stats.token_count))}
        ${insightItem("Tools", formatCompactNumber(stats.tool_call_count))}
        ${insightItem("Files", formatCompactNumber(stats.file_change_count))}
      </div>
      <section class="detail-section">
        <div class="section-heading">
          <h3>Watch</h3>
          <span>Loading</span>
        </div>
        ${emptyLine("Loading project replay")}
      </section>
    </section>
  `;
  wireProjectOverviewButton();
  wireUserMessagesButtons();

  const [messageData, replayData] = await Promise.all([
    fetchJson(`/api/user-messages?${buildFilterParams({ limit: 80, workspace: group.key }).toString()}`),
    fetchJson(`/api/projects/replay?${buildFilterParams({ limit: 80, workspace: group.key }).toString()}`),
  ]);

  if (state.mainView !== "project" || state.selectedProjectKey !== group.key) {
    return;
  }

  renderProjectFocusResult(group, messageData, replayData);
}

function renderProjectFocusResult(group, data, replay) {
  const stats = projectStats(group);
  const frames = projectReplayFrames(replay);

  elements.detail.innerHTML = `
    <section class="project-focus project-watch-page" aria-label="Project watch">
      <div class="project-overview-header">
        <div>
          <p class="eyebrow">Project Watch</p>
          <h2>${escapeHtml(group.name)}</h2>
          <p>${escapeHtml(group.key)}</p>
        </div>
        <div class="overview-actions">
          <button class="view-button" type="button" data-user-messages>User Messages</button>
          <button class="view-button" type="button" data-project-overview>Projects</button>
        </div>
      </div>

      <div class="insight-grid" aria-label="Project stats">
        ${insightItem("Replay Turns", formatCompactNumber(replay.stats.turn_count))}
        ${insightItem("User Messages", formatCompactNumber(data.analysis.total_messages))}
        ${insightItem("Tools", formatCompactNumber(stats.tool_call_count))}
        ${insightItem("Files", formatCompactNumber(stats.file_change_count))}
      </div>

      <div class="project-watch-layout">
        <div class="project-watch-player">
          ${renderProjectReplay(replay)}
        </div>
        <aside class="project-transcript" aria-label="Project transcript">
          <div class="section-heading">
            <h3>Messages</h3>
            <span>${frames.length}</span>
          </div>
          <div class="project-transcript-list">
            ${frames.length ? frames.map(renderProjectTranscriptItem).join("") : emptyLine("No messages")}
          </div>
        </aside>
      </div>
    </section>
  `;

  wireProjectOverviewButton();
  wireUserMessagesButtons();
  wireTraceDetailButtons(elements.detail);
  wireProjectReplay(replay);
  wireProjectTranscript();
}

function renderProjectTranscriptItem(frame, index) {
  const turn = frame.turn;
  const isAgent = frame.kind === "agent";
  const user = turn.user;
  const agent = turn.agent;
  const createdAt = isAgent ? agent.created_at : user.created_at;
  const content = isAgent ? agent.content || "Agent activity" : user.content || "";

  return `
    <button class="transcript-item transcript-item-${frame.kind}" type="button" data-replay-jump="${index}">
      <span>
        <strong>${isAgent ? "Agent" : "User"}</strong>
        ${createdAt ? `<time>${formatTime(createdAt)}</time>` : ""}
      </span>
      <p>${escapeHtml(content)}${isAgent && agent.is_truncated ? "..." : ""}${!isAgent && user.is_truncated ? "..." : ""}</p>
      ${
        isAgent
          ? `<small>${agent.tool_call_count} tools${agent.file_change_count ? ` · ${agent.file_change_count} files` : ""}</small>`
          : `<small>${formatCompactNumber(user.estimated_token_count)} tokens</small>`
      }
    </button>
  `;
}

function renderProjectReplay(replay) {
  const turns = Array.isArray(replay.turns) ? replay.turns : [];
  const stats = replay.stats ?? { turn_count: turns.length, shown_turn_count: turns.length };
  const frames = projectReplayFrames(replay);
  const frameIndex = normalizeReplayFrameIndex(state.projectReplayFrameIndex, frames.length);
  state.projectReplayFrameIndex = frameIndex;

  return `
    <section class="detail-section project-replay-section" id="project-replay">
      <div class="section-heading">
        <h3>Replay</h3>
        <span data-replay-heading-status>${frames.length ? replayFrameStatus(frames[frameIndex], frameIndex, frames.length) : `${stats.shown_turn_count} of ${stats.turn_count}`}</span>
      </div>
      ${
        frames.length
          ? `
            <div class="replay-player" data-replay-player>
              <div class="replay-feed" data-replay-feed aria-live="polite">
                ${renderProjectReplayFeed(frames, frameIndex)}
              </div>
              <div class="replay-controls">
                <div class="replay-buttons">
                  <button type="button" data-replay-action="prev">Prev</button>
                  <button type="button" data-replay-action="play" aria-pressed="${state.projectReplayPlaying}">${state.projectReplayPlaying ? "Pause" : "Play"}</button>
                  <button type="button" data-replay-action="next">Next</button>
                </div>
                <label class="replay-scrubber">
                  <span data-replay-status>${escapeHtml(replayFrameStatus(frames[frameIndex], frameIndex, frames.length))}</span>
                  <input type="range" min="0" max="${frames.length - 1}" value="${frameIndex}" step="1" data-replay-scrubber />
                </label>
                <label class="replay-speed">
                  <span>Speed</span>
                  <select data-replay-speed>
                    ${renderReplaySpeedOption(0.75)}
                    ${renderReplaySpeedOption(1)}
                    ${renderReplaySpeedOption(1.5)}
                    ${renderReplaySpeedOption(2)}
                  </select>
                </label>
              </div>
            </div>
          `
          : emptyLine("No replay turns")
      }
    </section>
  `;
}

function renderProjectReplayFeed(frames, frameIndex) {
  return frames
    .slice(0, frameIndex + 1)
    .map((frame, index) => renderProjectReplayMessage(frame, index, frames.length))
    .join("");
}

function renderProjectReplayMessage(frame, frameIndex, frameCount) {
  const turn = frame.turn;
  const user = turn.user;
  const agent = turn.agent;
  const isAgent = frame.kind === "agent";
  const speaker = isAgent ? "Agent" : "User";
  const createdAt = isAgent ? agent.created_at : user.created_at;
  const userImages = Array.isArray(user.images) ? user.images : [];
  const agentContent = agent.content || "";
  const toolTypes = Array.isArray(agent.tool_call_types) ? agent.tool_call_types : [];

  return `
    <article class="replay-message-row replay-message-row-${frame.kind}" data-replay-message>
      <div class="replay-bubble replay-bubble-${frame.kind}">
        <header>
          <strong>${speaker}</strong>
          <span>
            ${createdAt ? `<time>${formatTime(createdAt)}</time>` : ""}
            <button type="button" data-message-trace="${escapeHtml(turn.trace_id)}">Details</button>
          </span>
        </header>
        ${
          isAgent
            ? `
              ${agentContent ? `<p>${escapeHtml(agentContent)}${agent.is_truncated ? "..." : ""}</p>` : `<p class="replay-muted">Agent activity</p>`}
              <div class="replay-metrics" aria-label="Agent activity summary">
                ${renderReplayMetric("replies", agent.message_count)}
                ${renderReplayMetric("tools", agent.tool_call_count)}
                ${agent.file_change_count ? renderReplayMetric("files", agent.file_change_count) : ""}
                ${agent.checkpoint_count ? renderReplayMetric("checkpoints", agent.checkpoint_count) : ""}
              </div>
              ${
                toolTypes.length
                  ? `<div class="replay-tool-types">${toolTypes.map(renderReplayToolType).join("")}</div>`
                  : ""
              }
            `
            : `
              ${user.content ? `<p>${escapeHtml(user.content)}${user.is_truncated ? "..." : ""}</p>` : ""}
              ${userImages.length ? `<div class="user-message-images replay-images">${userImages.map(renderUserMessageImage).join("")}</div>` : ""}
              <footer>
                <span>${formatCompactNumber(user.character_count)} chars</span>
                <span>${formatCompactNumber(user.estimated_token_count)} tokens</span>
                ${userImages.length ? `<span>${userImages.length} ${pluralize("image", userImages.length)}</span>` : ""}
              </footer>
            `
        }
      </div>
    </article>
  `;
}

function renderReplaySpeedOption(value) {
  return `<option value="${value}" ${state.projectReplaySpeed === value ? "selected" : ""}>${value}x</option>`;
}

function projectReplayFrames(replay) {
  const turns = Array.isArray(replay.turns) ? replay.turns : [];
  return turns.flatMap((turn, turnIndex) => [
    { kind: "user", turn, turnIndex },
    { kind: "agent", turn, turnIndex },
  ]);
}

function replayFrameStatus(frame, frameIndex, frameCount) {
  if (!frame) {
    return "0 / 0";
  }

  const speaker = frame.kind === "user" ? "User" : "Agent";
  return `${frameIndex + 1} / ${frameCount} · Turn ${frame.turnIndex + 1} · ${speaker}`;
}

function normalizeReplayFrameIndex(index, frameCount) {
  if (frameCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(frameCount - 1, Number.isFinite(index) ? Math.round(index) : 0));
}

function wireProjectReplay(replay) {
  const player = elements.detail.querySelector("[data-replay-player]");
  if (!player) {
    return;
  }

  const frames = projectReplayFrames(replay);
  if (frames.length === 0) {
    return;
  }

  const feed = player.querySelector("[data-replay-feed]");
  const status = player.querySelector("[data-replay-status]");
  const headingStatus = elements.detail.querySelector("[data-replay-heading-status]");
  const scrubber = player.querySelector("[data-replay-scrubber]");
  const playButton = player.querySelector("[data-replay-action='play']");
  const speedSelect = player.querySelector("[data-replay-speed]");
  let suppressScrollHandling = false;

  const updateChrome = () => {
    const frameIndex = normalizeReplayFrameIndex(state.projectReplayFrameIndex, frames.length);
    const frame = frames[frameIndex];

    scrubber.value = String(frameIndex);
    status.textContent = replayFrameStatus(frame, frameIndex, frames.length);
    headingStatus.textContent = replayFrameStatus(frame, frameIndex, frames.length);
    playButton.textContent = state.projectReplayPlaying ? "Pause" : "Play";
    playButton.setAttribute("aria-pressed", String(state.projectReplayPlaying));
  };

  const scrollToLatest = () => {
    suppressScrollHandling = true;
    feed.scrollTop = feed.scrollHeight;
    window.requestAnimationFrame(() => {
      suppressScrollHandling = false;
    });
  };

  const renderCurrentFrame = ({ scrollLatest = false } = {}) => {
    const frameIndex = normalizeReplayFrameIndex(state.projectReplayFrameIndex, frames.length);
    state.projectReplayFrameIndex = frameIndex;

    feed.innerHTML = renderProjectReplayFeed(frames, frameIndex);
    updateChrome();
    wireTraceDetailButtons(feed);

    if (scrollLatest) {
      scrollToLatest();
    }
  };

  const goToFrame = (index) => {
    clearProjectReplayTimer();
    state.projectReplayPausedByScroll = false;
    state.projectReplayFrameIndex = normalizeReplayFrameIndex(index, frames.length);
    renderCurrentFrame({ scrollLatest: true });

    if (state.projectReplayPlaying) {
      scheduleProjectReplayAdvance(frames, renderCurrentFrame);
    }
  };

  for (const button of player.querySelectorAll("[data-replay-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.replayAction;

      if (action === "prev") {
        goToFrame(state.projectReplayFrameIndex - 1);
      } else if (action === "next") {
        goToFrame(state.projectReplayFrameIndex + 1);
      } else if (action === "play") {
        toggleProjectReplay(frames, renderCurrentFrame);
      }
    });
  }

  scrubber.addEventListener("input", () => {
    goToFrame(Number(scrubber.value));
  });

  feed.addEventListener("scroll", () => {
    if (suppressScrollHandling) {
      return;
    }

    const atLatest = isReplayFeedAtLatest(feed);

    if (!atLatest && state.projectReplayPlaying) {
      state.projectReplayPlaying = false;
      state.projectReplayPausedByScroll = true;
      clearProjectReplayTimer();
      updateChrome();
      return;
    }

    if (
      atLatest &&
      state.projectReplayPausedByScroll &&
      state.projectReplayFrameIndex < frames.length - 1
    ) {
      state.projectReplayPausedByScroll = false;
      state.projectReplayPlaying = true;
      updateChrome();
      scheduleProjectReplayAdvance(frames, renderCurrentFrame);
    }
  });

  speedSelect.addEventListener("change", () => {
    state.projectReplaySpeed = Number(speedSelect.value) || 1;

    if (state.projectReplayPlaying) {
      scheduleProjectReplayAdvance(frames, renderCurrentFrame);
    }
  });

  renderCurrentFrame({ scrollLatest: true });

  if (state.projectReplayPlaying) {
    scheduleProjectReplayAdvance(frames, renderCurrentFrame);
  }
}

function wireProjectTranscript() {
  const scrubber = elements.detail.querySelector("[data-replay-scrubber]");
  if (!scrubber) {
    return;
  }

  for (const button of elements.detail.querySelectorAll("[data-replay-jump]")) {
    button.addEventListener("click", () => {
      stopProjectReplay();
      scrubber.value = button.dataset.replayJump;
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      elements.detail.querySelector("[data-replay-player]")?.scrollIntoView({ block: "start" });
    });
  }
}

function toggleProjectReplay(frames, renderCurrentFrame) {
  if (state.projectReplayPlaying) {
    state.projectReplayPlaying = false;
    state.projectReplayPausedByScroll = false;
    clearProjectReplayTimer();
    renderCurrentFrame();
    return;
  }

  if (state.projectReplayFrameIndex >= frames.length - 1) {
    state.projectReplayFrameIndex = 0;
  }

  state.projectReplayPlaying = true;
  state.projectReplayPausedByScroll = false;
  renderCurrentFrame({ scrollLatest: true });
  scheduleProjectReplayAdvance(frames, renderCurrentFrame);
}

function scheduleProjectReplayAdvance(frames, renderCurrentFrame) {
  clearProjectReplayTimer();

  if (!state.projectReplayPlaying) {
    return;
  }

  if (state.projectReplayFrameIndex >= frames.length - 1) {
    state.projectReplayPlaying = false;
    renderCurrentFrame();
    return;
  }

  const frame = frames[state.projectReplayFrameIndex];
  state.projectReplayTimer = window.setTimeout(() => {
    state.projectReplayFrameIndex = normalizeReplayFrameIndex(state.projectReplayFrameIndex + 1, frames.length);
    renderCurrentFrame({ scrollLatest: true });
    scheduleProjectReplayAdvance(frames, renderCurrentFrame);
  }, projectReplayFrameDuration(frame));
}

function projectReplayFrameDuration(frame) {
  const text =
    frame.kind === "user"
      ? frame.turn.user.content
      : `${frame.turn.agent.content} ${frame.turn.agent.tool_call_count} ${frame.turn.agent.file_change_count}`;
  const base = frame.kind === "user" ? 360 : 620;
  const lengthDelay = Math.min(900, Array.from(text || "").length * 4);
  return Math.max(220, Math.round((base + lengthDelay) / state.projectReplaySpeed));
}

function isReplayFeedAtLatest(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 28;
}

function clearProjectReplayTimer() {
  if (state.projectReplayTimer) {
    window.clearTimeout(state.projectReplayTimer);
    state.projectReplayTimer = null;
  }
}

function stopProjectReplay() {
  state.projectReplayPlaying = false;
  state.projectReplayPausedByScroll = false;
  clearProjectReplayTimer();
}

function resetProjectReplay() {
  stopProjectReplay();
  state.projectReplayFrameIndex = 0;
}

function renderReplayMetric(label, value) {
  return `<span><strong>${formatCompactNumber(value)}</strong> ${escapeHtml(label)}</span>`;
}

function renderReplayToolType(toolType) {
  return `<span>${escapeHtml(toolType.name)} <strong>${formatCompactNumber(toolType.count)}</strong></span>`;
}

function renderTraceList() {
  elements.list.innerHTML = "";
}

function renderProjectSortSelect() {
  return `
    <select data-project-sort aria-label="Project sort">
      <option value="latest" ${state.projectSort === "latest" ? "selected" : ""}>Recent</option>
      <option value="name" ${state.projectSort === "name" ? "selected" : ""}>A-Z</option>
      <option value="sessions" ${state.projectSort === "sessions" ? "selected" : ""}>Sessions</option>
    </select>
  `;
}

function renderRailPrimaryNav() {
  return `
    <nav class="rail-primary-nav" aria-label="Primary views">
      <button type="button" data-rail-view="projects" class="${state.mainView === "projects" || state.mainView === "project" ? "is-active" : ""}">
        <strong>Projects</strong>
        <span>Map</span>
      </button>
      <button type="button" data-rail-view="messages" class="${state.mainView === "messages" ? "is-active" : ""}">
        <strong>User Messages</strong>
        <span>Patterns</span>
      </button>
    </nav>
  `;
}

function renderProjectNavItem(group, selected) {
  return `
    <button class="project-nav-item ${selected ? "is-selected" : ""}" type="button" data-project-key="${escapeHtml(group.key)}">
      <span>
        <strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</strong>
        <small>${group.traces.length} sessions · ${formatCompactNumber(group.message_count)} messages</small>
      </span>
      <em>${escapeHtml(group.source_summary || "unknown")}</em>
    </button>
  `;
}

function wireRailPrimaryNav() {
  for (const button of elements.list.querySelectorAll("[data-rail-view]")) {
    button.addEventListener("click", () => {
      if (button.dataset.railView === "messages") {
        renderUserMessagesPage();
      } else {
        showProjectOverview();
      }
    });
  }
}

function wireProjectSortControls() {
  for (const select of document.querySelectorAll("[data-project-sort]")) {
    select.value = state.projectSort;
    select.onchange = () => {
      state.projectSort = normalizeProjectSort(select.value);
      state.projectVisibleCount = PROJECT_PAGE_SIZE;
      renderTraceList();
      if (state.mainView === "projects") {
        renderProjectOverview();
      }
    };
  }
}

function renderTraceRow(trace) {
  const selected = trace.trace_id === state.selectedTraceId ? "is-selected" : "";
  return `
    <button class="trace-row ${selected}" data-trace-id="${escapeHtml(trace.trace_id)}">
      <span class="trace-row-top">
        <strong title="${escapeHtml(trace.title)}">${escapeHtml(trace.title)}</strong>
        <span>${escapeHtml(traceLabel(trace))}</span>
      </span>
      <span class="trace-row-meta">${formatDate(trace.started_at)}</span>
      <span class="trace-row-stats">
        <span>${trace.message_count} msg</span>
        <span>${trace.tool_call_count} tools</span>
        <span>${trace.file_change_count} files</span>
      </span>
    </button>
  `;
}

function groupTracesByProject(traces) {
  const projects = new Map();

  for (const trace of traces) {
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
    group.latest_at =
      new Date(trace.started_at).valueOf() > new Date(group.latest_at).valueOf()
        ? trace.started_at
        : group.latest_at;
    const sourceKey = traceLabel(trace);
    group.sources[sourceKey] = (group.sources[sourceKey] ?? 0) + 1;
    projects.set(key, group);
  }

  return Array.from(projects.values())
    .map((group) => ({
      ...group,
      source_summary: Object.entries(group.sources)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([source, count]) => `${source} ${count}`)
        .join(" · "),
      token_count: group.token_count,
      traces: group.traces.sort((a, b) => b.started_at.localeCompare(a.started_at)),
    }))
    .sort((a, b) => b.latest_at.localeCompare(a.latest_at));
}

function projectMetricValue(group) {
  return state.projectMetric === "tokens" ? group.token_count : group.message_count;
}

function sortProjectGroups(groups) {
  return [...groups].sort((a, b) => {
    if (state.projectSort === "name") {
      return a.name.localeCompare(b.name) || b.latest_at.localeCompare(a.latest_at);
    }

    if (state.projectSort === "sessions") {
      const sessionDelta = b.traces.length - a.traces.length;
      if (sessionDelta !== 0) return sessionDelta;
      return b.latest_at.localeCompare(a.latest_at);
    }

    return b.latest_at.localeCompare(a.latest_at) || a.name.localeCompare(b.name);
  });
}

function normalizeProjectSort(value) {
  return value === "name" || value === "sessions" ? value : "latest";
}

function projectStats(group) {
  return {
    message_count: group.message_count,
    token_count: group.token_count,
    tool_call_count: group.tool_call_count,
    file_change_count: group.file_change_count,
    checkpoint_count: group.checkpoint_count,
  };
}

function projectTileSpan(value, maxValue) {
  const scaled = Math.sqrt(value / maxValue);
  return Math.max(1, Math.min(4, Math.ceil(scaled * 4)));
}

function projectNameFromPath(projectPath) {
  const clean = projectPath.replace(/\/$/, "");
  return clean.split("/").pop() || "Unknown project";
}

function traceLabel(trace) {
  const sessionKind = trace.session_kind ?? trace.metadata?.session_kind;
  return sessionKind ? `${trace.source} ${sessionKind}` : trace.source;
}

async function selectTrace(traceId) {
  stopProjectReplay();
  clearProjectPreviewTimers();
  state.mainView = "trace";
  state.selectedTraceId = traceId;
  state.selectedProjectKey =
    groupTracesByProject(state.traces).find((group) =>
      group.traces.some((trace) => trace.trace_id === traceId),
    )?.key ?? null;
  renderTraceList();

  const data = await fetchJson(`/api/traces/${encodeURIComponent(traceId)}`);
  state.selectedTrace = data.trace;
  renderTraceDetail(data.trace);
}

function renderTraceDetail(trace) {
  const hasLongTitle = isLongTitle(trace.title);
  const toolCallGroups = groupToolCalls(trace.tool_calls);

  elements.detail.innerHTML = `
    <header class="detail-header">
      <div class="detail-title-block">
        <p class="eyebrow">${escapeHtml(traceLabel(trace))} · ${escapeHtml(trace.workspace.name)}</p>
        <h2 id="detail-title" class="detail-title ${hasLongTitle ? "is-collapsible" : ""}">${escapeHtml(trace.title)}</h2>
        ${
          hasLongTitle
            ? `<button class="title-toggle" type="button" data-title-toggle aria-expanded="false" aria-controls="detail-title">Show full title</button>`
            : ""
        }
        <p class="summary">${escapeHtml(trace.summary ?? trace.workspace.path)}</p>
      </div>
      <dl class="stat-grid" aria-label="Trace stats">
        ${statItem("Messages", trace.messages.length)}
        ${statItem("Tools", trace.tool_calls.length)}
        ${statItem("Files", trace.file_changes.length)}
        ${statItem("Checkpoints", trace.checkpoints.length)}
      </dl>
    </header>

    <nav class="tabs" aria-label="Trace sections">
      <button type="button" data-project-overview>Projects</button>
      <button type="button" data-user-messages>User Messages</button>
      <a href="#tools">Tools</a>
      <a href="#files">Files</a>
      <a href="#checkpoints">Checkpoints</a>
      <a href="#timeline">Timeline</a>
    </nav>

    <section class="detail-section split-section" id="tools">
      <div>
        <div class="section-heading">
          <h3>Tool Calls</h3>
          <span>${toolCallGroups.length} ${pluralize("type", toolCallGroups.length)} · ${trace.tool_calls.length} ${pluralize("call", trace.tool_calls.length)}</span>
        </div>
        <div class="tool-summary-list">
          ${toolCallGroups.length ? toolCallGroups.map(renderToolCallSummary).join("") : emptyLine("No tool calls")}
        </div>
      </div>
      <div>
        <div class="section-heading">
          <h3>Git State</h3>
          <span>${trace.git.test_result ?? "unknown"}</span>
        </div>
        ${renderGitState(trace.git)}
      </div>
    </section>

    <section class="detail-section" id="files">
      <div class="section-heading">
        <h3>File Changes</h3>
        <span>${trace.file_changes.length}</span>
      </div>
      <div class="file-grid">
        ${trace.file_changes.length ? trace.file_changes.map(renderFileChange).join("") : emptyLine("No file changes")}
      </div>
    </section>

    <section class="detail-section" id="checkpoints">
      <div class="section-heading">
        <h3>Checkpoints</h3>
        <span>${trace.checkpoints.length}</span>
      </div>
      <div class="checkpoint-list">
        ${trace.checkpoints.length ? trace.checkpoints.map(renderCheckpoint).join("") : emptyLine("No checkpoints")}
      </div>
    </section>

    <section class="detail-section" id="timeline">
      <div class="section-heading">
        <h3>Timeline</h3>
        <span>${formatDate(trace.started_at)} - ${trace.ended_at ? formatDate(trace.ended_at) : "open"}</span>
      </div>
      <div class="timeline">
        ${trace.messages.map(renderMessage).join("")}
      </div>
    </section>
  `;

  wireTitleToggle();
  wireProjectOverviewButton();
  wireUserMessagesButtons();
}

function renderMessage(message) {
  return `
    <article class="message message-${escapeHtml(message.role)}">
      <header>
        <span>${escapeHtml(message.role)}</span>
        <time>${formatTime(message.created_at)}</time>
      </header>
      <pre>${escapeHtml(message.content)}</pre>
    </article>
  `;
}

function groupToolCalls(toolCalls) {
  const groups = new Map();

  for (const toolCall of toolCalls) {
    const name = toolCall.name || "unknown";
    const group =
      groups.get(name) ??
      {
        name,
        count: 0,
        first_at: toolCall.created_at,
        latest_at: toolCall.created_at,
      };

    group.count += 1;
    group.first_at =
      new Date(toolCall.created_at).valueOf() < new Date(group.first_at).valueOf()
        ? toolCall.created_at
        : group.first_at;
    group.latest_at =
      new Date(toolCall.created_at).valueOf() > new Date(group.latest_at).valueOf()
        ? toolCall.created_at
        : group.latest_at;
    groups.set(name, group);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
}

function renderToolCallSummary(group) {
  return `
    <article class="tool-summary-item">
      <div>
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.count} ${pluralize("call", group.count)}</span>
      </div>
      <p>${escapeHtml(formatToolWindow(group))}</p>
    </article>
  `;
}

function formatToolWindow(group) {
  if (group.first_at === group.latest_at) {
    return `at ${formatTime(group.latest_at)}`;
  }

  return `${formatTime(group.first_at)} - ${formatTime(group.latest_at)}`;
}

function renderGitState(git) {
  return `
    <dl class="kv-list">
      ${kvItem("Branch", git.branch ?? "unknown")}
      ${kvItem("HEAD", git.head_sha ? git.head_sha.slice(0, 10) : "unknown")}
      ${kvItem("Dirty", git.is_dirty ? "yes" : "no")}
      ${kvItem("Changed", git.changed_files.length)}
      ${kvItem("Untracked", git.untracked_files.length)}
    </dl>
  `;
}

function renderFileChange(fileChange) {
  return `
    <article class="file-item">
      <div>
        <strong>${escapeHtml(fileChange.path)}</strong>
        <span>${escapeHtml(fileChange.change_type)}</span>
      </div>
      <div class="change-bars" aria-label="Line changes">
        <span style="--value:${Math.min(fileChange.additions ?? 0, 80)}"></span>
        <span style="--value:${Math.min(fileChange.deletions ?? 0, 80)}"></span>
      </div>
      <p>+${fileChange.additions ?? 0} / -${fileChange.deletions ?? 0}</p>
    </article>
  `;
}

function renderCheckpoint(checkpoint) {
  return `
    <article class="checkpoint-item">
      <div>
        <strong>${escapeHtml(checkpoint.label)}</strong>
        <span>${escapeHtml(checkpoint.reason)}</span>
      </div>
      <p>${formatDate(checkpoint.created_at)} · ${escapeHtml(checkpoint.test_status)}</p>
      <code>${escapeHtml(checkpoint.git.hidden_ref ?? checkpoint.git.head_sha ?? "no ref")}</code>
    </article>
  `;
}

function renderUserMessageItem(message) {
  const images = Array.isArray(message.images) ? message.images : [];
  const content = message.content || "";

  return `
    <article class="user-message-item">
      <header>
        <div>
          <strong>${escapeHtml(message.workspace.name)}</strong>
          <span>${escapeHtml(traceLabel(message))} · ${formatDate(message.created_at)} · ${escapeHtml(message.intent)}</span>
        </div>
        <button type="button" data-message-trace="${escapeHtml(message.trace_id)}">Details</button>
      </header>
      ${content ? `<p>${escapeHtml(content)}${message.is_truncated ? "..." : ""}</p>` : ""}
      ${images.length ? `<div class="user-message-images">${images.map(renderUserMessageImage).join("")}</div>` : ""}
      <footer>
        <span>${formatCompactNumber(message.character_count)} chars</span>
        <span>${formatCompactNumber(message.estimated_token_count)} tokens</span>
        ${images.length ? `<span>${images.length} ${pluralize("image", images.length)}</span>` : ""}
        <span title="${escapeHtml(message.trace_title)}">${escapeHtml(message.trace_title)}</span>
      </footer>
    </article>
  `;
}

function renderUserMessageImage(image) {
  const label = imageTypeLabel(image.mime_type);

  return `
    <a class="user-message-image" href="${escapeHtml(image.src)}" target="_blank" rel="noreferrer" title="${escapeHtml(label)}">
      <img src="${escapeHtml(image.src)}" alt="User attached image ${image.index + 1}" loading="lazy" />
      <span>${escapeHtml(label)}</span>
    </a>
  `;
}

function imageTypeLabel(mimeType) {
  return String(mimeType || "image")
    .replace(/^image\//, "")
    .replace("svg+xml", "svg")
    .toUpperCase();
}

function renderIntentRow(item, total) {
  const percentage = total ? Math.round((item.count / total) * 100) : 0;

  return `
    <div class="intent-row">
      <span>${escapeHtml(intentLabel(item.intent))}</span>
      <strong>${item.count}</strong>
      <div aria-hidden="true"><span style="--value:${percentage}"></span></div>
    </div>
  `;
}

function renderProjectMessageRow(item, total) {
  const percentage = total ? Math.round((item.count / total) * 100) : 0;

  return `
    <div class="intent-row">
      <span>${escapeHtml(item.name)}</span>
      <strong>${item.count}</strong>
      <div aria-hidden="true"><span style="--value:${percentage}"></span></div>
    </div>
  `;
}

function renderTerm(item) {
  return `<span>${escapeHtml(item.term)} <strong>${item.count}</strong></span>`;
}

function renderEmptyState() {
  elements.detail.innerHTML = `
    <div class="empty-state">
      <p class="eyebrow">No Trace Selected</p>
      <h2>Import or select a local trace.</h2>
    </div>
  `;
}

function statItem(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function insightItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function quietStatItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function kvItem(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

function emptyLine(text) {
  return `<p class="empty-line">${escapeHtml(text)}</p>`;
}

function isLongTitle(value) {
  return Array.from(String(value)).length > 72;
}

function wireTitleToggle() {
  const button = elements.detail.querySelector("[data-title-toggle]");
  const title = elements.detail.querySelector("#detail-title");

  if (!button || !title) {
    return;
  }

  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    title.classList.toggle("is-expanded", !expanded);
    button.textContent = expanded ? "Show full title" : "Collapse title";
  });
}

function wireProjectOverviewButton() {
  const button = elements.detail.querySelector("[data-project-overview]");

  if (!button) {
    return;
  }

  button.addEventListener("click", showProjectOverview);
}

function wireUserMessagesButtons() {
  for (const button of elements.detail.querySelectorAll("[data-user-messages]")) {
    button.addEventListener("click", () => {
      stopProjectReplay();
      renderUserMessagesPage();
    });
  }
}

function wireTraceDetailButtons(root) {
  for (const button of root.querySelectorAll("[data-message-trace]")) {
    button.addEventListener("click", () => selectTrace(button.dataset.messageTrace));
  }
}

function showProjectOverview() {
  stopProjectReplay();
  state.mainView = "projects";
  state.selectedTraceId = null;
  state.selectedTrace = null;
  state.selectedProjectKey = null;
  renderTraceList();
  renderProjectOverview();
}

async function refreshHome() {
  stopProjectReplay();
  clearProjectPreviewTimers();
  state.mainView = "projects";
  state.selectedTraceId = null;
  state.selectedTrace = null;
  state.selectedProjectKey = null;
  await loadTraces();
}

function buildFilterParams(extra = {}) {
  const params = new URLSearchParams();

  if (state.query) params.set("q", state.query);
  if (state.source && state.source !== "all") params.set("source", state.source);
  if (state.workspace) params.set("workspace", state.workspace);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  return params;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function pluralize(word, count) {
  return count === 1 ? word : `${word}s`;
}

function intentLabel(intent) {
  const labels = {
    analysis: "Analysis",
    build: "Build",
    debug: "Debug",
    navigate: "Navigation",
    other: "Other",
    planning: "Planning",
    polish: "Polish",
    question: "Question",
  };

  return labels[intent] ?? intent;
}

function formatProjectName(value) {
  return escapeHtml(value)
    .replaceAll("_", "_<wbr>")
    .replaceAll("-", "-<wbr>")
    .replaceAll(".", ".<wbr>");
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return CSS.escape(String(value));
  }

  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
