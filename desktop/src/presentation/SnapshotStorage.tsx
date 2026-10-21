import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";

type Storage = { folders: { id: string; folder: string | null; bytes: number }[]; bytes: number };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Settings → Storage: the private snapshots Saturn keeps of project folders outside git (to review and revert what
 * shell commands change there), with their size; each can be deleted, or all, after a confirmation.
 */
export function SnapshotStorage(props: { onError: (message: string) => void }) {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => desktop.admin.snapshotStorage().then(setStorage, (reason) => props.onError(reason instanceof Error ? reason.message : "Could not read the snapshots"));
  useEffect(() => {
    void load();
  }, []);

  async function remove(id?: string, folder?: string | null) {
    const what = id ? `the snapshots of ${folder ?? "this folder"}` : "all folder snapshots";
    if (!window.confirm(`Delete ${what}? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.`)) return;
    setBusy(true);
    try {
      await desktop.admin.deleteSnapshots(id);
      props.onError("");
      await load();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-card-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Folder snapshots</span>
          <span className="settings-row-desc">
            For project folders outside git, Saturn keeps a private snapshot in its own data folder, so what a shell command
            changes can be reviewed and reverted. {storage ? `${storage.folders.length} ${storage.folders.length === 1 ? "folder" : "folders"}, ${formatBytes(storage.bytes)} in all.` : "Reading…"}
          </span>
        </div>
        {storage?.folders.length ? (
          <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => void remove()}>Delete all</button>
        ) : null}
      </div>
      {storage?.folders.map((item) => (
        <div className="settings-card-row" key={item.id}>
          <div className="settings-row-text">
            <span className="settings-row-label snapshot-folder" title={item.folder ?? item.id}>{item.folder ?? `Unknown folder (${item.id})`}</span>
            <span className="settings-row-desc">{formatBytes(item.bytes)}</span>
          </div>
          <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => void remove(item.id, item.folder)}>Delete</button>
        </div>
      ))}
    </>
  );
}
