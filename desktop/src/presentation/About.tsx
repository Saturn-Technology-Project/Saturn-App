import saturnIcon from "../assets/saturn-icon.png";
import type { RuntimeInfo } from "../domain/model";

const PARTS: { name: string; role: string; body: string }[] = [
  {
    name: "Agent App",
    role: "This window",
    body: "Create agents, give each one a model and tools, and chat with them alone, in a project, or together in a group.",
  },
  {
    name: "Saturn Runtime",
    role: "The local core",
    body: "Runs on this Mac at 127.0.0.1. It calls the models, runs the built-in skills and MCP tools, and keeps your agents, chats and keys.",
  },
  {
    name: "Saturn IDE",
    role: "The editor",
    body: "A Code-OSS editor with the same agents built in: Tab completion, next-edit, Cmd+I inline edits, and agent changes you review as diffs.",
  },
];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Your models, side by side",
    body: "Claude through your own Claude plan, Codex through your ChatGPT plan, Gemini, DeepSeek, OpenAI, or a local LM Studio model. Each agent picks its model and effort.",
  },
  {
    title: "Projects are real folders",
    body: "A project is a folder on this Mac. Agents work in it only after you allow access, and can be revoked any time.",
  },
  {
    title: "Agents that work together",
    body: "Put agents in a group: each one reads the conversation, decides whether it is needed, and hands work to others with @mentions.",
  },
  {
    title: "Tools you control",
    body: "Files, shell, web, computer use, automations and any MCP server. Risky actions wait for your approval.",
  },
  {
    title: "Every change can be undone",
    body: "Agent edits are checkpointed: review each file as a diff, keep it, revert it, or restore a chat to before any turn.",
  },
  {
    title: "Stays on this machine",
    body: "The runtime listens only on 127.0.0.1 behind a session token. Telemetry, including the IDE's, goes to the runtime, not to a vendor.",
  },
];

/** Settings → About: what Saturn is, what it is made of, and what it does; then this installation's details. */
export function About(props: { info: RuntimeInfo; version?: string }) {
  const listen = props.info.listen.replace(/^https?:\/\//, "");
  return (
    <div className="about">
      <header className="about-hero">
        <img className="about-icon" src={saturnIcon} alt="" width={64} height={64} />
        <div>
          <h3 className="about-name">Saturn</h3>
          <p className="about-tagline">AI agents that run on your own computer.</p>
        </div>
      </header>

      <p className="about-lead">
        Saturn is a desktop workspace for AI agents. You choose the models, the tools and the folders they may touch; the agents
        then read code, run commands, edit files and automate work for you, while everything they do stays visible, reviewable and
        reversible. The app, its runtime and its editor all run locally.
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
