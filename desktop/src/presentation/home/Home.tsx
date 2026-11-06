import { useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { changedSince, lastActive, reviewProgress, runHasResults, runStatusLabel, type Hypothesis, type Verdict } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";
import { Heading, Row } from "./Row.js";
import { ImportResults } from "../experiments/ImportResults.js";
import { ResearchBundle } from "../experiments/ResearchBundle.js";
import { FirstStudy } from "./FirstStudy.js";

const service = desktop.research;
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];
const VERDICT_LABELS: Record<Verdict, string> = { undecided: t("Undecided"), supported: t("Supported"), refuted: t("Refuted"), inconclusive: t("Inconclusive") };
const VERDICT_OPTIONS = VERDICTS.map((verdict) => ({ value: verdict, label: VERDICT_LABELS[verdict] }));
const MUTED = "text-xs text-muted-foreground";

/** A moment in words, for saying when the work stopped. */
function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

/** Where the work stopped, what was restored, what changed since this device last looked, and what is still open. */
export function Home(props: ScreenProps) {
  const projectId = props.project.id;
  // The visit is marked once, when the screen opens, so the list says what changed since the time before.
  const [visited] = useState(() => service.visit(projectId));
  const [session] = useState(() => service.loadSession(projectId));
  const { value, refresh } = useRecords(
    async () => {
      const runs = (await service.runs(projectId)).items;
      const last = [...runs].reverse().find((run) => runHasResults(run.status)) ?? null;
      return {
        questions: (await service.questions(projectId)).items,
        hypotheses: (await service.hypotheses(projectId)).items,
        runs,
        findings: (await service.findings(projectId)).items,
        events: (await service.events(projectId)).items,
        review: last ? reviewProgress(await service.summary(projectId, last.id), await service.labels(projectId, last.id)) : null,
        lastWithResults: last,
        experiments: (await service.experiments(projectId)).items,
        // A project whose environment cannot be read is treated as not checked yet.
        environment: await service.environment(projectId).catch(() => null),
      };
    },
    props.notify,
  );
  const [question, setQuestion] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [studyHidden, setStudyHidden] = useState(() => Boolean(session.firstStudyHidden));
  const fields = { question: useRef<HTMLInputElement>(null), hypothesis: useRef<HTMLInputElement>(null) };
  const focusField = (field: "question" | "hypothesis") => {
    const input = fields[field].current;
    input?.scrollIntoView({ block: "center", behavior: "smooth" });
    input?.focus({ preventScroll: true });
  };
  const hideStudy = () => {
    setStudyHidden(true);
    service.saveSession(projectId, { ...service.loadSession(projectId), firstStudyHidden: true });
  };

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const lastRun = value?.runs.at(-1);
  const lastFinding = value?.findings.at(-1);
  const lastQuestion = value?.questions.at(-1);
  const undecided = value?.hypotheses.filter((item) => item.verdict === "undecided") ?? [];
  const alerts = value?.events.filter((event) => event.kind !== "assisted") ?? [];
  const troubled = value?.runs.filter((run) => run.status === "interrupted" || run.status === "failed" || run.status === "protocol_error") ?? [];
  const active = value ? lastActive([value.runs, value.findings, value.hypotheses, value.questions]) : null;
  const since = value
    ? [
        ...changedSince(value.runs, visited).map((run) => ({ key: run.id, at: run.updatedAt, text: t("Run {run}: {status}, {count} samples", { run: run.id, status: runStatusLabel(run.status), count: run.samples ?? 0 }), screen: "Experiments" as const })),
        ...changedSince(value.findings, visited).map((item) => ({ key: item.id, at: item.updatedAt, text: item.kind === "conclusion" ? t("Conclusion: {text}", { text: item.text }) : item.kind === "ai_suggestion" ? t("AI suggestion: {text}", { text: item.text }) : t("Observation: {text}", { text: item.text }), screen: "Experiments" as const })),
        ...changedSince(value.hypotheses, visited).map((item) => ({ key: item.id, at: item.updatedAt, text: t("Hypothesis {verdict}: {title}", { verdict: VERDICT_LABELS[item.verdict] ?? item.verdict, title: item.title }), screen: "Experiments" as const })),
        ...value.events.filter((event) => !visited || event.at > visited).map((event, index) => ({ key: `${event.at}-${index}`, at: event.at, text: event.kind === "refused" ? t("Refused: {reason}", { reason: event.reason }) : event.kind === "integrity_changed" ? t("Changed outside Saturn: {paths}", { paths: event.paths.join(", ") }) : t("Accepted a change to {path}", { path: event.path }), screen: "Protection" as const })),
      ].sort((left, right) => (left.at < right.at ? 1 : -1))
    : [];
  const restored = [
    session.file ? t("{file} in the editor", { file: session.file }) : null,
    session.draft ? t("an unsaved draft of {file}", { file: session.draft.file }) : null,
    session.runId ? t("run {run}", { run: session.runId }) : null,
  ].filter(Boolean);

  return (
    <Page title={lastQuestion ? lastQuestion.title : t("Start {project}", { project: props.project.name })} lead={lastFinding ? t("Latest note: {text}", { text: lastFinding.text }) : t("Write down the question this project is trying to answer, then work on it.")}>
      {active ? <div className={MUTED}>{t("Last active {time}", { time: when(active) })}</div> : null}
      {value && !studyHidden ? (
        <FirstStudy
          progress={{
            environmentChecked: Boolean(value.environment?.python && value.environment.report),
            questions: value.questions.length,
            hypotheses: value.hypotheses.length,
            experiments: value.experiments.filter((item) => !item.imported).length,
            imported: value.runs.filter((run) => run.imported).length,
            runsWithResults: value.runs.filter((run) => !run.imported && runHasResults(run.status)).length,
            labeled: value.review?.labeled ?? 0,
            findings: value.findings.length,
          }}
          go={props.go}
          onField={focusField}
          onHide={hideStudy}
        />
      ) : null}
      <ImportResults projectId={projectId} onImported={() => { void refresh(); props.go("Experiments"); }} notify={props.notify} />
      <ResearchBundle projectId={projectId} notify={props.notify} go={props.go} onImported={() => void refresh()} />
      <div className="mt-3.5 flex flex-wrap items-end gap-2">
        <Button onClick={() => props.go("Workspace")}>
          {restored.length ? t("Restore last layout") : t("Continue in the workspace")}
        </Button>
        {value?.lastWithResults ? (
          <Button variant="outline" onClick={() => { service.open(projectId, { kind: "sample", runId: value.lastWithResults!.id }); props.go("Samples"); }}>
            {value.review ? t("Continue sample review ({labeled} of {total})", { labeled: value.review.labeled, total: value.review.total }) : t("Continue sample review")}
          </Button>
        ) : null}
      </div>

      {restored.length ? (
        <>
          <Heading>{t("Restored as it was")}</Heading>
          <Card className="gap-1 border-0 bg-panel px-3.5 py-3">
            <div>{t("The workspace reopens with {items}.", { items: restored.join(t(", ")) })}</div>
            <div className={MUTED}>{t("Records come from the project folder; what was open comes from this device.")}</div>
          </Card>
        </>
      ) : null}

      <Heading>{t("Since your last visit")}</Heading>
      {visited ? <div className={MUTED}>{t("On this device, {time}.", { time: when(visited) })}</div> : <div className={MUTED}>{t("First visit on this device, so everything is new.")}</div>}
      {since.length === 0 ? <p className={MUTED}>{t("Nothing changed.")}</p> : null}
      {since.slice(0, 8).map((item) => (
        <Row key={item.key}>
          <span>{item.text}</span>
          <Button variant="ghost" size="small" className="text-info" onClick={() => props.go(item.screen)}>
            {item.screen === "Protection" ? t("Decide") : t("See")}
          </Button>
        </Row>
      ))}

      <Heading>{t("Open")}</Heading>
      <Card className="gap-0 border-0 bg-panel px-3.5 py-3">
        <Row>
          <span>{t("Latest run")}</span>
          <span className={MUTED}>{lastRun ? t("{status}, {count} samples, {time}", { status: runStatusLabel(lastRun.status), count: lastRun.samples ?? 0, time: when(lastRun.updatedAt) }) : t("None yet")}</span>
        </Row>
        {undecided.map((item) => (
          <Row key={item.id}>
            <span>{item.title}</span>
            <span className={MUTED}>{VERDICT_LABELS.undecided}</span>
          </Row>
        ))}
        {troubled.map((run) => (
          <Row key={run.id}>
            <span>{t("Run {run}", { run: run.id })}</span>
            <span className={MUTED}>{runStatusLabel(run.status)}</span>
          </Row>
        ))}
        <Row>
          <span>{t("Refusals and unexplained changes")}</span>
          {alerts.length ? (
            <Button variant="ghost" size="small" className="text-info" onClick={() => props.go("Protection")}>
              {t("{count} to look at", { count: alerts.length })}
            </Button>
          ) : (
            <span className={MUTED}>{t("None")}</span>
          )}
        </Row>
      </Card>

      <Heading data-tour="home-questions">{t("Questions")}</Heading>
      {value?.questions.map((item) => (
        <Row key={item.id}>
          <span>{item.title}</span>
        </Row>
      ))}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) {
            void act(async () => {
              await service.addQuestion(projectId, question.trim());
              setQuestion("");
            });
          }
        }}
      >
        <Field label={t("New question")} className="flex-[1_1_160px]">
          <Input ref={fields.question} value={question} onChange={(event) => setQuestion(event.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={!question.trim()}>
          {t("Add")}
        </Button>
      </form>

      <Heading data-tour="home-hypotheses">{t("Hypotheses")}</Heading>
      <p className="max-w-[680px] text-muted-foreground">{t("A verdict is yours to set. A run that completes says only that it executed.")}</p>
      {value?.hypotheses.map((item: Hypothesis) => (
        <Row key={item.id}>
          <span>{item.title}</span>
          <Choice label={t("Verdict")} className="flex-row items-center gap-2" triggerClassName="w-36" value={item.verdict} options={VERDICT_OPTIONS} onChange={(verdict) => void act(() => service.setVerdict(projectId, item, verdict as Verdict))} />
        </Row>
      ))}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (hypothesis.trim()) {
            void act(async () => {
              await service.addHypothesis(projectId, hypothesis.trim(), lastQuestion?.id);
              setHypothesis("");
            });
          }
        }}
      >
        <Field label={t("New hypothesis")} className="flex-[1_1_160px]">
          <Input ref={fields.hypothesis} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={!hypothesis.trim()}>
          {t("Add")}
        </Button>
      </form>
    </Page>
  );
}
