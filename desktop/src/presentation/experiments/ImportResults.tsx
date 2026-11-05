import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { ResearchImportPreview, ResearchImportRequest } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";

/** Brings a completed study in without requiring a question, hypothesis or a change to its training code. */
export function ImportResults(props: { projectId: string; onImported: (experiment: string) => void; notify: (text: string) => void }) {
  const [path, setPath] = useState("");
  const [format, setFormat] = useState("auto");
  const [identity, setIdentity] = useState("sampleId");
  const [input, setInput] = useState("input");
  const [output, setOutput] = useState("output");
  const [scores, setScores] = useState("");
  const [preview, setPreview] = useState<ResearchImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const request: ResearchImportRequest = { path, ...(format === "auto" ? {} : { format: format as ResearchImportRequest["format"] }), columns: { sampleId: identity, input, output }, scoreColumns: scores.split(",").map((name) => name.trim()).filter(Boolean) };
  const changed = (set: (value: string) => void) => (value: string) => { set(value); setPreview(null); };

  async function act(importing: boolean) {
    setBusy(true);
    try {
      if (importing && preview) {
        const made = await desktop.research.importResults(props.projectId, { ...request, expectedSha256: preview.provenance.sha256 });
        setPreview(null);
        props.onImported(made.experiment.id);
        props.notify("Imported. The original file was left unchanged; unstated provenance remains unknown.");
      } else setPreview(await desktop.research.previewImport(props.projectId, request));
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }

  return <details className="my-3 rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Import existing results</summary>
    <p className="my-2 text-xs text-muted-foreground">Read a file inside this project. No hypothesis or training-code change is required. Unknown model, environment and evaluation settings stay unknown.</p>
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Project file" className="min-w-48 flex-1"><Input value={path} placeholder="results/old.jsonl" onChange={(event) => changed(setPath)(event.target.value)} /></Field>
      <Choice label="Format" value={format} options={[{ value: "auto", label: "From extension" }, ...["jsonl", "json", "csv", "tsv", "trainer"].map((value) => ({ value, label: value === "trainer" ? "Trainer state JSON" : value.toUpperCase() }))]} onChange={changed(setFormat)} />
    </div>
    {format !== "trainer" ? <div className="my-2 flex flex-wrap gap-2">
      <Field label="Stable ID column" className="min-w-32 flex-1"><Input value={identity} onChange={(event) => changed(setIdentity)(event.target.value)} /></Field>
      <Field label="Input column" className="min-w-32 flex-1"><Input value={input} onChange={(event) => changed(setInput)(event.target.value)} /></Field>
      <Field label="Output column" className="min-w-32 flex-1"><Input value={output} onChange={(event) => changed(setOutput)(event.target.value)} /></Field>
      <Field label="Numeric score columns (comma separated)" className="min-w-48 flex-1"><Input value={scores} placeholder="accuracy, loss" onChange={(event) => changed(setScores)(event.target.value)} /></Field>
    </div> : null}
    <div className="mt-2 flex gap-2"><Button variant="outline" disabled={busy || !path.trim()} onClick={() => void act(false)}>Preview</Button>{preview ? <Button disabled={busy} onClick={() => void act(true)}>Import as new records</Button> : null}</div>
    {preview ? <div className="mt-2 text-xs">
      <p>{preview.samples} samples; {preview.metrics} training events. Source SHA-256: <code className="break-all">{preview.provenance.sha256}</code>.</p>
      {preview.provenance.identity === "row_number" ? <Notice tone="wait">Some IDs come from row positions. They do not establish identity across files.</Notice> : null}
      {preview.preview.length ? <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap">{JSON.stringify(preview.preview, null, 2)}</pre> : null}
    </div> : null}
  </details>;
}
