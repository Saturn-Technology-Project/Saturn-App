import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop";
import { t } from "../../domain/i18n";
import { askToConfirm } from "../../infrastructure/confirm";
import { Button } from "../ui/base/Button.js";
import { RowDescription, RowLabel, RowText, SettingsRow } from "./Parts";

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

  const load = () => desktop.admin.snapshotStorage().then(setStorage, (reason) => props.onError(reason instanceof Error ? reason.message : t("Could not read the snapshots")));
  useEffect(() => {
    void load();
  }, []);

  async function remove(id?: string, folder?: string | null) {
    const question = !id
      ? t("Delete all folder snapshots? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.")
      : folder
        ? t("Delete the snapshots of {folder}? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.", { folder })
        : t("Delete the snapshots of this folder? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.");
    if (!await askToConfirm(question)) return;
    setBusy(true);
    try {
      await desktop.admin.deleteSnapshots(id);
      props.onError("");
      await load();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : t("Could not delete"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsRow>
        <RowText>
          <RowLabel>{t("Folder snapshots")}</RowLabel>
          <RowDescription>
            {t("For project folders outside git, Saturn keeps a private snapshot in its own data folder, so what a shell command changes can be reviewed and reverted.")}{" "}
            {storage
              ? storage.folders.length === 1
                ? t("1 folder, {size} in all.", { size: formatBytes(storage.bytes) })
                : t("{count} folders, {size} in all.", { count: storage.folders.length, size: formatBytes(storage.bytes) })
              : t("Reading…")}
          </RowDescription>
        </RowText>
        {storage?.folders.length ? (
          <Button type="button" variant="outline" size="small" disabled={busy} onClick={() => void remove()}>{t("Delete all")}</Button>
        ) : null}
      </SettingsRow>
      {storage?.folders.map((item) => (
        <SettingsRow key={item.id}>
          <RowText>
            <RowLabel className="font-mono text-xs break-words" title={item.folder ?? item.id}>{item.folder ?? t("Unknown folder ({id})", { id: item.id })}</RowLabel>
            <RowDescription>{formatBytes(item.bytes)}</RowDescription>
          </RowText>
          <Button type="button" variant="outline" size="small" disabled={busy} onClick={() => void remove(item.id, item.folder)}>{t("Delete")}</Button>
        </SettingsRow>
      ))}
    </>
  );
}
