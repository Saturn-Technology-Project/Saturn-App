import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { ResearchBundleExport, ResearchBundlePreview } from "../../domain/research.js";
import type { Screen } from "../shell/navigation.js";
import { Button } from "../ui/base/Button.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";

/** Portable evidence never restores permissions or starts an imported command, notebook or model. */
export function ResearchBundle(props: { projectId: string; notify: (message: string) => void; go: (screen: Screen) => void; onImported: () => void }) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<ResearchBundlePreview | null>(null);
  const [exported, setExported] = useState<ResearchBundleExport | null>(null);
  const [busy, setBusy] = useState(false);
  async function act(action: "export" | "preview" | "import") {
    setBusy(true);
    try {
      if (action === "export") setExported(await desktop.research.exportBundle(props.projectId, output.trim() || undefined));
      else if (action === "preview") setPreview(await desktop.research.previewBundle(props.projectId, input.trim()));
      else if (preview) {
        const result = await desktop.research.importBundle(props.projectId, input.trim(), preview.sha256);
        props.notify(`Imported ${result.imported} evidence files; reused ${result.reused}. Execution contexts are archived, and no permissions or remote settings were restored.`);
        setPreview(null); props.onImported();
      }
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <details className="my-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Portable project research bundle</summary>
    <p className="my-2 text-xs text-muted-foreground">Includes this project's research records, raw samples, labels, logs, metrics, inside results, saved source objects and analysis snapshots. Original weights, datasets, scorers and environments remain explicit external dependencies. This is evidence portability, not a promise that training can be reproduced on another machine.</p>
    <div className="flex flex-wrap items-end gap-2"><Field label="Export path in project (optional)" className="min-w-48 flex-1"><Input value={output} placeholder="exports/study.saturn.json (generated if empty)" onChange={(event) => setOutput(event.target.value)} /></Field><Button disabled={busy} onClick={() => void act("export")}>Export project bundle and reports</Button></div>
    {exported ? <Notice tone="good" className="my-2"><div className="break-all">Saved {exported.path}, {exported.markdownPath}, and {exported.htmlPath}. {exported.files} files; {exported.external.length} external references; {exported.unavailable.length} unavailable saved files.</div><Button variant="ghost" size="small" onClick={() => { desktop.research.open(props.projectId, { kind: "file", path: exported.markdownPath }); props.go("Workspace"); }}>Open Markdown report source</Button></Notice> : null}
    <div className="mt-3 flex flex-wrap items-end gap-2"><Field label="Bundle file inside this project" className="min-w-48 flex-1"><Input value={input} placeholder="incoming/study.saturn.json" onChange={(event) => { setInput(event.target.value); setPreview(null); }} /></Field><Button variant="outline" disabled={busy || !input.trim()} onClick={() => void act("preview")}>Validate and preview import</Button>{preview ? <Button disabled={busy} onClick={() => void act("import")}>Import evidence without overwriting</Button> : null}</div>
    {preview ? <div className="mt-2 text-xs"><p>{preview.files} files; {preview.activeRuns} active jobs will become archived interrupted evidence. External dependencies: {preview.external.length}; unavailable saved evidence: {preview.unavailable.length}.</p><p className="my-1 break-all">Package SHA-256: {preview.sha256}</p><Notice tone="wait">Import runs no commands, notebooks or models. Imported versions and inspection contexts are read-only; create a new local version or session to compute. Conflicts are rejected; a fresh project is recommended.</Notice><details className="mt-2"><summary>External and unavailable dependencies</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify({ external: preview.external, unavailable: preview.unavailable }, null, 2).slice(0, 50_000)}</pre></details></div> : null}
  </details>;
}
