import saturnIcon from "../../assets/saturn-icon.png";
import type { RuntimeInfo } from "../../domain/model";

const PARTS: { name: string; role: string; body: string }[] = [
  {
    name: "Research workbench",
    role: "This window",
    body: "Your questions, code, experiments, models, samples and findings, with a research assistant beside them.",
  },
  {
    name: "Saturn Runtime",
    role: "The local core",
    body: "Runs on this computer at 127.0.0.1. It runs your experiments, calls the models, keeps your keys, and writes research records as plain files in each project.",
  },
];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Experiments you can trust",
    body: "A run freezes what it computed. Only runs measured the same way are compared, and a verdict is always yours to set.",
  },
  {
    title: "A line of models",
    body: "Follow checkpoints and their fine-tuned branches, read one sample across them, and look inside to see what changed.",
  },
  {
    title: "As much AI as you want",
    body: "In each chat, the assistant only reads, proposes changes for you to approve, or works on a task apart until you merge it.",
  },
  {
    title: "Your models",
    body: "Claude through your Claude plan, Codex through your ChatGPT plan, API keys for Anthropic, OpenAI, Google and DeepSeek, or a local LM Studio model.",
  },
  {
    title: "Projects are real folders",
    body: "An agent works in a folder only after you allow it, and you can take that back at any time. Its edits can be reviewed and reverted.",
  },
  {
    title: "Stays on this computer",
    body: "The runtime listens only on 127.0.0.1 behind a session token. Telemetry stays here unless you send it somewhere, and every request it sends is in the network log.",
  },
];

/** Settings → About: what Saturn is, what it is made of, and what it does; then this installation's details. */
export function About(props: { info: RuntimeInfo; version?: string; onRerunOnboarding?: () => void }) {
  const listen = props.info.listen.replace(/^https?:\/\//, "");
  return (
    <div className="about">
      <header className="about-hero">
        <img className="about-icon" src={saturnIcon} alt="" width={64} height={64} />
        <div>
          <h3 className="about-name">Saturn</h3>
          <p className="about-tagline">A workbench for AI research, on your own computer.</p>
        </div>
        {props.onRerunOnboarding ? (
          <button type="button" className="btn ghost tiny about-rerun" onClick={props.onRerunOnboarding} title="Show the tour again">
            Take the tour again
          </button>
        ) : null}
      </header>

      <p className="about-lead">
        Saturn is a desktop workbench for AI research. Read the method, write the code yourself, run the experiment and inspect
        every sample, with as much help from AI as you choose. The app and its runtime run locally, and your records stay in your
        project.
      </p>

      <section className="about-section">
        <div className="settings-section-title">How it fits together</div>
        <div className="about-parts">
          {PARTS.map((part) => (
            <div className="about-part" key={part.name}>
              <div className="about-part-head">
                <span className="about-part-name">{part.name}</span>
                <span className="about-part-role">{part.role}</span>
              </div>
              <p>{part.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <div className="settings-section-title">What it does</div>
        <div className="about-features">
          {FEATURES.map((feature) => (
            <div className="about-feature" key={feature.title}>
              <span className="about-feature-title">{feature.title}</span>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <div className="settings-section-title">This installation</div>
        <div className="settings-card about-facts">
          <Fact label="Version" value={props.version ?? props.info.version} />
          <Fact label="Runtime" value={listen} />
          <Fact label="Workspace" value={props.info.name} />
          <Fact label="Data folder" value="~/.saturn-app" />
          {props.info.secrets ? (
            <Fact label="API keys" value={props.info.secrets.encrypted ? `Encrypted (AES-256-GCM), key in the ${props.info.secrets.label}` : "Not encrypted"} />
          ) : null}
          <Fact label="Runtime ID" value={props.info.runtimeId} mono />
        </div>
      </section>
    </div>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="about-fact">
      <span>{props.label}</span>
      <span className={props.mono ? "about-fact-value mono" : "about-fact-value"} title={props.value}>
        {props.value}
      </span>
    </div>
  );
}
