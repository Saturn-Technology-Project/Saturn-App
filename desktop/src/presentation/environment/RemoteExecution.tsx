import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import type { FrozenVersion, RemoteTarget, WorkerPairing } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

/** What a pairing found, in words. */
function pairingText(pairing: WorkerPairing): string {
  const where = `${pairing.host} (${pairing.system} ${pairing.machine})`;
  switch (pairing.state) {
    case "ready": return t("Saturn {version}'s worker is ready on {host}. Runs there use it.", { version: pairing.version, host: where });
    case "missing": return t("{host} has no worker for Saturn {version} yet.", { host: where, version: pairing.version });
    case "wrong_version": return t("The worker on {host} is not Saturn {version}{found}. Install the matching one.", { host: where, version: pairing.version, found: pairing.found ? ` (${pairing.found})` : "" });
    case "broken": return t("The worker on {host} did not answer: {reason}", { host: where, reason: pairing.reason ?? "" });
    case "unsupported": return pairing.reason ?? t("This host's system is not supported.");
  }
}

/**
 * Configures an existing SSH host and pairs with this Saturn's worker there. Connecting saves the host, finds the
 * worker and, when it is ready, uses it; when it is missing or another version, the person can install it, after
 * reading where it goes and where it comes from. Connecting never starts compute or changes host trust.
 */
export function RemoteTargetEditor(props: { projectId: string; notify: (text: string) => void }) {
  const { value, refresh } = useRecords(() => desktop.research.remoteTarget(props.projectId), props.notify);
  const [draft, setDraft] = useState<RemoteTarget | null>(null);
  const [busy, setBusy] = useState<"" | "connecting" | "installing">("");
  const [pairing, setPairing] = useState<WorkerPairing | null>(null);
  const [confirming, setConfirming] = useState(false);
  const target = draft ?? value?.target ?? { host: "", workdir: "", program: "saturn-server" };
  const change = (key: keyof RemoteTarget, text: string) => { setDraft({ ...target, [key]: text }); setPairing(null); setConfirming(false); };
  async function connect() {
    setBusy("connecting"); setPairing(null); setConfirming(false);
    try {
      await desktop.research.setRemoteTarget(props.projectId, target);
      setDraft(null);
      setPairing(await desktop.research.pairRemoteWorker(props.projectId));
      await refresh();
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(""); }
  }
  async function install() {
    setBusy("installing"); setConfirming(false);
    try {
      setPairing(await desktop.research.installRemoteWorker(props.projectId));
      await refresh();
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(""); }
  }
  const installable = pairing && (pairing.state === "missing" || pairing.state === "wrong_version" || pairing.state === "broken") && pairing.source;
  return <section className="my-4 rounded-lg border border-border p-3">
    <h2 className="mb-2 text-sm font-semibold">{t("Remote execution over SSH")}</h2>
    <p className="mb-2 text-xs text-muted-foreground">{t("Name a Linux or macOS host you can already sign in to with ssh, and the project's folder there; the code and data must already be in it. Connecting finds Saturn's worker on the host and can install it. SSH uses your existing configuration and known_hosts; Saturn stores no keys or passwords.")}</p>
    <div className="flex flex-wrap gap-2">
      <Field label={t("SSH host or user@host")} className="min-w-48 flex-1"><Input value={target.host} placeholder="gpu-box" onChange={(event) => change("host", event.target.value)} /></Field>
      <Field label={t("Existing remote project directory")} className="min-w-48 flex-1"><Input value={target.workdir} placeholder="/home/me/research" onChange={(event) => change("workdir", event.target.value)} /></Field>
    </div>
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t("Worker program")}</summary>
      <Field label={t("The saturn-server runs use on the host; connecting fills it in")} className="mt-1"><Input value={target.program} onChange={(event) => change("program", event.target.value)} /></Field>
    </details>
    <div className="mt-2 flex gap-2"><Button disabled={busy !== "" || !target.host || !target.workdir || !target.program} onClick={() => void connect()}>{busy === "connecting" ? t("Connecting…") : t("Connect")}</Button></div>
    {pairing ? <Notice tone={pairing.state === "ready" ? "good" : "wait"} className="mt-2">{pairingText(pairing)}{pairing.installed ? ` ${t("Installed and checked.")}` : ""}</Notice> : null}
    {installable && !confirming ? <Button className="mt-2" disabled={busy !== ""} onClick={() => setConfirming(true)}>{busy === "installing" ? t("Installing…") : t("Install worker")}</Button> : null}
    {installable && confirming ? <Notice tone="wait" className="mt-2">
      <p className="m-0">{t("Install Saturn {version}'s worker at {path} on {host}?", { version: pairing.version, path: pairing.path, host: pairing.host })}</p>
      <p className="m-0 mt-1 text-xs">{pairing.source === "this computer" ? t("It is this computer's own Saturn program, sent over ssh.") : t("It is downloaded from this version's GitHub release, checked against the hash built into this Saturn, and sent over ssh only if it matches.")} {t("It goes into your home folder, needs no administrator rights, and is hashed again on the host.")}</p>
      <div className="mt-2 flex gap-2"><Button onClick={() => void install()}>{t("Install")}</Button><Button variant="outline" onClick={() => setConfirming(false)}>{t("Cancel")}</Button></div>
    </Notice> : null}
  </section>;
}

