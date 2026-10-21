import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import type { WorkspaceFileEntry } from "../application/workspace";
import type { Run, RunAction, BackgroundJob, AgentBrowserFrame, AgentBrowserState } from "../domain/model";
import { RunChangesCard, hasFileChanges } from "./RunChanges";

export type InspectorFeature = "changes" | "browser" | "terminal" | "file";

interface InspectorTabItem {
  id: string;
  feature: InspectorFeature;
  title: string;
}

interface TerminalHistoryItem {
  id: string;
  cwd: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  source: "user" | "agent";
}

export function Inspector(props: {
  runs: Run[];
  initialFeature?: InspectorFeature | null;
  onClose: () => void;
  onResizeStart?: (e: React.PointerEvent) => void;
  onResizeReset?: () => void;
  isResizing?: boolean;
}) {
  const [tabs, setTabs] = useState<InspectorTabItem[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [expanded, setExpanded] = useState(false);
  const lastInitialFeature = useRef<InspectorFeature | null>(null);

  useEffect(() => {
    if (props.initialFeature && props.initialFeature !== lastInitialFeature.current) {
      lastInitialFeature.current = props.initialFeature;
      // A tab of that kind already open comes to the front instead of a second one.
      const existing = tabs.find((tab) => tab.feature === props.initialFeature);
      if (existing) setActiveTabId(existing.id);
      else openFeatureTab(props.initialFeature);
    } else if (!props.initialFeature) {
      lastInitialFeature.current = null;
    }
  }, [props.initialFeature]);

  function openFeatureTab(feature: InspectorFeature) {
    const newTab: InspectorTabItem = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      feature,
      title: defaultTabTitle(feature),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }

  function closeTab(tabId: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        setActiveTabId(fallback ? fallback.id : null);
      }
      return next;
    });
  }

  function updateTabTitle(tabId: string, title: string) {
    setTabs((prev) =>
      prev.map((item) => (item.id === tabId && item.title !== title ? { ...item, title } : item)),
    );
  }

  const allActions = props.runs.flatMap((run) =>
    run.actions.map((action, index) => ({
      runId: run.id,
      prompt: run.input,
      actionId: action.id ?? `${run.id}-${index}`,
      action,
    })),
  );

  // Runs in a project folder have a checkpoint with real diffs; the rest (sandbox chats) show their patches.
  const reviewRuns = props.runs.filter(hasFileChanges);
  const changeCount = reviewRuns.reduce((sum, run) => sum + (run.checkpoint?.files.filter((file) => file.before !== file.after).length ?? 0), 0);
  const changeActions = allActions.filter(
    ({ runId, action }) =>
      !reviewRuns.some((run) => run.id === runId) &&
      action.toolId === "files" &&
      (action.arguments?.action === "patch" ||
        action.arguments?.action === "write" ||
        typeof action.arguments?.patch === "string"),
  );

  const browserActions = allActions.filter(({ action }) => action.toolId === "web" || action.toolId.startsWith("browser_"));
  const terminalActions = allActions.filter(({ action }) => action.toolId === "code" || action.toolId === "code_output" || action.toolId === "code_stop");
  const threadId = props.runs.find((run) => run.threadId)?.threadId ?? null;
  const fileActions = allActions.filter(
    ({ action }) =>
      action.toolId === "files" &&
      (action.arguments?.action === "read" ||
        action.arguments?.action === "list" ||
        action.arguments?.action === "write"),
  );

  const showLauncher = tabs.length === 0 || activeTabId === null;

  return (
    <aside className={expanded ? "inspector expanded" : "inspector"} aria-label="Inspector">
      {!expanded && props.onResizeStart ? (
        <div
          className={props.isResizing ? "resizer-handle resizer-handle-inspector active" : "resizer-handle resizer-handle-inspector"}
          onPointerDown={props.onResizeStart}
          onDoubleClick={props.onResizeReset}
          title="Drag to resize inspector (Double-click to reset)"
        />
      ) : null}
      {/* Top Tab Bar matching Cursor / Antigravity screenshot */}
      <div className="inspector-tabbar">
        <div className="inspector-tab-strip">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                className={isActive ? "inspector-tab-pill active" : "inspector-tab-pill"}
                onClick={() => setActiveTabId(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveTabId(tab.id);
                  }
                }}
              >
                <span className="inspector-tab-icon">{featureSmallIcon(tab.feature)}</span>
                <span className="inspector-tab-label">{tab.title}</span>
                <button
                  type="button"
                  className="inspector-tab-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <CloseSmallIcon />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            className={showLauncher && tabs.length > 0 ? "inspector-tab-add active" : "inspector-tab-add"}
            aria-label="New tab"
            title="New tab"
            onClick={() => setActiveTabId(null)}
          >
            <PlusSmallIcon />
          </button>
        </div>

        <div className="inspector-window-controls">
          <button
            type="button"
            className="inspector-win-btn"
            aria-label={expanded ? "Restore panel size" : "Expand panel"}
            title={expanded ? "Restore panel size" : "Expand panel"}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <ExpandCornersIcon />
          </button>
          <button
            type="button"
            className="inspector-win-btn"
            aria-label="Close inspector panel"
            title="Close inspector panel"
            onClick={props.onClose}
          >
            <SidebarPaneIcon />
          </button>
        </div>
      </div>

      {/* 4-Box Launcher Grid when no tab is active or all tabs are closed */}
      {showLauncher ? (
        <div className="inspector-launcher">
          <div className="inspector-grid">
            <button
              type="button"
              className="inspector-grid-btn"
              onClick={() => openFeatureTab("changes")}
            >
              <ChangesIcon />
              <span>Changes</span>
              {changeCount + changeActions.length > 0 ? <small className="grid-badge">{changeCount + changeActions.length}</small> : null}
            </button>

            <button
              type="button"
              className="inspector-grid-btn"
              onClick={() => openFeatureTab("browser")}
            >
              <BrowserIcon />
              <span>Browser</span>
              {browserActions.length > 0 ? <small className="grid-badge">{browserActions.length}</small> : null}
            </button>

            <button
              type="button"
              className="inspector-grid-btn"
              onClick={() => openFeatureTab("terminal")}
            >
              <TerminalIcon />
              <span>Terminal</span>
              {terminalActions.length > 0 ? <small className="grid-badge">{terminalActions.length}</small> : null}
            </button>

            <button
              type="button"
              className="inspector-grid-btn"
              onClick={() => openFeatureTab("file")}
            >
              <FileIcon />
              <span>File</span>
              {fileActions.length > 0 ? <small className="grid-badge">{fileActions.length}</small> : null}
            </button>
          </div>
        </div>
      ) : null}

      {/* Keep open tabs mounted so Terminal sessions & Browser pages persist */}
      {tabs.map((tab) => {
        const isVisible = !showLauncher && tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={
              tab.feature === "terminal"
                ? "inspector-content terminal-mode"
                : tab.feature === "browser"
                  ? "inspector-content browser-mode"
                  : "inspector-content"
            }
            style={{ display: isVisible ? "flex" : "none" }}
          >
            {tab.feature === "changes" ? <ChangesView runs={reviewRuns} items={changeActions} /> : null}
            {tab.feature === "browser" ? (
              <BrowserView
                items={browserActions}
                onTitleChange={(title) => updateTabTitle(tab.id, title)}
              />
            ) : null}
            {tab.feature === "terminal" ? (
              <TerminalView
                items={terminalActions}
                threadId={threadId}
                onTitleChange={(title) => updateTabTitle(tab.id, title)}
              />
            ) : null}
            {tab.feature === "file" ? (
              <FileView
                items={fileActions}
                onTitleChange={(title) => updateTabTitle(tab.id, title)}
              />
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}

function defaultTabTitle(feature: InspectorFeature): string {
  switch (feature) {
    case "changes":
      return "Changes";
    case "browser":
      return "example.com";
    case "terminal":
      return "zsh";
    case "file":
      return "workspace";
  }
}

function featureSmallIcon(feature: InspectorFeature) {
  switch (feature) {
    case "changes":
      return <ChangesIcon size={14} />;
    case "browser":
      return <BrowserIcon size={14} />;
    case "terminal":
      return <TerminalIcon size={14} />;
    case "file":
      return <FileIcon size={14} />;
  }
}

/* ─── 1. Changes View (Diff / Patches) ─── */
function ChangesView(props: { runs: Run[]; items: { runId: string; prompt: string; action: RunAction }[] }) {
  if (props.items.length === 0 && props.runs.length === 0) {
    return (
      <div className="feature-empty">
        <ChangesIcon />
        <strong>No File Changes Yet</strong>
        <p>Patches and file modifications made in the workspace will appear here as unified diffs.</p>
      </div>
    );
  }

  return (
    <div className="feature-list">
      {props.runs.map((run) => (
        <div className="changes-run" key={`${run.id}-changes`}>
          <small className="feature-prompt">{run.input}</small>
          <RunChangesCard run={run} defaultOpen={false} />
        </div>
      ))}
      {props.items.map(({ runId, prompt, action }, idx) => {
        const args = action.arguments ?? {};
        const patchText =
          typeof args.patch === "string"
            ? args.patch
            : typeof args.content === "string"
              ? `+ ${args.content}`
              : "";
        const targetPath = typeof args.path === "string" ? args.path : "workspace file";
        const isOk = action.status === "completed";

        return (
          <div className="diff-card" key={`${runId}-diff-${idx}`}>
            <div className="diff-card-head">
              <span className={`dot ${isOk ? "ok" : "off"}`} />
              <strong className="diff-path">{targetPath}</strong>
              <span className="diff-mode">{String(args.action ?? "patch")}</span>
            </div>
            {patchText ? (
              <pre className="diff-pre">
                {patchText.split("\n").map((line, lineIdx) => {
                  const lineClass = line.startsWith("+")
                    ? "diff-line-add"
                    : line.startsWith("-")
                      ? "diff-line-del"
                      : line.startsWith("@") || line.startsWith("*")
                        ? "diff-line-meta"
                        : "diff-line-ctx";
                  return (
                    <div className={`diff-line ${lineClass}`} key={lineIdx}>
                      {line || " "}
                    </div>
                  );
                })}
              </pre>
            ) : null}
            <small className="feature-prompt">{prompt}</small>
          </div>
        );
      })}
    </div>
  );
}

/* ─── 2. Real Interactive Browser View ─── */
/**
 * The Browser tab: while the agent's browser is open, its page live (cursor included, read-only), the way Codex
 * shows its browser; otherwise a browser the user drives.
 */
function BrowserView(props: {
  items: { runId: string; prompt: string; action: RunAction }[];
  onTitleChange?: (title: string) => void;
}) {
  const [agent, setAgent] = useState<AgentBrowserState | null>(null);
  const [frame, setFrame] = useState<AgentBrowserFrame | null>(null);
  const [watchMine, setWatchMine] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          await desktop.live.watchBrowser(
            (state) => {
              setAgent(state);
              if (!state.open) setFrame(null);
            },
            setFrame,
            controller.signal,
          );
        } catch {
          // A runtime older than this app, or restarting: tried again below.
        }
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    };
    void loop();
    return () => controller.abort();
  }, []);

  // A new browsing session brings the live view back.
  useEffect(() => {
    if (agent?.open) setWatchMine(false);
  }, [agent?.open]);

  const live = agent?.open && !watchMine;
  useEffect(() => {
    if (!live) return;
    const host = (frame?.url ?? agent?.url ?? "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    props.onTitleChange?.(host && host !== "about:blank" ? `Agent · ${host}` : "Agent browser");
  }, [live, frame?.url, agent?.url]);

  if (live && agent) {
    const url = frame?.url ?? agent.url;
    return (
      <div className="browser-shell">
        <div className="browser-url-bar agent-browser-bar">
          <span className="agent-browser-badge" title={agent.mode === "system" ? "The agent is also using a Chrome window" : agent.mode === "safari" ? "The agent is using a Safari window; this view refreshes about once a second" : "The agent's own browser"}>
            <span className="agent-browser-dot" aria-hidden="true" />
            Agent
          </span>
          <input value={url === "about:blank" ? "" : url} readOnly aria-label="Agent browser URL" placeholder="Starting…" />
          <button type="button" className="browser-icon-btn" onClick={() => setWatchMine(true)} title="Use your own browser here">
            ⇄
          </button>
        </div>
        <div className="browser-viewport agent-browser-viewport">
          {frame ? (
            <img className="agent-browser-frame" src={`data:image/${frame.format ?? "jpeg"};base64,${frame.data}`} alt={frame.title || "The agent's browser"} />
          ) : (
            <div className="agent-browser-empty">{agent.mode === "system" ? "The agent is browsing in a Chrome window." : agent.mode === "safari" ? "The agent is browsing in a Safari window." : "Waiting for the page…"}</div>
          )}
        </div>
      </div>
    );
  }
  return <ManualBrowser {...props} agentOpen={Boolean(agent?.open)} onWatchAgent={() => setWatchMine(false)} />;
}

function ManualBrowser(props: {
  items: { runId: string; prompt: string; action: RunAction }[];
  onTitleChange?: (title: string) => void;
  agentOpen: boolean;
  onWatchAgent: () => void;
}) {
  const initialAgentUrl = props.items.at(-1)?.action.arguments?.url;
  const startUrl = typeof initialAgentUrl === "string" && initialAgentUrl ? initialAgentUrl : "https://example.com";

  const [history, setHistory] = useState<string[]>([startUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [addressInput, setAddressInput] = useState(startUrl);
  const [reloadKey, setReloadKey] = useState(0);

  const currentUrl = history[historyIndex] ?? "https://example.com";

  useEffect(() => {
    const cleanHost = currentUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    props.onTitleChange?.(cleanHost || "Browser");
  }, [currentUrl]);

  function navigateTo(rawInput: string) {
    const formatted = formatBrowserUrl(rawInput);
    const nextHistory = [...history.slice(0, historyIndex + 1), formatted];
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setAddressInput(formatted);
  }

  function goBack() {
    if (historyIndex > 0) {
      const nextIdx = historyIndex - 1;
      setHistoryIndex(nextIdx);
      setAddressInput(history[nextIdx] ?? "");
    }
  }

  function goForward() {
    if (historyIndex < history.length - 1) {
      const nextIdx = historyIndex + 1;
      setHistoryIndex(nextIdx);
      setAddressInput(history[nextIdx] ?? "");
    }
  }

  const iframeSrc = isLoopbackUrl(currentUrl) ? currentUrl : desktop.workspace.proxyUrl(currentUrl);

  return (
    <div className="browser-shell">
      <form
        className="browser-url-bar"
        onSubmit={(event) => {
          event.preventDefault();
          navigateTo(addressInput);
        }}
      >
        <div className="browser-nav-btns">
          <button
            type="button"
            className="browser-icon-btn"
            disabled={historyIndex <= 0}
            onClick={goBack}
            title="Back"
          >
            ←
          </button>
          <button
            type="button"
            className="browser-icon-btn"
            disabled={historyIndex >= history.length - 1}
            onClick={goForward}
            title="Forward"
          >
            →
          </button>
          <button
            type="button"
            className="browser-icon-btn"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload page"
          >
            ↻
          </button>
        </div>

        <input
          value={addressInput}
          onChange={(event) => setAddressInput(event.target.value)}
          placeholder="Enter URL or search…"
          aria-label="Browser URL"
        />
        {props.agentOpen ? (
          <button type="button" className="agent-browser-badge" onClick={props.onWatchAgent} title="Watch the agent's browser">
            <span className="agent-browser-dot" aria-hidden="true" />
            Agent
          </button>
        ) : null}
      </form>

      <div className="browser-viewport">
        <iframe
          key={`${currentUrl}-${reloadKey}`}
          src={iframeSrc}
          title="Embedded Workspace Browser"
          className="browser-iframe"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}

function formatBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "https://example.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

/* ─── 3. Real Interactive Terminal View ─── */
/** The chat's background commands (a dev server, a watcher): what runs, with a Stop button; polled while shown. */
function BackgroundJobs(props: { threadId: string }) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  useEffect(() => {
    let stale = false;
    const load = () => desktop.catalog.threadJobs(props.threadId).then((list) => { if (!stale) setJobs(list); }, () => undefined);
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [props.threadId]);
  if (!jobs.length) return null;
  return (
    <div className="terminal-jobs">
      <div className="terminal-jobs-title">Background commands</div>
      {jobs.map((job) => (
        <div className="terminal-job" key={job.id}>
          <span className={job.running ? "terminal-job-dot running" : "terminal-job-dot"} aria-hidden="true" />
          <code className="terminal-job-cmd" title={`${job.id} · started ${new Date(job.startedAt).toLocaleTimeString()}`}>{job.command}</code>
          <span className="terminal-job-state">{job.running ? "running" : `exit ${job.exitCode ?? "?"}`}</span>
          {job.running ? (
            <button type="button" className="btn ghost tiny" onClick={() => void desktop.catalog.stopJob(props.threadId, job.id).then(() => desktop.catalog.threadJobs(props.threadId)).then(setJobs, () => undefined)}>
              Stop
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TerminalView(props: {
  items: { runId: string; prompt: string; action: RunAction }[];
  threadId?: string | null;
  onTitleChange?: (title: string) => void;
}) {
  const [cwd, setCwd] = useState<string>("~");
  const [shellName, setShellName] = useState<string>("zsh");
  const [userHost, setUserHost] = useState<string>("local");
  const [command, setCommand] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [entries, setEntries] = useState<TerminalHistoryItem[]>([]);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number>(-1);

  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    desktop.workspace
      .info()
      .then((info) => {
        if (cancelled) return;
        setCwd(info.cwd);
        const baseShell = info.shell.split(/[\\/]/).pop() || "zsh";
        setShellName(baseShell);
        setUserHost(`${info.user}@${info.hostname}`);
        props.onTitleChange?.(baseShell);
      })
      .catch(() => {
        // Keep defaults if runtime is busy
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, props.items.length, running]);

  async function handleRunCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || running) return;

    setCmdHistory((prev) => [...prev, trimmed]);
    setHistoryCursor(-1);
    setCommand("");
    props.onTitleChange?.(trimmed);

    if (trimmed === "clear" || trimmed === "cls") {
      setEntries([]);
      props.onTitleChange?.(shellName);
      return;
    }

    setRunning(true);
    try {
      const res = await desktop.workspace.exec(trimmed, cwd === "~" ? undefined : cwd);
      setCwd(res.cwd);
      setEntries((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          cwd: `${userHost} ${shortPath(cwd)}`,
          command: trimmed,
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          source: "user",
        },
      ]);
    } catch (error) {
      setEntries((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          cwd: `${userHost} ${shortPath(cwd)}`,
          command: trimmed,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Command execution failed",
          exitCode: 1,
          source: "user",
        },
      ]);
    } finally {
      setRunning(false);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }

  return (
    <div className="terminal-shell" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-logs">
        {props.threadId ? <BackgroundJobs threadId={props.threadId} /> : null}

        {/* Agent executed commands, background ones included (started, read with code_output, stopped) */}
        {props.items.map(({ runId, action }, idx) => {
          const res = action.result as { stdout?: string; stderr?: string; exitCode?: number; jobId?: string; output?: string; running?: boolean; command?: string; stopped?: boolean } | undefined;
          const cmd = action.toolId === "code"
            ? `${String(action.arguments?.command ?? "")}${action.arguments?.background === true ? "  &" : ""}`
            : action.toolId === "code_output"
              ? `output of ${res?.command ?? String(action.arguments?.jobId ?? "")}${res && !res.running ? ` (exit ${res.exitCode ?? "?"})` : ""}`
              : `stop ${res?.command ?? String(action.arguments?.jobId ?? "")}`;
          const stdout = res?.stdout ?? res?.output ?? (typeof action.result === "string" ? action.result : "");
          const stderr = res?.stderr ?? action.reason ?? "";

          return (
            <div className="terminal-entry" key={`${runId}-agent-term-${idx}`}>
              <div className="terminal-cmd">
                <span className="terminal-prompt">agent %</span>
                <strong>{cmd}</strong>
              </div>
              {stdout ? <pre className="terminal-stdout">{stdout.trimEnd()}</pre> : null}
              {stderr ? <pre className="terminal-stderr">{stderr.trimEnd()}</pre> : null}
            </div>
          );
        })}

        {/* User interactive commands */}
        {entries.map((entry) => (
          <div className="terminal-entry" key={entry.id}>
            <div className="terminal-cmd">
              <span className="terminal-prompt">{entry.cwd} %</span>
              <span className="terminal-cmd-text">{entry.command}</span>
              {entry.exitCode !== 0 ? <span className="terminal-exit">exit {entry.exitCode}</span> : null}
            </div>
            {entry.stdout ? <pre className="terminal-stdout">{entry.stdout.trimEnd()}</pre> : null}
            {entry.stderr ? <pre className="terminal-stderr">{entry.stderr.trimEnd()}</pre> : null}
          </div>
        ))}

        {/* Active command line flowing from top to bottom */}
        <form
          className="terminal-active-line"
          onSubmit={(event) => {
            event.preventDefault();
            void handleRunCommand(command);
          }}
        >
          <span className="terminal-prompt">{userHost} {shortPath(cwd)} %</span>
          <input
            ref={inputRef}
            className="terminal-inline-input"
            value={command}
            disabled={running}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && cmdHistory.length > 0) {
                event.preventDefault();
                const nextCursor = historyCursor === -1 ? cmdHistory.length - 1 : Math.max(0, historyCursor - 1);
                setHistoryCursor(nextCursor);
                setCommand(cmdHistory[nextCursor] ?? "");
              } else if (event.key === "ArrowDown" && historyCursor !== -1) {
                event.preventDefault();
                if (historyCursor >= cmdHistory.length - 1) {
                  setHistoryCursor(-1);
                  setCommand("");
                } else {
                  const nextCursor = historyCursor + 1;
                  setHistoryCursor(nextCursor);
                  setCommand(cmdHistory[nextCursor] ?? "");
                }
              }
            }}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </form>

        {running ? <div className="terminal-running">Running command…</div> : null}

        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function shortPath(fullPath: string): string {
  if (!fullPath || fullPath === "~") return "~";
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "/";
}

/* ─── 4. Real Workspace File Explorer & Reader ─── */
function FileView(props: {
  items: { runId: string; prompt: string; action: RunAction }[];
  onTitleChange?: (title: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [currentDir, setCurrentDir] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    void loadDirectory("");
  }, [props.items.length]);

  async function loadDirectory(dirPath: string) {
    try {
      const res = await desktop.workspace.files(dirPath);
      if (res.kind === "directory") {
        setCurrentDir(res.path === "." ? "" : res.path);
        setEntries(res.entries ?? []);
        props.onTitleChange?.(res.path === "." ? "workspace" : res.path.split("/").pop() || "workspace");
      } else if (res.kind === "file") {
        setSelectedFile({ path: res.path, content: res.content ?? "" });
        props.onTitleChange?.(res.path.split("/").pop() || res.path);
      }
    } catch {
      // Ignore if workspace is empty
    }
  }

  async function openEntry(entry: WorkspaceFileEntry) {
    await loadDirectory(entry.path);
  }

  return (
    <div className="file-shell">
      <div className="file-head">
        <code>{selectedFile ? selectedFile.path : currentDir || "workspace/"}</code>
        {selectedFile ? (
          <button
            type="button"
            className="feature-tab"
            onClick={() => {
              setSelectedFile(null);
              props.onTitleChange?.(currentDir ? currentDir.split("/").pop() || "workspace" : "workspace");
            }}
          >
            ← Back to files
          </button>
        ) : currentDir ? (
          <button
            type="button"
            className="feature-tab"
            onClick={() => {
              const parent = currentDir.split("/").slice(0, -1).join("/");
              void loadDirectory(parent);
            }}
          >
            ↑ Up
          </button>
        ) : (
          <button
            type="button"
            className="feature-tab"
            onClick={() => void loadDirectory(currentDir)}
          >
            ↻ Refresh
          </button>
        )}
      </div>

      {selectedFile ? (
        <div className="file-viewer">
          <pre className="file-pre">{selectedFile.content || "(Empty file)"}</pre>
        </div>
      ) : entries.length > 0 ? (
        <div className="workspace-file-list">
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="workspace-file-row"
              onClick={() => void openEntry(entry)}
            >
              <span className="file-kind-icon">{entry.kind === "directory" ? "📁" : "📄"}</span>
              <span className="file-row-name">{entry.name}</span>
              <small className="file-row-kind">{entry.kind}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="feature-empty">
          <FileIcon />
          <strong>Workspace is Empty</strong>
          <p>Create files via the Terminal or ask the Agent to generate files in the workspace.</p>
        </div>
      )}
    </div>
  );
}

/* ─── Icons matching Cursor / Antigravity ─── */
function ChangesIcon(props: { size?: number }) {
  const s = props.size ?? 20;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M5 5.5V13" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="11" cy="11.5" r="1.5" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M11 10V6.5C11 5.1 9.9 4 8.5 4H7.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BrowserIcon(props: { size?: number }) {
  const s = props.size ?? 20;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <ellipse cx="8" cy="8" rx="2.6" ry="5.8" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.4 8h11.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function TerminalIcon(props: { size?: number }) {
  const s = props.size ?? 20;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M4.8 6.4L6.8 8l-2 1.6M8 9.8h2.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon(props: { size?: number }) {
  const s = props.size ?? 20;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.2 2.4h4.8l3 3v8.2a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path d="M8.8 2.4v3.2H12" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

function PlusSmallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ExpandCornersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 6V3.5A.5.5 0 0 1 3.5 3H6M10 3h2.5a.5.5 0 0 1 .5.5V6M13 10v2.5a.5.5 0 0 1-.5.5H10M6 13H3.5a.5.5 0 0 1-.5-.5V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarPaneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.2 2.8v10.4" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
