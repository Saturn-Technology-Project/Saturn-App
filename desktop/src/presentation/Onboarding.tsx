import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, Autonomy, Model, Project } from "../domain/model";
import { GuardrailSelector } from "./GuardrailSelector";
import { chooseFolder, folderName } from "./ProjectAccess";
import { ClaudeCodeLogin, CodexLogin, LlmPage, ProgramGate } from "./Settings";

type StepId = "welcome" | "model" | "agent" | "project" | "permissions" | "done";

const STEPS: { id: StepId; title: string }[] = [
  { id: "welcome", title: "Welcome" },
  { id: "model", title: "Connect a model" },
  { id: "agent", title: "Create an agent" },
  { id: "project", title: "Add a project" },
  { id: "permissions", title: "Permissions" },
  { id: "done", title: "Ready" },
];

/** What the first message could be; one click sends it. */
const FIRST_MESSAGES = [
  { title: "Explore the project", prompt: "Give me a tour of this project: what it does, how it is organized, and where to start reading." },
  { title: "Find something to fix", prompt: "Look for the most likely bug or risky code in this project and explain it before changing anything." },
  { title: "Write a test", prompt: "Pick an important function without tests and write tests for it, following the project's existing test setup." },
];

type Permissions = { platform: string; required: boolean; accessibility: boolean; screenRecording: boolean; error?: string };

/**
 * The first launch: a few screens that take the user from an empty Saturn to a first message, each one optional.
 * Everything here uses the same actions as Settings and the sidebar, so finishing or skipping leaves the app in a
 * normal state; the only thing the onboarding itself records is that it was shown (profile.onboardedAt).
 */
