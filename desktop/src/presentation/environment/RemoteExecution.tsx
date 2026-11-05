import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { FrozenVersion, RemoteTarget } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

/** Configures an existing SSH host; checking it never starts compute or changes host trust. */
export function RemoteTargetEditor(props: { projectId: string; notify: (text: string) => void }) {
  const { value, refresh } = useRecords(() => desktop.research.remoteTarget(props.projectId), props.notify);
  const [draft, setDraft] = useState<RemoteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState("");
  const target = draft ?? value?.target ?? { host: "", workdir: "", program: "saturn-server" };
  async function act(check: boolean) {
    setBusy(true); setChecked("");
    try {
      await desktop.research.setRemoteTarget(props.projectId, target);
      setDraft(null); await refresh();
      if (check) { const result = await desktop.research.checkRemoteTarget(props.projectId); setChecked(`Connected to ${result.platform}; worker protocol ${result.protocol}. Working directory: ${result.workdir}`); }
      else props.notify("Remote target saved. No computation was started.");
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <section className="my-4 rounded-lg border border-border p-3">
    <h2 className="mb-2 text-sm font-semibold">Remote execution over SSH</h2>
    <p className="mb-2 text-xs text-muted-foreground">Install the same version of saturn-server on your Linux or macOS host. Code and data must already be there. SSH uses your existing configuration and known_hosts; Saturn stores no keys or passwords.</p>
    <div className="flex flex-wrap gap-2">{([['host', 'SSH host or user@host', 'gpu-box'], ['workdir', 'Existing remote project directory', '/home/me/research'], ['program', 'Remote saturn-server', 'saturn-server']] as const).map(([key, label, placeholder]) => <Field key={key} label={label} className="min-w-48 flex-1"><Input value={target[key]} placeholder={placeholder} onChange={(event) => { setDraft({ ...target, [key]: event.target.value }); setChecked(""); }} /></Field>)}</div>
    <div className="mt-2 flex gap-2"><Button variant="outline" disabled={busy || !target.host || !target.workdir || !target.program} onClick={() => void act(false)}>Save target</Button><Button disabled={busy || !target.host || !target.workdir || !target.program} onClick={() => void act(true)}>Save and check connection</Button></div>
    {checked ? <Notice tone="good" className="mt-2">{checked}</Notice> : null}
  </section>;
}

/** Starts an explicit version remotely; the command itself owns loading any supplied resume checkpoint. */
export function RemoteRun(props: { projectId: string; versions: FrozenVersion[]; notify: (text: string) => void; onStarted: () => void }) {
  const [selected, setSelected] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [checkpoint, setCheckpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const versions = props.versions.filter((version) => !version.imported);
  const version = versions.find((version) => version.id === selected) ?? versions.at(-1);
  const seconds = Number(minutes) * 60;
  async function start() {
    if (!version) return;
    setBusy(true);
    try {
      const run = await desktop.research.startRemote(props.projectId, { versionId: version.id, clientId: crypto.randomUUID(), timeoutSeconds: seconds, ...(checkpoint.trim() ? { resumeFrom: checkpoint.trim() } : {}) });
      props.notify(`Remote launch recorded: ${run.id}. Closing Saturn detaches; Stop requests cancellation.`); props.onStarted();
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <details className="my-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Run on the configured SSH host</summary>
    <p className="my-2 text-xs text-muted-foreground">Configure the host in Environment. Remote code is not uploaded or certified identical to these local frozen files. The remote worker records its working directory and git commit. Existing remote jobs keep their original target when settings change.</p>
    <div className="flex flex-wrap items-end gap-2"><Choice label="Executable version" value={version?.id ?? ""} options={versions.map((item) => ({ value: item.id, label: `v${item.number} · ${item.kind ?? "evaluation"}` }))} onChange={setSelected} />
      <Field label="Wall-clock limit (minutes)"><Input type="number" min={1} max={10080} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></Field>
      <Field label="Resume checkpoint on remote host (optional)" className="min-w-48 flex-1"><Input value={checkpoint} onChange={(event) => setCheckpoint(event.target.value)} /></Field>
      <Button disabled={busy || !version || !Number.isInteger(seconds) || seconds < 60 || seconds > 604800} onClick={() => void start()}>Start remote job</Button>
    </div>
    {version?.command ? <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">{version.command}</pre> : <p className="mt-2 text-xs text-muted-foreground">Freeze an executable version above first.</p>}
    <p className="mt-2 text-xs text-muted-foreground">The command receives SATURN_RESUME_FROM; its framework must restore model, optimizer and random state. A new attempt is a new run. The wall-clock limit stops the process group; it is not a guarantee of GPU billing.</p>
  </details>;
}
