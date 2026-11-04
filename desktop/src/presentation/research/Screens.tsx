import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonText,
  lineageOrder,
  runStatusLabel,
  sampleText,
  type AcrossRow,
  type Comparison,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FrozenVersion,
  type Hypothesis,
  type ModelNode,
  type ModelRole,
  type Question,
  type ResearchEvent,
  type RunLabels,
  type Verdict,
} from "../../domain/research.js";

const service = desktop.research;
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];
const LABELS = ["Correct", "Wrong", "Invalid", "Unsure"];
const EVALUATION_FIELDS = ["dataset", "split", "sampleSet", "scorer", "promptFormat", "chatTemplate"] as const;

/** A failure's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads something when a screen opens and on every change to the records, with what went wrong if it failed. */
function useRecords<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setValue(await load());
      setProblem(null);
    } catch (error) {
      setProblem(messageOf(error));
    }
    // `load` is rebuilt each render from values that do not change while a screen is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
    return desktop.live.onResearchChange(() => void refresh());
  }, [refresh]);
  return { value, problem, setProblem, refresh };
}

function Problem(props: { message: string | null }) {
  return props.message ? (
    <div className="research-notice" role="alert">
      {props.message}
    </div>
  ) : null;
}

/** Where the work stopped: the newest run and finding, and what is still undecided. */
export function ProjectHome(props: { projectId: string; onContinue: () => void }) {
  const { projectId } = props;
  const { value, problem, setProblem, refresh } = useRecords(async () => ({
    questions: (await service.questions(projectId)).items as Question[],
    hypotheses: (await service.hypotheses(projectId)).items as Hypothesis[],
    runs: (await service.runs(projectId)).items as ExperimentRun[],
    findings: (await service.findings(projectId)).items as Finding[],
    events: (await service.events(projectId)).items as ResearchEvent[],
  }));
  const [question, setQuestion] = useState("");
  const [hypothesis, setHypothesis] = useState("");

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const lastRun = value?.runs[value.runs.length - 1];
  const lastFinding = value?.findings[value.findings.length - 1];
  const undecided = value?.hypotheses.filter((item) => item.verdict === "undecided").length ?? 0;
  const alerts = value?.events.filter((event) => event.kind !== "assisted").length ?? 0;

  return (
    <div className="research-page">
      <Problem message={problem} />
      <h2>Pick up where the work stopped</h2>
      {lastFinding ? <p>Latest note: {lastFinding.text}</p> : <p className="research-note">No findings yet. Write what you understand as you go.</p>}
      <div className="research-form">
        <button type="button" className="btn primary-btn" onClick={props.onContinue}>
          Continue in the workspace
        </button>
      </div>

      <h3>Where it stands</h3>
      <div className="research-row">
        <span>Latest run</span>
        <span className="research-muted">{lastRun ? `${runStatusLabel(lastRun.status)}, ${lastRun.samples ?? 0} samples` : "None yet"}</span>
      </div>
      <div className="research-row">
        <span>Undecided hypotheses</span>
        <span className="research-muted">{undecided}</span>
      </div>
      <div className="research-row">
        <span>Things to look at under Protection</span>
        <span className="research-muted">{alerts}</span>
      </div>

      <h3>Questions</h3>
      {value?.questions.map((item) => (
        <div className="research-row" key={item.id}>
          <span>{item.title}</span>
        </div>
      ))}
      <form
        className="research-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) void act(async () => { await service.addQuestion(projectId, question.trim()); setQuestion(""); });
        }}
      >
        <label className="research-field">
          <span>New question</span>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={!question.trim()}>
          Add
        </button>
      </form>

      <h3>Hypotheses</h3>
      <p className="research-note">A verdict is yours to set. A run that completes says only that it executed.</p>
      {value?.hypotheses.map((item) => (
        <div className="research-row" key={item.id}>
          <span>{item.title}</span>
          <label className="research-field">
            <span className="research-muted">Verdict</span>
            <select value={item.verdict} onChange={(event) => void act(() => service.setVerdict(projectId, item, event.target.value as Verdict))}>
              {VERDICTS.map((verdict) => (
                <option key={verdict} value={verdict}>
                  {verdict[0].toUpperCase() + verdict.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
      <form
        className="research-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (hypothesis.trim()) void act(async () => { await service.addHypothesis(projectId, hypothesis.trim(), value?.questions[value.questions.length - 1]?.id); setHypothesis(""); });
        }}
      >
        <label className="research-field">
          <span>New hypothesis</span>
          <input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={!hypothesis.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/** Checkpoints and their branches. Saturn records where weights are; it does not copy them. */
export function LineageScreen(props: { projectId: string }) {
  const { projectId } = props;
  const { value, problem, setProblem, refresh } = useRecords(async () => (await service.models(projectId)).items as ModelNode[]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ source: "", name: "", weightsRevision: "", parentId: "", trainingData: "" });
  const models = value ?? [];
  const current = models.find((item) => item.id === selected);

  async function add() {
    try {
      const added = await service.addModel(projectId, {
        source: form.source.trim(),
        name: form.name.trim() || undefined,
        weightsRevision: form.weightsRevision.trim() || undefined,
        parentId: form.parentId || undefined,
        trainingData: form.trainingData.trim() || undefined,
      });
      setForm({ source: "", name: "", weightsRevision: "", parentId: form.parentId, trainingData: "" });
      setSelected(added.id);
      await refresh();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const field = (key: keyof typeof form, label: string) => (
    <label className="research-field">
      <span>{label}</span>
      <input value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </label>
  );

  return (
    <div className="research-page">
      <Problem message={problem} />
      <h2>Model lineage</h2>
      <p className="research-note">From checkpoints to fine-tuned and preference-trained branches. A role such as base or policy belongs to how an experiment uses a model.</p>
      {lineageOrder(models).map(({ model, depth }) => (
        <button
          type="button"
          key={model.id}
          aria-pressed={selected === model.id}
          className={selected === model.id ? "research-tree-item active" : "research-tree-item"}
          style={{ paddingLeft: 10 + depth * 20 }}
          onClick={() => setSelected(model.id)}
        >
          <strong>{model.name || model.source}</strong>{" "}
          {model.floating ? <span className="research-pill">No fixed revision</span> : <span className="research-muted">{model.weightsRevision}</span>}
        </button>
      ))}
      {models.length === 0 ? <p className="research-muted">No models yet.</p> : null}

      {current ? (
        <>
          <h3>{current.name || current.source}</h3>
          <div className="research-row"><span>Source</span><code>{current.source}</code></div>
          <div className="research-row"><span>Parent</span><span className="research-muted">{models.find((item) => item.id === current.parentId)?.source ?? "None"}</span></div>
          <div className="research-row"><span>Training data</span><span className="research-muted">{current.trainingData ?? "Not recorded"}</span></div>
          <p className="research-note">Features from different models are not treated as the same until you record how they were aligned and test them with an intervention.</p>
        </>
      ) : null}

      <h3>Add a model</h3>
      <form
        className="research-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (form.source.trim()) void add();
        }}
      >
        {field("source", "Source (name or local path)")}
        {field("name", "Name")}
        {field("weightsRevision", "Revision")}
        {field("trainingData", "Training data")}
        <label className="research-field">
          <span>Parent</span>
          <select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
            <option value="">None</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.source}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn" disabled={!form.source.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/** What an experiment measures, its frozen versions and runs, and whether two versions can be compared. */
export function ExperimentScreen(props: { projectId: string }) {
  const { projectId } = props;
  const { value, problem, setProblem, refresh } = useRecords(async () => ({
    drafts: (await service.experiments(projectId)).items as ExperimentDraft[],
    versions: (await service.versions(projectId)).items as FrozenVersion[],
    runs: (await service.runs(projectId)).items as ExperimentRun[],
    models: (await service.models(projectId)).items as ModelNode[],
  }));
  const [selected, setSelected] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [binding, setBinding] = useState<{ modelId: string; role: ModelRole }>({ modelId: "", role: "base" });
  const [compared, setCompared] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const drafts = value?.drafts ?? [];
  const draft = drafts.find((item) => item.id === selected) ?? drafts[drafts.length - 1];
  const spec = ((draft as (ExperimentDraft & { evaluation?: Record<string, unknown> }) | undefined)?.evaluation ?? {}) as Record<string, unknown>;
  const bound = ((draft as (ExperimentDraft & { models?: { modelId: string; role: ModelRole }[] }) | undefined)?.models ?? []);
  const versions = (value?.versions ?? []).filter((item) => item.experimentId === draft?.id);
  const runs = (value?.runs ?? []).filter((item) => item.experimentId === draft?.id);

  async function saveEvaluation() {
    if (!draft) return;
    // An empty chat template field states that there is none, which is different from not saying.
    const evaluation: Record<string, unknown> = { generation: {}, chatTemplate: null, ...spec };
    for (const key of EVALUATION_FIELDS) {
      if (key in edits) evaluation[key] = edits[key] === "" && key === "chatTemplate" ? null : edits[key];
    }
    try {
      await service.updateExperiment(projectId, draft, { evaluation, models: bound } as Partial<ExperimentDraft>);
      setEdits({});
      await refresh();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  async function bindModel() {
    if (!draft || !binding.modelId) return;
    try {
      await service.updateExperiment(projectId, draft, { models: [...bound, binding] } as Partial<ExperimentDraft>);
      setBinding({ modelId: "", role: "base" });
      await refresh();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  async function toggleCompared(version: string) {
    const next = compared.includes(version) ? compared.filter((item) => item !== version) : [...compared, version].slice(-2);
    setCompared(next);
    setComparison(null);
    if (next.length === 2) {
      try {
        setComparison(await service.compare(projectId, next[0], next[1]));
      } catch (error) {
        setProblem(messageOf(error));
      }
    }
  }

  return (
    <div className="research-page">
      <Problem message={problem} />
      <h2>Experiments</h2>
      {drafts.length === 0 ? <p className="research-note">Running a command in the workspace creates the first experiment.</p> : null}
      {drafts.map((item) => (
        <button type="button" key={item.id} aria-pressed={item.id === draft?.id} className={item.id === draft?.id ? "research-tree-item active" : "research-tree-item"} onClick={() => setSelected(item.id)}>
          <strong>{item.title}</strong> <code className="research-muted">{item.command}</code>
        </button>
      ))}
      {draft ? (
        <>
          <h3>How it measures</h3>
          <p className="research-note">Two runs compare only when all of this matches. Training data is not part of it.</p>
          <div className="research-form">
            {EVALUATION_FIELDS.map((key) => (
              <label className="research-field" key={key}>
                <span>{key === "sampleSet" ? "Sample set" : key === "promptFormat" ? "Prompt format" : key === "chatTemplate" ? "Chat template (empty for none)" : key[0].toUpperCase() + key.slice(1)}</span>
                <input value={edits[key] ?? String(spec[key] ?? "")} onChange={(event) => setEdits({ ...edits, [key]: event.target.value })} />
              </label>
            ))}
            <button type="button" className="btn" onClick={() => void saveEvaluation()}>
              Save
            </button>
          </div>

          <h3>Models</h3>
          {bound.map((item) => (
            <div className="research-row" key={`${item.modelId}-${item.role}`}>
              <span>{value?.models.find((model) => model.id === item.modelId)?.name ?? value?.models.find((model) => model.id === item.modelId)?.source ?? item.modelId}</span>
              <span className="research-muted">{item.role}</span>
            </div>
          ))}
          <div className="research-form">
            <label className="research-field">
              <span>Model</span>
              <select value={binding.modelId} onChange={(event) => setBinding({ ...binding, modelId: event.target.value })}>
                <option value="">Choose</option>
                {value?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.source}
                  </option>
                ))}
              </select>
            </label>
            <label className="research-field">
              <span>Role</span>
              <select value={binding.role} onChange={(event) => setBinding({ ...binding, role: event.target.value as ModelRole })}>
                <option value="base">Base</option>
                <option value="reference">Reference</option>
                <option value="policy">Policy</option>
              </select>
            </label>
            <button type="button" className="btn" disabled={!binding.modelId} onClick={() => void bindModel()}>
              Add
            </button>
          </div>

          <h3>Frozen versions</h3>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr><th scope="col">Compare</th><th scope="col">Version</th><th scope="col">Runs</th><th scope="col">Created</th></tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td><input type="checkbox" aria-label={`Compare version ${version.number}`} checked={compared.includes(version.id)} onChange={() => void toggleCompared(version.id)} /></td>
                    <td>v{version.number}</td>
                    <td>{runs.filter((run) => run.versionId === version.id).length}</td>
                    <td>{new Date(version.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison ? <div className={comparison.result === "comparable" ? "research-muted" : "research-warning"}>{comparisonText(comparison)}</div> : null}

          <h3>Runs</h3>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr><th scope="col">Run</th><th scope="col">Version</th><th scope="col">Execution</th><th scope="col">Samples</th></tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run) => (
                  <tr key={run.id}>
                    <td><code>{run.id}</code></td>
                    <td>v{versions.find((version) => version.id === run.versionId)?.number ?? "?"}</td>
                    <td>{runStatusLabel(run.status)}{run.inputsChanged?.length ? `, ${run.inputsChanged.length} inputs changed during it` : ""}</td>
                    <td>{run.samples ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One sample across runs, and a person's label on it, which never overwrites a score. */
export function SampleScreen(props: { projectId: string }) {
  const { projectId } = props;
  const { value, problem, setProblem } = useRecords(async () => (await service.runs(projectId)).items as ExperimentRun[]);
  const runs = value ?? [];
  const [chosen, setChosen] = useState<string[]>([]);
  const [sampleId, setSampleId] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [rows, setRows] = useState<AcrossRow[] | null>(null);
  const [labels, setLabels] = useState<Record<string, RunLabels>>({});
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  async function toggleRun(run: string) {
    const next = chosen.includes(run) ? chosen.filter((item) => item !== run) : [...chosen, run];
    setChosen(next);
    setRows(null);
    if (next.length && !known.length) {
      try {
        const page = await service.samples(projectId, next[0]);
        setKnown(page.items.flatMap((item) => (item.sample ? [item.sample.sampleId] : [])));
      } catch (error) {
        setProblem(messageOf(error));
      }
    }
  }

  async function show(sample = sampleId) {
    if (!sample.trim() || !chosen.length) return;
    try {
      setSampleId(sample);
      setSaved(null);
      setRows((await service.sampleAcross(projectId, sample.trim(), chosen)).rows);
      const loaded: Record<string, RunLabels> = {};
      for (const run of chosen) loaded[run] = await service.labels(projectId, run);
      setLabels(loaded);
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  async function label(run: string, line: AcrossRow["samples"][number], value: string) {
    try {
      await service.setLabel(projectId, run, line, value);
      setLabels({ ...labels, [run]: await service.labels(projectId, run) });
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const labelOf = (run: string, line: AcrossRow["samples"][number]) =>
    Object.values(labels[run]?.labels ?? {}).find((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null))?.label;

  return (
    <div className="research-page">
      <Problem message={problem} />
      <h2>Samples across runs</h2>
      <p className="research-note">Model output is data. It is shown as plain text and never read as instructions. A label never overwrites a score.</p>
      <h3>Runs</h3>
      {runs.map((run) => (
        <label className="research-row" key={run.id}>
          <span><code>{run.id}</code> <span className="research-muted">{runStatusLabel(run.status)}</span></span>
          <input type="checkbox" checked={chosen.includes(run.id)} onChange={() => void toggleRun(run.id)} />
        </label>
      ))}
      {runs.length === 0 ? <p className="research-muted">No runs yet.</p> : null}
      <form
        className="research-form"
        onSubmit={(event) => {
          event.preventDefault();
          void show();
        }}
      >
        <label className="research-field">
          <span>Sample</span>
          <input list="research-known-samples" value={sampleId} onChange={(event) => setSampleId(event.target.value)} spellCheck={false} />
          <datalist id="research-known-samples">
            {known.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>
        <button type="submit" className="btn" disabled={!sampleId.trim() || !chosen.length}>
          Show
        </button>
      </form>

      {rows ? (
        <>
          <h3>{sampleId}</h3>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr><th scope="col">Run</th><th scope="col">Compared with the first</th><th scope="col">Output</th><th scope="col">Scores</th><th scope="col">Your label</th></tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.samples.length === 0 ? (
                    <tr key={row.runId}><td><code>{row.runId}</code></td><td colSpan={4} className="research-muted">This run has no such sample.</td></tr>
                  ) : (
                    row.samples.map((line) => (
                      <tr key={`${row.runId}-${line.trial ?? 0}-${line.modelId ?? ""}`}>
                        <td><code>{row.runId}</code>{row.models?.length ? <div className="research-muted">{row.models.map((model) => `${model.role}: ${model.source}`).join(", ")}</div> : null}</td>
                        <td className={row.comparison.result === "comparable" ? "research-muted" : "research-warning"}>{comparisonText(row.comparison)}</td>
                        <td><pre className="research-text">{sampleText(line.output)}</pre></td>
                        <td><pre className="research-text">{sampleText(line.scores)}</pre>{line.error ? <div className="research-warning">{line.error.kind} error</div> : null}</td>
                        <td>
                          <select aria-label={`Your label for ${row.runId}`} value={labelOf(row.runId, line) ?? ""} onChange={(event) => void label(row.runId, line, event.target.value)}>
                            <option value="" disabled>Choose</option>
                            {LABELS.map((item) => <option key={item} value={item}>{item}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))
                  ),
                )}
              </tbody>
            </table>
          </div>
          {chosen.map((run) => labels[run]).filter(Boolean).slice(0, 1).map((item) => (
            <p key="agreement" className="research-muted">
              First run: {item.agreement.labeled} labeled, {item.agreement.agreed} of {item.agreement.compared} that the scorer labeled agree with it.
            </p>
          ))}
          <div className="research-form">
            <label className="research-field">
              <span>Why keep this sample</span>
              <input value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void service
                  .addCounterexample(projectId, chosen[0], sampleId.trim(), note)
                  .then(() => {
                    setNote("");
                    setSaved("Saved as a counterexample.");
                  })
                  .catch((error: unknown) => setProblem(messageOf(error)));
              }}
            >
              Save as counterexample
            </button>
            {saved ? <span className="research-muted">{saved}</span> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What agents were refused or what changed, and plainly what each backend can and cannot enforce. */
export function ProtectionScreen(props: { projectId: string }) {
  const { value, problem } = useRecords(async () => (await service.events(props.projectId)).items as ResearchEvent[]);
  const events = [...(value ?? [])].reverse();
  return (
    <div className="research-page">
      <Problem message={problem} />
      <h2>Protection</h2>
      <p className="research-note">Modes and locks keep an agent to how you want to work. They are not a security boundary: a shell or another program can still write a file, and that is only noticed afterwards.</p>

      <h3>What has happened</h3>
      {events.length === 0 ? <p className="research-muted">Nothing yet.</p> : null}
      {events.map((event, index) => (
        <div className="research-row" key={`${event.at}-${index}`}>
          <span>
            {event.kind === "refused" ? <>Refused: {event.reason}</> : null}
            {event.kind === "integrity_changed" ? <>Changed, by someone or something: {event.paths.join(", ")} (noticed after {event.afterTool})</> : null}
            {event.kind === "assisted" ? <>You accepted a change to {event.path}</> : null}
          </span>
          <span className="research-muted">{new Date(event.at).toLocaleString()}</span>
        </div>
      ))}

      <h3>What each backend can enforce</h3>
      <div className="research-table-wrap">
        <table className="research-table">
          <thead>
            <tr><th scope="col">Backend</th><th scope="col">File tools</th><th scope="col">Anything else</th></tr>
          </thead>
          <tbody>
            <tr><td>API and local models</td><td>Refused before writing</td><td>Compared afterwards</td></tr>
            <tr><td>Claude Code</td><td>Refused for the tools it asks about</td><td>Compared afterwards</td></tr>
            <tr><td>Codex</td><td>Cannot be refused per file</td><td>Compared after its turn</td></tr>
            <tr><td>MCP tools</td><td>Saturn cannot tell what they write</td><td>Compared afterwards</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
