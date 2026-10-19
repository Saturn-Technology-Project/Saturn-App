import { useEffect, useRef, useState } from "react";
import type { Project } from "../domain/model";

export type ProjectGrouping = "none" | "folder";
export type ProjectSorting = "lastOpened" | "name";
export type ProjectView = {
  groupBy: ProjectGrouping;
  sortBy: ProjectSorting;
  showPath: boolean;
  showBranch?: boolean;
  showAll: boolean;
};

export const DEFAULT_PROJECT_VIEW: ProjectView = { groupBy: "none", sortBy: "lastOpened", showPath: false, showAll: false };
/** Rows shown before "View all". */
export const PROJECT_LIMIT = 5;
const STORAGE_KEY = "saturn.projectView";

const GROUP_LABELS: Record<ProjectGrouping, string> = { none: "None", folder: "Folder" };
const SORT_LABELS: Record<ProjectSorting, string> = { lastOpened: "Last opened", name: "Name" };

/** The sidebar's project list preferences, remembered per machine. */
export function useProjectView(): [ProjectView, (patch: Partial<ProjectView>) => void, () => void] {
  const [view, setView] = useState<ProjectView>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ProjectView> | null;
      return { ...DEFAULT_PROJECT_VIEW, ...(saved ?? {}) };
    } catch {
      return DEFAULT_PROJECT_VIEW;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // Storage can be unavailable; the list still works with the in-memory view.
    }
  }, [view]);
  return [view, (patch) => setView((current) => ({ ...current, ...patch })), () => setView(DEFAULT_PROJECT_VIEW)];
}

function parentFolder(project: Project): string {
  const parts = project.path.replace(/\/+$/, "").split("/");
  parts.pop();
  const parent = parts.join("/") || "/";
  return parent.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Sorts and groups projects for the sidebar. The active project always stays visible: when the list is
 * cut to {@link PROJECT_LIMIT}, it takes the last slot if it would otherwise be hidden.
 */
export function arrangeProjects(projects: Project[], view: ProjectView, activeId: string | null) {
  const sorted = [...projects].sort((a, b) =>
    view.sortBy === "name"
      ? a.name.localeCompare(b.name)
      : (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") || a.name.localeCompare(b.name),
  );
  let visible = sorted;
  if (!view.showAll && sorted.length > PROJECT_LIMIT) {
    visible = sorted.slice(0, PROJECT_LIMIT);
    const active = sorted.find((project) => project.id === activeId);
    if (active && !visible.includes(active)) visible = [...visible.slice(0, PROJECT_LIMIT - 1), active];
  }
  if (view.groupBy === "none") return { groups: [{ key: "", label: "", projects: visible }], hidden: sorted.length - visible.length };
  const groups = new Map<string, Project[]>();
  for (const project of visible) {
    const key = parentFolder(project);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  return {
    groups: [...groups.entries()].map(([key, items]) => ({ key, label: key, projects: items })),
    hidden: sorted.length - visible.length,
  };
}

type Submenu = "group" | "sort" | "show" | null;

/** The Projects header's filter menu: Group by, Sort by, Show, Reset to defaults and View all. */
export function ProjectsMenu(props: { view: ProjectView; total: number; onChange: (patch: Partial<ProjectView>) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const isDefault = JSON.stringify(props.view) === JSON.stringify(DEFAULT_PROJECT_VIEW);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (patch: Partial<ProjectView>) => {
    props.onChange(patch);
    setOpen(false);
  };

  return (
    <div className="projects-menu" ref={ref}>
      <button
        type="button"
        className={open ? "agent-folder-action-btn active" : "agent-folder-action-btn"}
        title="Filter, sort and group projects"
        aria-label="Project list options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          // Fixed to the window: the sidebar clips anything that overflows it.
          const box = event.currentTarget.getBoundingClientRect();
          setAnchor({ left: Math.max(8, Math.min(box.left, window.innerWidth - 420)), top: box.bottom + 6 });
          setOpen((value) => !value);
          setSubmenu(null);
        }}
      >
        <SlidersIcon />
      </button>
      {open ? (
        <div className="titlebar-dropdown projects-menu-popover" role="menu" style={{ left: anchor.left, top: anchor.top }}>
          <MenuRow label="Group by" value={GROUP_LABELS[props.view.groupBy]} open={submenu === "group"} onOpen={() => setSubmenu("group")}>
            {(Object.keys(GROUP_LABELS) as ProjectGrouping[]).map((key) => (
              <CheckItem key={key} checked={props.view.groupBy === key} label={GROUP_LABELS[key]} onClick={() => choose({ groupBy: key })} />
            ))}
          </MenuRow>
          <MenuRow label="Sort by" value={SORT_LABELS[props.view.sortBy]} open={submenu === "sort"} onOpen={() => setSubmenu("sort")}>
            {(Object.keys(SORT_LABELS) as ProjectSorting[]).map((key) => (
              <CheckItem key={key} checked={props.view.sortBy === key} label={SORT_LABELS[key]} onClick={() => choose({ sortBy: key })} />
            ))}
          </MenuRow>
          <MenuRow label="Show" open={submenu === "show"} onOpen={() => setSubmenu("show")}>
            <CheckItem checked={props.view.showPath} label="Path" onClick={() => props.onChange({ showPath: !props.view.showPath })} />
          </MenuRow>
          <div className="titlebar-dropdown-divider" />
          <button
            type="button"
            role="menuitem"
            className="titlebar-dropdown-item"
            disabled={isDefault}
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => { props.onReset(); setOpen(false); }}
          >
            Reset to defaults
          </button>
          <button
            type="button"
            role="menuitem"
            className="titlebar-dropdown-item"
            disabled={props.total <= PROJECT_LIMIT}
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => choose({ showAll: !props.view.showAll })}
          >
            {props.view.showAll && props.total > PROJECT_LIMIT ? "Show fewer" : "View all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow(props: { label: string; value?: string; open: boolean; onOpen: () => void; children: React.ReactNode }) {
  return (
    <div className="projects-menu-row" onMouseEnter={props.onOpen}>
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={props.open} className="titlebar-dropdown-item" onClick={props.onOpen}>
        <span className="projects-menu-label">{props.label}</span>
        {props.value ? <span className="projects-menu-value">{props.value}</span> : <span className="projects-menu-value" />}
        <ChevronRight />
      </button>
      {props.open ? <div className="titlebar-dropdown projects-menu-sub" role="menu">{props.children}</div> : null}
    </div>
  );
}

function CheckItem(props: { checked: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={props.checked} className="titlebar-dropdown-item" onClick={props.onClick}>
      <span className="projects-menu-check">{props.checked ? "✓" : ""}</span>
      {props.label}
    </button>
  );
}

function SlidersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 2v12M11 2v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5" cy="10" r="1.8" fill="var(--panel, #161618)" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="6" r="1.8" fill="var(--panel, #161618)" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GitBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="6" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 6v4M4 8c2.5 0 4-1 6-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
