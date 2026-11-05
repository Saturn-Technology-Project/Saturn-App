import { useState, useRef, type ReactNode } from "react";
import { Button } from "./ui/base/Button.js";
import { classes } from "./ui/base/classes.js";
import { Input } from "./ui/base/Input.js";
import { Notice } from "./ui/base/Notice.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/base/Dialog.js";
import type { Project } from "../domain/model";
import type { RuntimeStatus } from "../infrastructure/runtime-status";

declare global {
  interface Window {
    /** Exposed by preload.cjs in the desktop app; absent in a plain browser. */
    saturnDesktop?: {
      pickFolders(options?: { title?: string; multiple?: boolean }): Promise<string[]>;
      notify?(options: { title: string; body?: string; agentId?: string; threadId?: string; silent?: boolean }): void;
      onOpenThread?(listener: (payload: { agentId?: string; threadId?: string }) => void): () => void;
      isFocused?(): boolean;
      setWindowControls?(colors: { color: string; symbolColor: string }): void;
      setWindowTheme?(dark: boolean): void;
      runtimeStatus?(): Promise<RuntimeStatus>;
      restartRuntime?(): Promise<void>;
      setTitle?(title: string): Promise<void>;
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

/** What each folder in a list looks like: its icon, its name, and under that its path. */
const FOLDER_ROW = "flex w-full items-center gap-3 px-3 py-[11px] text-left text-[13.5px] text-foreground [&>svg]:shrink-0 [&>svg]:text-muted-foreground";

/** A list of folders with a line between them. */
function FolderList(props: { children: ReactNode }) {
  return <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-input">{props.children}</div>;
}

/** A folder's name and path, side by side with its icon and whatever follows. */
function FolderText(props: { name: ReactNode; path: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="flex items-center gap-2">{props.name}</span>
      <span className="truncate text-xs text-muted-foreground">{props.path}</span>
    </div>
  );
}

/**
 * The consent step before agents may touch a folder: what they will be able to do there, and an explicit
 * Allow. Nothing in the folder is read by an agent until this is confirmed.
 */
export function AccessDialog(props: { path: string; name?: string; onAllow: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = props.name || folderName(props.path);
  const allowButton = useRef<HTMLButtonElement>(null);

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
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent initialFocus={allowButton} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Allow access to “{name}”?</DialogTitle>
          <DialogDescription>Agents in this project work inside this folder.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <FolderList>
            <div className={FOLDER_ROW}>
              <FolderIcon />
              <FolderText name={name} path={props.path} />
            </div>
          </FolderList>
          <ul className="m-0 flex flex-col gap-1 pl-[18px] text-[13px] text-foreground">
            <li>Read the files in this folder and its subfolders</li>
            <li>Create, change and delete files there</li>
            <li>Run commands with this folder as the working directory</li>
          </ul>
          <p className="text-xs text-muted-foreground">You can revoke access any time from the project's menu. macOS may also ask once to let Saturn read this location.</p>
          {error ? <Notice tone="bad">{error}</Notice> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button ref={allowButton} disabled={busy} onClick={() => void allow()}>
            {busy ? "Opening…" : "Allow Access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const nameInput = useRef<HTMLInputElement>(null);

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
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent initialFocus={nameInput} className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[560px]">
        <DialogHeader className="px-4 pt-5 pb-1.5 sm:px-[22px]">
          <DialogTitle>Edit Workspace</DialogTitle>
          <DialogDescription>Configure project name and folder paths.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-5 sm:px-[22px]">
          <div className="mt-1.5 text-xs text-muted-foreground">Workspace name</div>
          <Input
            ref={nameInput}
            type="text"
            aria-label="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
          />

          <div className="mt-1.5 text-xs text-muted-foreground">Folders</div>
          <FolderList>
            {folders.map((folder, idx) => (
              <div key={folder} className={FOLDER_ROW}>
                <FolderIcon />
                <FolderText
                  name={
                    <>
                      {folderName(folder)}
                      {idx === 0 ? <span className="rounded-full border border-input px-1.5 text-[10.5px] text-muted-foreground">Primary</span> : null}
                    </>
                  }
                  path={folder}
                />
                {folders.length > 1 ? (
                  <Button
                    variant="ghost"
                    className="size-[26px] shrink-0 p-0 text-muted-foreground"
                    title="Remove folder"
                    aria-label="Remove folder"
                    onClick={() => setFolders((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              variant="ghost"
              className={classes(FOLDER_ROW, "h-auto justify-start rounded-none font-normal")}
              onClick={async () => {
                const added = await chooseFolder();
                if (added && !folders.includes(added)) {
                  setFolders((prev) => [...prev, added]);
                }
              }}
            >
              <PlusSmallIcon />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="flex items-center gap-2">Add Folder…</span>
              </div>
            </Button>
          </FolderList>

          {error ? <Notice tone="bad">{error}</Notice> : null}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3 sm:px-[22px]">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button
            disabled={busy || !name.trim() || folders.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

