import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Model, Project } from "../../domain/model.js";
import { chooseFolder } from "../ProjectAccess.js";
import { ClaudeCodeLogin, CodexLogin, LlmPage, ProgramGate } from "../settings/Settings.js";
import { messageOf } from "../ui/Parts.js";

const STEPS = ["Welcome", "Model", "Project", "Question"] as const;
type Step = (typeof STEPS)[number];

/** The first launch: a model to think with, a folder to work in, and the question it is for. Each step can be skipped. */
export function Onboarding(props: {
  models: Model[];
  projects: Project[];
  theme: "light" | "dark";
  onSetTheme: (theme: "light" | "dark") => void;
  onChanged: () => Promise<void>;
  onChooseProject: (project: Project) => Promise<void>;
  onFinish: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("Welcome");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [project, setProject] = useState<Project | null>(props.projects.find((item) => item.access) ?? null);
  const at = STEPS.indexOf(step);

  async function addProject() {
    try {
      const path = await chooseFolder();
      if (!path) return;
      const added = await desktop.projects.create({ path, grant: true });
      await props.onChanged();
      await props.onChooseProject(added);
      setProject(added);
      setError("");
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function finish() {
    try {
      if (project && question.trim()) await desktop.research.addQuestion(project.id, question.trim());
      await props.onFinish();
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  return (
    <div className="lab-onboarding">
      <div className="lab-onboarding-drag" />
      <div className="lab-onboarding-inner">
        <ol className="lab-onboarding-steps" aria-label="Setup steps">
          {STEPS.map((item, position) => (
            <li key={item} aria-current={item === step ? "step" : undefined} className={position <= at ? "reached" : undefined}>
              {item}
            </li>
          ))}
        </ol>
        {error ? <div className="lab-notice bad" role="alert">{error}</div> : null}

        {step === "Welcome" ? (
          <section>
            <h1>A workbench for AI research</h1>
            <p className="lab-lead">Read a method, write the code yourself, run the experiment and inspect every sample, on your own computer. AI helps as much as you let it, file by file. Nothing leaves this computer except what you send to the models you connect.</p>
            <div className="lab-segments" role="group" aria-label="Appearance" style={{ width: "fit-content", marginTop: 16 }}>
              {(["light", "dark"] as const).map((theme) => (
                <button type="button" key={theme} aria-pressed={props.theme === theme} className={props.theme === theme ? "lab-segment active" : "lab-segment"} onClick={() => props.onSetTheme(theme)}>
                  {theme === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === "Model" ? (
          <section>
            <h1>Connect a model</h1>
            <p className="lab-lead">The research assistant needs one: an API key, a local model from LM Studio, or your own Claude Code or Codex plan. Code and experiments work without it, and this is also in Settings.</p>
            {props.models.length ? <p className="lab-muted">{props.models.length === 1 ? "1 model" : `${props.models.length} models`} connected.</p> : null}
            <LlmPage models={props.models} onChanged={props.onChanged} onError={setError} />
            <details>
              <summary>Use Claude Code or Codex on my own plan</summary>
              <ProgramGate id="claude-code">
                <ClaudeCodeLogin />
              </ProgramGate>
              <ProgramGate id="codex">
                <CodexLogin />
              </ProgramGate>
            </details>
          </section>
        ) : null}

        {step === "Project" ? (
          <section>
            <h1>Choose a project folder</h1>
            <p className="lab-lead">Your research records live in this folder as plain files, in .saturn/research. Saturn reads and writes it because you choose it here.</p>
            {project ? <p><code>{project.path}</code></p> : null}
            <button type="button" className="lab-button" style={{ marginTop: 12 }} onClick={() => void addProject()}>
              {project ? "Choose another folder" : "Choose a folder"}
            </button>
          </section>
        ) : null}

        {step === "Question" ? (
          <section>
            <h1>What are you trying to find out?</h1>
            <p className="lab-lead">One question to start with. Everything you run and conclude connects back to it.</p>
            <label className="lab-field" style={{ marginTop: 12 }}>
              Question
              <textarea rows={3} value={question} disabled={!project} placeholder="When does this behavior appear during training?" onChange={(event) => setQuestion(event.target.value)} />
            </label>
            {!project ? <p className="lab-warning">Choose a project first to save a question.</p> : null}
          </section>
        ) : null}

        <div className="lab-form" style={{ justifyContent: "flex-end", marginTop: 24 }}>
          <button type="button" className="lab-button quiet" onClick={() => void props.onFinish()}>
            Skip setup
          </button>
          {at > 0 ? (
            <button type="button" className="lab-button" onClick={() => setStep(STEPS[at - 1])}>
              Back
            </button>
          ) : null}
          {at < STEPS.length - 1 ? (
            <button type="button" className="lab-button primary" onClick={() => setStep(STEPS[at + 1])}>
              Continue
            </button>
          ) : (
            <button type="button" className="lab-button primary" onClick={() => void finish()}>
              Start working
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