export function Onboarding(props: {
  models: Model[];
  agents: Agent[];
  projects: Project[];
  theme: "light" | "dark";
  onSetTheme: (theme: "light" | "dark") => void;
  /** Reloads models, agents and projects after a step changed them. */
  onChanged: () => Promise<void>;
  onCreateAgent: (input: { name: string; modelConnectionId: string | null; autonomy: Autonomy }) => Promise<Agent>;
  onAddProject: (path: string) => Promise<Project>;
  onOpenIde: (project: Project) => Promise<void>;
  /** Ends the onboarding; `first` is a message to send right away in the first agent's chat. */
  onFinish: (first?: { agentId: string; projectId?: string; text: string }) => Promise<void>;
}) {
  const [step, setStep] = useState<StepId>("welcome");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentName, setAgentName] = useState("Saturn");
  const [autonomy, setAutonomy] = useState<Autonomy>("default");
  const [agentModelId, setAgentModelId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const index = STEPS.findIndex((item) => item.id === step);
  const agent = props.agents[0];
  const project = props.projects.find((item) => item.access) ?? props.projects[0];

  useEffect(() => {
    if (!agentModelId && props.models[0]) setAgentModelId(props.models[0].id);
  }, [props.models, agentModelId]);

  // The permissions step re-reads macOS's answer every few seconds, so granting in System Settings shows up here.
  useEffect(() => {
    if (step !== "permissions") return;
    let stopped = false;
    const check = () => desktop.admin.computerPermissions().then((next) => { if (!stopped) setPermissions(next); }, () => undefined);
    void check();
    const timer = window.setInterval(() => void check(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [step]);

  function go(next: StepId) {
    setError("");
    setStep(next);
  }

  function next() {
    const following = STEPS[index + 1];
    if (following) go(following.id);
  }

  async function attempt(work: () => Promise<void>, failure: string) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally {
      setBusy(false);
    }
  }

  async function createAgent() {
    await attempt(async () => {
      await props.onCreateAgent({ name: agentName.trim() || "Saturn", modelConnectionId: agentModelId, autonomy });
      await props.onChanged();
      next();
    }, "Could not create the agent");
  }

  async function addProject() {
    const path = await chooseFolder();
    if (!path) return;
    await attempt(async () => {
      await props.onAddProject(path);
      await props.onChanged();
    }, "Could not add the project");
  }

  return (
    <div className="onboarding">
      <aside className="onboarding-steps" aria-label="Onboarding steps">
        <div className="onboarding-brand">Saturn</div>
        <ol>
          {STEPS.map((item, at) => (
            <li key={item.id} className={at === index ? "current" : at < index ? "done" : ""}>
              <span className="onboarding-step-dot" aria-hidden="true">{at < index ? "✓" : at + 1}</span>
              <span>{item.title}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="btn ghost tiny onboarding-skip" onClick={() => void props.onFinish()}>
          Skip setup
        </button>
      </aside>

      <section className="onboarding-page">
        {step === "welcome" ? (
          <div className="onboarding-card">
            <h1>Welcome to Saturn</h1>
            <p className="onboarding-lead">
              Saturn runs AI agents on this computer. You choose the models, the folders they may touch and how much they may do
              on their own; the agents read code, edit files, run commands and automate work, and everything they do stays visible
              and reversible. Nothing leaves this machine except what you send to the models you connect.
            </p>
            <div className="onboarding-row">
              <span className="label">Appearance</span>
              <div className="onboarding-choices">
                <button type="button" className={props.theme === "light" ? "btn tiny" : "btn ghost tiny"} onClick={() => props.onSetTheme("light")}>Light</button>
                <button type="button" className={props.theme === "dark" ? "btn tiny" : "btn ghost tiny"} onClick={() => props.onSetTheme("dark")}>Dark</button>
              </div>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="btn primary-btn" onClick={next}>Get started</button>
            </div>
          </div>
        ) : null}

        {step === "model" ? (
          <div className="onboarding-card wide">
            <h1>Connect a model</h1>
            <p className="onboarding-lead">
              Agents think with a model. Add a cloud model with its API key, a local one from LM Studio, or sign in to Claude Code
              or Codex with your own plan. You can add more later in Settings → Models.
            </p>
            {props.models.length ? (
              <p className="onboarding-ok">✓ {props.models.length} model{props.models.length === 1 ? "" : "s"} connected</p>
            ) : null}
            <div className="onboarding-embed">
              <LlmPage models={props.models} onChanged={props.onChanged} onError={setError} />
            </div>
            <details className="onboarding-details">
              <summary>Use Claude Code or Codex on my own plan instead</summary>
              <div className="onboarding-embed">
                <ProgramGate id="claude-code">
                  <ClaudeCodeLogin />
                </ProgramGate>
                <ProgramGate id="codex">
                  <CodexLogin />
                </ProgramGate>
              </div>
            </details>
            <div className="onboarding-actions">
              <button type="button" className="btn ghost" onClick={() => go("welcome")}>Back</button>
              <button type="button" className="btn primary-btn" onClick={next}>{props.models.length ? "Continue" : "Skip for now"}</button>
            </div>
          </div>
        ) : null}

        {step === "agent" ? (
          <div className="onboarding-card">
            <h1>Create your first agent</h1>
            <p className="onboarding-lead">An agent is a model with a name, its tools, and a say over how much it may do without asking.</p>
            {agent ? (
              <p className="onboarding-ok">✓ You already have {agent.name}</p>
            ) : (
              <form
                className="onboarding-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createAgent();
                }}
              >
                <label className="label" htmlFor="onboarding-agent-name">Name</label>
                <input id="onboarding-agent-name" className="input" value={agentName} onChange={(event) => setAgentName(event.target.value)} />
                <label className="label" htmlFor="onboarding-agent-model">Model</label>
                <select id="onboarding-agent-model" className="input" value={agentModelId ?? ""} onChange={(event) => setAgentModelId(event.target.value || null)}>
                  {props.models.length === 0 ? <option value="">No model yet (connect one in the previous step)</option> : null}
                  {props.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                <span className="label">How much it may do on its own</span>
                <div className="onboarding-row">
                  <GuardrailSelector autonomy={autonomy} onChange={(mode) => setAutonomy(mode as Autonomy)} />
                  <span className="hint">Default asks before anything risky; you can change this per agent any time.</span>
                </div>
              </form>
            )}
            <div className="onboarding-actions">
              <button type="button" className="btn ghost" onClick={() => go("model")}>Back</button>
              {agent ? (
                <button type="button" className="btn primary-btn" onClick={next}>Continue</button>
              ) : (
                <button type="button" className="btn primary-btn" disabled={busy} onClick={() => void createAgent()}>Create agent</button>
              )}
            </div>
          </div>
        ) : null}

        {step === "project" ? (
          <div className="onboarding-card">
            <h1>Add a project</h1>
            <p className="onboarding-lead">
              A project is a folder agents may work in: read its files, change them, and run commands there. Nothing in a folder is
              touched until you allow it, and you can revoke access from the project's menu later.
            </p>
            {props.projects.length ? (
              <ul className="onboarding-list">
                {props.projects.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name || folderName(item.path)}</strong>
                    <span className="hint">{item.path}</span>
                    <span className={item.access ? "onboarding-ok" : "hint"}>{item.access ? "✓ access allowed" : "no access yet"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="onboarding-actions">
              <button type="button" className="btn ghost" onClick={() => go("agent")}>Back</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => void addProject()}>
                {props.projects.length ? "Add another folder…" : "Choose a folder…"}
              </button>
              <button type="button" className="btn primary-btn" onClick={next}>{props.projects.length ? "Continue" : "Skip for now"}</button>
            </div>
          </div>
        ) : null}

        {step === "permissions" ? (
          <div className="onboarding-card">
            <h1>Let agents use the computer</h1>
            {permissions && !permissions.required ? (
              <p className="onboarding-lead">Nothing to grant on {permissions.platform === "win32" ? "Windows" : "this system"}: agents can take screenshots and control apps already.</p>
            ) : (
              <>
                <p className="onboarding-lead">
                  To click, type and read the screen on your behalf, macOS asks you to allow Saturn two things. Both can wait until
                  you first ask an agent to use an app.
                </p>
                <ul className="onboarding-list">
                  <PermissionRow
                    label="Accessibility"
                    detail="Lets agents click, type and read what is on screen."
                    granted={permissions?.accessibility ?? false}
                    onOpen={() => void desktop.admin.openPermissionPane("accessibility")}
                  />
                  <PermissionRow
                    label="Screen Recording"
                    detail="Lets agents take screenshots to see what they are doing."
                    granted={permissions?.screenRecording ?? false}
                    onOpen={() => void desktop.admin.openPermissionPane("screenRecording")}
                  />
                </ul>
                <p className="hint">After allowing, macOS may ask you to quit and reopen Saturn.</p>
              </>
            )}
            <div className="onboarding-actions">
              <button type="button" className="btn ghost" onClick={() => go("project")}>Back</button>
              <button type="button" className="btn primary-btn" onClick={next}>Continue</button>
            </div>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="onboarding-card">
            <h1>Ready</h1>
            <p className="onboarding-lead">
              {agent ? `${agent.name} is set up.` : "Create an agent whenever you like from the sidebar."}{" "}
              {project ? `Try one of these in ${project.name || folderName(project.path)}, or write your own.` : "Add a project later to work in a folder."}
            </p>
            {agent ? (
              <div className="starter-grid onboarding-starters">
                {FIRST_MESSAGES.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className="starter-card"
                    disabled={busy}
                    onClick={() => void attempt(() => props.onFinish({ agentId: agent.id, projectId: project?.access ? project.id : undefined, text: item.prompt }), "Could not send")}
                  >
                    <strong>{item.title}</strong>
                    <p>{item.prompt}</p>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="onboarding-actions">
              <button type="button" className="btn ghost" onClick={() => go("permissions")}>Back</button>
              {project?.access ? (
                <button type="button" className="btn ghost" disabled={busy} onClick={() => void attempt(() => props.onOpenIde(project), "Could not open Saturn IDE")}>
                  Open Saturn IDE
                </button>
              ) : null}
              <button type="button" className="btn primary-btn" disabled={busy} onClick={() => void props.onFinish()}>Open Saturn</button>
            </div>
          </div>
        ) : null}

        {error ? <p className="error onboarding-error">{error}</p> : null}
      </section>
    </div>
  );
}

function PermissionRow(props: { label: string; detail: string; granted: boolean; onOpen: () => void }) {
  return (
    <li>
      <strong>{props.label}</strong>
      <span className="hint">{props.detail}</span>
      {props.granted ? (
        <span className="onboarding-ok">✓ allowed</span>
      ) : (
        <button type="button" className="btn ghost tiny" onClick={props.onOpen}>Open System Settings</button>
      )}
    </li>
  );
}
