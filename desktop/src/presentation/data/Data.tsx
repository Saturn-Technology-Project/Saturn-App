import { useEffect, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop.js";
import { cellOf, cellText, dataFileState, distinctText, isReadable, overlapLeftOut, overlapText, parseColumns, rowColumns, sideName, spanText, testReadSummary, testReadText, usesHelper, type DataFile, type DataOverlap, type DataPage, type DataProfile, type DataRowItem } from "../../domain/data.js";
import { bytesText } from "../../domain/research.js";
import { Table } from "../home/Row.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf, Page, Tabs } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const VIEWS = ["Rows", "Profile", "Reads"] as const;
type View = (typeof VIEWS)[number];
const SECTION = "mt-3 flex flex-col gap-3 rounded-lg bg-card p-4";
const TITLE = "mt-0! text-sm font-semibold";
const MUTED = "text-xs text-muted-foreground";
const LEAD = "What your experiments read: which files, as frozen and as they are now, who used them, and what is in them.";

/** Something slow under way, said where the answer will be. */
function Loading(props: { children: ReactNode }) {
  return <div role="status" className={MUTED}>{props.children}</div>;
}

/** What a read could not do. When it needs the project's Python, it offers the way there. */
function Problem(props: { message: string; file?: DataFile; go: ScreenProps["go"] }) {
  const needsPython = props.file && usesHelper(props.file.format) && /Environment/.test(props.message);
  return (
    <>
      <Notice tone="bad">{props.message}</Notice>
      {needsPython ? <Button variant="outline" className="w-fit" onClick={() => props.go("Environment")}>Open Environment</Button> : null}
    </>
  );
}

/** The input data: every file an experiment named, then one file's rows and columns, and what two files share. */
export function Data(props: ScreenProps) {
  const projectId = props.project.id;
  const { value } = useRecords(
    async () => {
      try {
        return { list: await service.dataList(projectId), problem: null };
      } catch (error) {
        return { list: null, problem: messageOf(error) };
      }
    },
    props.notify,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const files = value?.list?.items ?? [];
  const file = files.find((item) => item.path === chosen) ?? null;

  if (!value) {
    return (
      <Page title="Data" lead={LEAD}>
        <section className={SECTION}><Loading>Reading the data files. A large file is hashed once when it changes, which can take a while.</Loading></section>
      </Page>
    );
  }
  if (value.problem) {
    return (
      <Page title="Data" lead={LEAD}>
        <div className="mt-3"><Notice tone="bad">{value.problem}</Notice></div>
      </Page>
    );
  }
  if (!files.length) {
    return (
      <Page title="Data" lead={LEAD}>
        <Empty title="No data inputs yet">Name a file under an experiment's data inputs, and it is listed here with who used it. Files you never name are not known here.</Empty>
      </Page>
    );
  }

  return (
    <Page title="Data" lead={LEAD}>
      <section className={SECTION} data-tour="data-files">
        <h2 className={TITLE}>Files named as data</h2>
        <Table label="Data files">
          <thead>
            <tr><th scope="col">File</th><th scope="col">Size</th><th scope="col">State</th><th scope="col">Experiments</th><th scope="col">Runs</th><th scope="col">Read as test</th></tr>
          </thead>
          <tbody>
            {files.map((item) => {
              const state = dataFileState(item);
              const open = item.path === chosen;
              return (
                <tr key={item.path} className={open ? "bg-(--selected)" : undefined}>
                  <td>
                    <button type="button" className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-left font-mono text-foreground underline-offset-2 hover:underline" aria-pressed={open} onClick={() => setChosen(open ? null : item.path)}>{item.path}</button>
                  </td>
                  <td className="whitespace-nowrap">{bytesText(item.size)}</td>
                  <td><Badge tone={state.tone} title={item.problem ?? undefined}>{state.label}</Badge></td>
                  <td>{item.experiments.length}</td>
                  <td>{item.runs.length}</td>
                  <td>{item.testReads > 0 ? <Badge tone="wait">{testReadSummary(item)}</Badge> : <span className={MUTED}>{testReadSummary(item)}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {value.list?.filesCapped ? <Notice tone="wait">A declared folder holds more files than are listed here. Name its parts to see them.</Notice> : null}
        <div className={MUTED}>Only files an experiment names are known here: a program can read a file it never names. "Read as test" counts runs whose version declared a test split, or whose file's name looks like one, which is not proof.</div>
      </section>
      {file ? <FileDetail key={file.path} projectId={projectId} file={file} go={props.go} /> : null}
      <OverlapCheck projectId={projectId} files={files} go={props.go} />
    </Page>
  );
}

/** One file: its rows, its columns, and the runs that read it. */
function FileDetail(props: { projectId: string; file: DataFile; go: ScreenProps["go"] }) {
  const { file } = props;
  const [view, setView] = useState<View>("Rows");
  const [split, setSplit] = useState("");
  const readable = isReadable(file);
  return (
    <section className={SECTION} data-tour="data-rows">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className={`${TITLE} font-mono [overflow-wrap:anywhere]`}>{file.path}</h2>
        <Tabs label="What to read" tabs={VIEWS} current={view} onChoose={setView} />
      </div>
      {file.problem ? <Notice tone="bad">{file.problem}</Notice> : null}
      {!file.problem && !file.exists ? <Notice tone="bad">This file is not in the project's folder now.{file.frozen ? " A version froze it, so a run of that version will refuse to start." : ""}</Notice> : null}
      {file.exists && !file.problem && file.format === "other" && view !== "Reads" ? <Notice>Saturn reads .jsonl, .json arrays, .csv and .tsv itself, and .parquet, .arrow and Hugging Face dataset folders through the project's Python. This file is none of these.</Notice> : null}
      {view === "Rows" && readable ? <RowsView key={split} projectId={props.projectId} file={file} split={split} onSplit={setSplit} go={props.go} /> : null}
      {view === "Profile" && readable ? <ProfileView key={split} projectId={props.projectId} file={file} split={split} onSplit={setSplit} go={props.go} /> : null}
      {view === "Reads" ? <ReadsView file={file} /> : null}
    </section>
  );
}

/** Which split of a dataset folder to read, when it has more than one. */
function SplitChoice(props: { splits: string[]; current: string | null; onSplit: (split: string) => void }) {
  if (props.splits.length < 2) return null;
  return <Choice label="Split" className="w-44" value={props.current ?? ""} options={props.splits.map((split) => ({ value: split, label: split }))} onChange={props.onSplit} />;
}

/** A file's rows, a page at a time. Whatever is in them is shown as plain text. */
function RowsView(props: { projectId: string; file: DataFile; split: string; onSplit: (split: string) => void; go: ScreenProps["go"] }) {
  const [page, setPage] = useState<DataPage | null>(null);
  const [items, setItems] = useState<DataRowItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const { projectId, file, split } = props;

  // A slow first page for a file no longer chosen is dropped.
  useEffect(() => {
    let wanted = true;
    service.dataPreview(projectId, file.path, 0, split || undefined)
      .then((first) => {
        if (!wanted) return;
        setPage(first);
        setItems(first.items);
      })
      .catch((error: unknown) => { if (wanted) setProblem(messageOf(error)); })
      .finally(() => { if (wanted) setBusy(false); });
    return () => { wanted = false; };
  }, [projectId, file.path, file.modifiedAt, split]);

  async function more() {
    if (page?.next === null || page?.next === undefined) return;
    setBusy(true);
    try {
      const next = await service.dataPreview(projectId, file.path, page.next, split || undefined);
      setPage(next);
      setItems((held) => [...held, ...next.items]);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (problem) return <Problem message={problem} file={file} go={props.go} />;
  if (!page) return <Loading>{usesHelper(file.format) ? "Asking the project's Python to open it…" : "Reading the first rows…"}</Loading>;
  const columns = rowColumns({ columns: page.columns, items });
  const shown = items[open ?? -1];
  return (
    <>
      <SplitChoice splits={page.splits} current={page.split} onSplit={props.onSplit} />
      {items.length ? (
        <Table label={`Rows of ${file.path}`}>
          <thead>
            <tr><th scope="col">Row</th>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.offset}>
                <td>
                  <button type="button" className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-muted-foreground underline-offset-2 hover:underline" aria-pressed={open === index} aria-label={`Show row ${index + 1} whole`} onClick={() => setOpen(open === index ? null : index)}>{index + 1}</button>
                </td>
                {item.problem ? (
                  <td colSpan={Math.max(columns.length, 1)} className="text-muted-foreground"><Badge tone="wait">Left out</Badge> {item.problem}</td>
                ) : columns.map((column) => <td key={column} className="min-w-24 whitespace-pre-wrap">{cellText(cellOf(item.row, column))}</td>)}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <div className={MUTED}>This file has no rows.</div>}
      {shown ? <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" aria-label={`Row ${(open ?? 0) + 1}, whole`}>{shown.problem ? `${shown.problem}\n\n${shown.raw ?? ""}` : JSON.stringify(shown.row, null, 2)}</pre> : null}
      <div className="flex flex-wrap items-center gap-3">
        {page.next !== null ? <Button variant="outline" size="small" disabled={busy} onClick={() => void more()}>{busy ? "Reading…" : "More rows"}</Button> : null}
        <span className={MUTED}>{items.length.toLocaleString("en-US")} shown{page.next === null ? ", the end of the file" : ""}. {page.note}</span>
      </div>
    </>
  );
}

/** What a file's columns hold, read through once and remembered until it changes. */
function ProfileView(props: { projectId: string; file: DataFile; split: string; onSplit: (split: string) => void; go: ScreenProps["go"] }) {
  const [profile, setProfile] = useState<DataProfile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { projectId, file, split } = props;

  useEffect(() => {
    let wanted = true;
    service.dataProfile(projectId, file.path, split || undefined)
      .then((answer) => { if (wanted) setProfile(answer); })
      .catch((error: unknown) => { if (wanted) setProblem(messageOf(error)); });
    return () => { wanted = false; };
  }, [projectId, file.path, file.modifiedAt, split]);

  if (problem) return <Problem message={problem} file={file} go={props.go} />;
  if (!profile) return <Loading>Reading the whole file, which takes as long as its size says. The answer is kept until it changes.</Loading>;
  const leftOut = [profile.malformed ? `${profile.malformed.toLocaleString("en-US")} malformed` : "", profile.tooLong ? `${profile.tooLong.toLocaleString("en-US")} too long` : ""].filter(Boolean).join(", ");
  return (
    <>
      <SplitChoice splits={profile.splits} current={profile.split} onSplit={props.onSplit} />
      <div>
        {profile.rows.toLocaleString("en-US")} rows, {profile.columns.length} columns{profile.columnsCapped ? " described, and more not" : ""}.
        {leftOut ? <span className={MUTED}> Left out: {leftOut}.</span> : null}
      </div>
      <Table label={`Columns of ${file.path}`}>
        <thead>
          <tr><th scope="col">Column</th><th scope="col">Holds</th><th scope="col">Missing</th><th scope="col">Different</th><th scope="col">Range</th><th scope="col">Most common</th></tr>
        </thead>
        <tbody>
          {profile.columns.map((column) => (
            <tr key={column.name}>
              <td className="font-mono">{column.name}</td>
              <td>{column.kind}</td>
              <td>{column.missing.toLocaleString("en-US")}</td>
              <td className="whitespace-nowrap">{distinctText(column)}</td>
              <td>{spanText(column)}</td>
              <td className="whitespace-pre-wrap">{column.common.map((common) => `${cellText(common.value, 60)} (${common.count.toLocaleString("en-US")})`).join("\n")}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className={MUTED}>{profile.note}{profile.columns.some((column) => column.distinctCapped) ? " Where the count of different values is \"at least\", the most common are among those seen before the limit." : ""}</div>
    </>
  );
}

/** Which runs read a file, and when: how a person checks how often test data was touched. */
function ReadsView(props: { file: DataFile }) {
  const { file } = props;
  return (
    <>
      <div className={MUTED}>
        {file.frozen ? `Frozen last by version ${file.frozen.number} of ${file.experiments.find((experiment) => experiment.id === file.frozen?.experimentId)?.title || "its experiment"} on ${new Date(file.frozen.frozenAt).toLocaleString()}, SHA-256 ${file.frozen.sha256.slice(0, 16)}…` : "No version has frozen this file."}
        {file.looksLikeTest ? " Its name looks like a test split, which is not proof." : ""}
      </div>
      {file.runs.length ? (
        <Table label={`Runs that read ${file.path}`}>
          <thead>
            <tr><th scope="col">When</th><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Is it test data?</th></tr>
          </thead>
          <tbody>
            {file.runs.map((run) => (
              <tr key={run.id}>
                <td className="whitespace-nowrap">{new Date(run.at).toLocaleString()}</td>
                <td className="font-mono">{run.id.slice(-8)}</td>
                <td>{run.status}</td>
                <td>{testReadText(run)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <div className={MUTED}>No run has read this file.</div>}
      {file.experiments.length ? <div className={MUTED}>Named by {file.experiments.map((experiment) => experiment.title || experiment.id).join(", ")}.</div> : null}
    </>
  );
}

/** Counts the rows two files share, to find leakage between splits. */
function OverlapCheck(props: { projectId: string; files: DataFile[]; go: ScreenProps["go"] }) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<DataOverlap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const options = props.files.filter(isReadable).map((file) => ({ value: file.path, label: file.path }));

  async function run() {
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    try {
      setAnswer(await service.dataOverlap(props.projectId, left, right, parseColumns(columns)));
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const leftOut = answer ? overlapLeftOut(answer) : "";
  const shared = Boolean(answer && (answer.left.inBoth || answer.right.inBoth));
  return (
    <section className={SECTION} data-tour="data-overlap">
      <h2 className={TITLE}>Do two files share rows?</h2>
      <div className={MUTED}>Counts rows identical in both, to find leakage between splits. It finds exact duplicates only: paraphrases and reformatted text are not found.</div>
      <div className="flex flex-wrap items-end gap-3">
        <Choice label="One file" className="w-56" placeholder="Choose a file" value={left} options={options} onChange={setLeft} />
        <Choice label="The other" className="w-56" placeholder="Choose a file" value={right} options={options} onChange={setRight} />
        <Field label="Only these columns, if any" className="w-52"><Input value={columns} placeholder="prompt, answer" onChange={(event) => setColumns(event.target.value)} /></Field>
        <Button disabled={busy || !left || !right} onClick={() => void run()}>{busy ? "Comparing…" : "Compare"}</Button>
      </div>
      {busy ? <Loading>Reading both files through, which takes as long as their size says.</Loading> : null}
      {problem ? <Problem message={problem} file={props.files.find((file) => usesHelper(file.format) && (file.path === left || file.path === right))} go={props.go} /> : null}
      {answer ? (
        <>
          <Notice tone={shared ? "wait" : "neutral"}>{overlapText(answer)}</Notice>
          {leftOut ? <div className={MUTED}>{leftOut}</div> : null}
          <div className={MUTED}>{sideName(answer.left)} against {sideName(answer.right)}. {answer.note}</div>
        </>
      ) : null}
    </section>
  );
}
