import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { ArtifactContent, ResearchArtifact } from "../../domain/research.js";
import { artifactsInContext } from "../../domain/research.js";
import type { Screen } from "../shell/navigation.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

/** Analysis outputs from scripts and notebooks are kept beside their sources, without executing previews. */
export function Artifacts(props: { projectId: string; runId?: string; inspectionId?: string; notify: (message: string) => void; go: (screen: Screen) => void }) {
  const { value, refresh } = useRecords(() => desktop.research.artifacts(props.projectId), props.notify);
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<ResearchArtifact["kind"]>("json");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ResearchArtifact | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [all, setAll] = useState(false);
  const items = artifactsInContext(value?.items ?? [], props.runId, props.inspectionId, all);
  async function register(manifest: boolean) {
    setBusy(true);
    try {
      if (manifest && props.runId) await desktop.research.importArtifactManifest(props.projectId, props.runId);
      else await desktop.research.registerArtifact(props.projectId, { kind, ...(path ? { path } : {}), ...(uri ? { uri } : {}), ...(props.runId ? { runId: props.runId } : {}), ...(props.inspectionId ? { inspectionId: props.inspectionId } : {}) });
      await refresh(); props.notify("Analysis outputs recorded. Original files were left unchanged.");
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  async function preview(item: ResearchArtifact) {
    setBusy(true); setSelected(item); setContent(null);
    try { if (item.packaged) setContent(await desktop.research.artifactContent(props.projectId, item.id)); }
    catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  let shown = "";
  if (content && selected?.kind !== "figure") {
    const bytes = Uint8Array.from(atob(content.data), (character) => character.charCodeAt(0));
    shown = new TextDecoder().decode(bytes).slice(0, 100_000);
  }
  return <details className="my-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Analysis outputs ({items.length})</summary>
    <p className="my-2 text-xs text-muted-foreground">Keep figures, JSON from TransformerLens/NNsight/SAELens, or notebooks with a content hash. Snapshots are limited to 16 MiB; large activation stores and weights remain references. Previews do not run code or HTML.</p>
    {props.runId || props.inspectionId ? <div className="mb-2"><Choice label="Browse outputs" value={all ? "all" : "context"} options={[{ value: "context", label: "This run or session" }, { value: "all", label: "All project outputs" }]} onChange={(value) => { setAll(value === "all"); setSelected(null); setContent(null); }} />{all ? <p className="mt-1 text-xs text-muted-foreground">New outputs are still linked to the current run or session.</p> : null}</div> : null}
    <div className="flex flex-wrap items-end gap-2"><Choice label="Output kind" value={kind} options={[{ value: "json", label: "Analysis JSON" }, { value: "figure", label: "PNG / JPEG / WebP" }, { value: "notebook", label: "Notebook snapshot" }, { value: "reference", label: "External or large-file reference" }]} onChange={(value) => setKind(value as ResearchArtifact["kind"])} />
      <Field label="Project file" className="min-w-48 flex-1"><Input value={path} placeholder="analysis/results.json" onChange={(event) => setPath(event.target.value)} /></Field>
      {kind === "reference" ? <Field label="External URI instead of a file" className="min-w-48 flex-1"><Input value={uri} placeholder="s3://bucket/activations" onChange={(event) => setUri(event.target.value)} /></Field> : null}
      <Button disabled={busy || (!path && !uri)} onClick={() => void register(false)}>Keep output</Button>
      {props.runId ? <Button variant="outline" disabled={busy} onClick={() => void register(true)}>Import run artifact manifest</Button> : null}
    </div>
    <div className="my-2 flex flex-wrap gap-2">{items.map((item) => <Button key={item.id} variant="ghost" disabled={busy} onClick={() => void preview(item)}>{item.title} · {item.kind}</Button>)}</div>
    {selected ? <section className="mt-2 rounded-md bg-panel p-3"><h3 className="text-sm font-medium">{selected.title}</h3><p className="my-1 break-all text-xs text-muted-foreground">{selected.sourcePath || selected.uri} · SHA-256 {selected.sha256 || "not supplied"}{selected.hashVerified ? " · verified at registration" : " · external contents unverified"}</p>
      {!selected.packaged ? <Notice tone="wait">Reference only. Its data has not been copied or downloaded.</Notice> : null}
      {content?.sourceChanged ? <Notice tone="wait">The original source changed or is unavailable. This preview is the saved snapshot.</Notice> : null}
      {content && content.sourceChanged === null ? <Notice>Copied from the remote host. Its source there is not compared again.</Notice> : null}
      {content && selected.kind === "figure" ? <img className="mt-2 max-h-96 max-w-full object-contain" alt={selected.title} src={`data:${content.mime};base64,${content.data}`} /> : null}
      {shown ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{shown}</pre> : null}
      {content && selected.kind !== "figure" ? <p className="mt-1 text-xs text-muted-foreground">Text preview shows at most 100,000 characters; the saved snapshot keeps all bytes.</p> : null}
      {selected.kind === "notebook" && selected.sourcePath && selected.sourceScope === "project" ? <Button className="mt-2" variant="outline" onClick={() => { desktop.research.open(props.projectId, { kind: "file", path: selected.sourcePath! }); props.go("Workspace"); }}>Open original notebook in Workspace</Button> : null}
    </section> : null}
  </details>;
}
