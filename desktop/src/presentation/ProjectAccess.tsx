import { useEffect, useState } from "react";
import type { Project } from "../domain/model";

declare global {
  interface Window {
    /** Exposed by preload.cjs in the desktop app; absent in a plain browser. */
    saturnDesktop?: {
      pickFolders(options?: { title?: string; multiple?: boolean }): Promise<string[]>;
      notify?(options: { title: string; body?: string; agentId?: string; threadId?: string; silent?: boolean }): void;
      onOpenThread?(listener: (payload: { agentId?: string; threadId?: string }) => void): () => void;
      isFocused?(): boolean;
      setWindowControls?(colors: { color: string; symbolColor: string }): void;
    };
  }
}

export function folderName(folder: string): string {
  return folder.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || folder;
}

/**
 * Asks for one folder: the native picker in the desktop app, a typed path in a plain browser.
 * Resolves undefined when the user cancels.
 */
export async function chooseFolder(): Promise<string | undefined> {
  const picker = window.saturnDesktop?.pickFolders;
  if (picker) return (await picker({ title: "Open Project Folder", multiple: false }))[0];
  const typed = window.prompt("Folder to open as a project (absolute path or ~/...)");
  return typed?.trim() || undefined;
}

/**
 * The consent step before agents may touch a folder: what they will be able to do there, and an explicit
 * Allow. Nothing in the folder is read by an agent until this is confirmed.
 */
export function AccessDialog(props: { path: string; name?: string; onAllow: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = props.name || folderName(props.path);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [props.onClose]);

  async function allow() {
    setBusy(true);
    try {
      await props.onAllow();
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the folder");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div className="modal-dialog workspace-modal" role="dialog" aria-modal="true" aria-labelledby="access-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="workspace-modal-head">
          <div>
            <h3 id="access-title">Allow access to “{name}”?</h3>
            <p>Agents in this project work inside this folder.</p>
          </div>
        </div>
        <div className="workspace-modal-body">
          <div className="workspace-folders">
            <div className="workspace-folder">
              <FolderIcon />
              <div className="workspace-folder-text">
                <span className="workspace-folder-name">{name}</span>
                <span className="workspace-folder-path">{props.path}</span>
              </div>
            </div>
          </div>
          <ul className="access-list">
            <li>Read the files in this folder and its subfolders</li>
            <li>Create, change and delete files there</li>
            <li>Run commands with this folder as the working directory</li>
          </ul>
          <p className="access-note">You can revoke access any time from the project's menu. macOS may also ask once to let Saturn read this location.</p>
          {error ? <p className="workspace-error" role="alert">{error}</p> : null}
        </div>
        <div className="workspace-modal-foot">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn primary-btn" disabled={busy} autoFocus onClick={() => void allow()}>
            {busy ? "Opening…" : "Allow Access"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.5h5.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function EditWorkspaceDialog(props: {
  project: Project;
  onSave: (patch: { name: string; description?: string; folders?: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.project.name);
  const [folders, setFolders] = useState<string[]>(
    props.project.folders && props.project.folders.length > 0 ? props.project.folders : [props.project.path],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [props.onClose]);

  async function save() {
    if (!name.trim()) {
      setError("Workspace name cannot be empty");
      return;
    }
    if (folders.length === 0) {
      setError("At least one folder is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await props.onSave({ name: name.trim(), folders });
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to save workspace");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div
        className="modal-dialog workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-workspace-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div>
            <h3 id="edit-workspace-title">Edit Workspace</h3>
            <p>Configure project name and folder paths.</p>
          </div>
        </div>
        <div className="workspace-modal-body">
          <div className="workspace-label">Workspace name</div>
          <input
            type="text"
            className="workspace-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            autoFocus
          />

          <div className="workspace-label">Folders</div>
          <div className="workspace-folders">
            {folders.map((folder, idx) => (
              <div key={folder} className="workspace-folder">
                <FolderIcon />
                <div className="workspace-folder-text">
                  <span className="workspace-folder-name">
                    {folderName(folder)}
                    {idx === 0 ? <span className="workspace-primary">Primary</span> : null}
                  </span>
                  <span className="workspace-folder-path">{folder}</span>
                </div>
                {folders.length > 1 ? (
                  <button
                    type="button"
                    className="workspace-folder-remove"
                    title="Remove folder"
                    onClick={() => setFolders((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <TrashIcon />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className="workspace-folder workspace-add"
              onClick={async () => {
                const added = await chooseFolder();
                if (added && !folders.includes(added)) {
                  setFolders((prev) => [...prev, added]);
                }
              }}
            >
              <PlusSmallIcon />
              <div className="workspace-folder-text">
                <span className="workspace-folder-name">Add Folder…</span>
              </div>
            </button>
          </div>

          {error ? <p className="workspace-error" role="alert">{error}</p> : null}
        </div>
        <div className="workspace-modal-foot">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary-btn"
            disabled={busy || !name.trim() || folders.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusSmallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.75h4V4M4 4l.7 9.25h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