/** Starts an explicit version remotely; the command itself owns loading any supplied resume checkpoint. */
export function RemoteRun(props: { projectId: string; versions: FrozenVersion[]; notify: (text: string) => void; onStarted: () => void }) {
  const [selected, setSelected] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [checkpoint, setCheckpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const versions = props.versions.filter((version) => !version.imported && !version.archived);
  const version = versions.find((version) => version.id === selected) ?? versions.at(-1);
  const seconds = Number(minutes) * 60;
  async function start() {
    if (!version) return;
    setBusy(true);
    try {
      const run = await desktop.research.startRemote(props.projectId, { versionId: version.id, clientId: crypto.randomUUID(), timeoutSeconds: seconds, ...(checkpoint.trim() ? { resumeFrom: checkpoint.trim() } : {}) });
      props.notify(t("Remote launch recorded: {run}. Closing Saturn detaches; Stop requests cancellation.", { run: run.id })); props.onStarted();
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <details className="my-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Run on the configured SSH host")}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t("Configure the host in Environment. Remote code is not uploaded or certified identical to these local frozen files. The remote worker records its working directory and git commit. Existing remote jobs keep their original target when settings change.")}</p>
    <div className="flex flex-wrap items-end gap-2"><Choice label={t("Executable version")} value={version?.id ?? ""} options={versions.map((item) => ({ value: item.id, label: `v${item.number} · ${item.kind ?? "evaluation"}` }))} onChange={setSelected} />
      <Field label={t("Wall-clock limit (minutes)")}><Input type="number" min={1} max={10080} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></Field>
      <Field label={t("Resume checkpoint on remote host (optional)")} className="min-w-48 flex-1"><Input value={checkpoint} onChange={(event) => setCheckpoint(event.target.value)} /></Field>
      <Button disabled={busy || !version || !Number.isInteger(seconds) || seconds < 60 || seconds > 604800} onClick={() => void start()}>{t("Start remote job")}</Button>
    </div>
    {version?.command ? <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">{version.command}</pre> : <p className="mt-2 text-xs text-muted-foreground">{t("Freeze an executable version above first.")}</p>}
    <p className="mt-2 text-xs text-muted-foreground">{t("The command receives SATURN_RESUME_FROM; its framework must restore model, optimizer and random state. A new attempt is a new run. The wall-clock limit stops the process group; it is not a guarantee of GPU billing.")}</p>
  </details>;
}
