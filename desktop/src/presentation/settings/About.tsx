import saturnIcon from "../../assets/saturn-icon.png";
import type { RuntimeInfo } from "../../domain/model";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { classes } from "../ui/base/classes.js";
import { SectionTitle } from "./Parts";

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
    <div className="flex max-w-[760px] flex-col gap-5.5">
      <header className="flex items-center gap-4">
        <img className="size-16 shrink-0 rounded-[15px] shadow-md" src={saturnIcon} alt="" width={64} height={64} />
        <div>
          <h3 className="m-0 text-[22px] font-semibold tracking-tight text-foreground">Saturn</h3>
          <p className="mt-0.5 mb-0 text-[13.5px] text-muted-foreground">A workbench for AI research, on your own computer.</p>
        </div>
        {props.onRerunOnboarding ? (
          <Button type="button" variant="outline" size="small" className="ml-auto self-center" onClick={props.onRerunOnboarding} title="Show the tour again">
            Take the tour again
          </Button>
        ) : null}
      </header>

      <p className="m-0 text-[13.5px] leading-relaxed text-foreground">
        Saturn is a desktop workbench for AI research. Read the method, write the code yourself, run the experiment and inspect
        every sample, with as much help from AI as you choose. The app and its runtime run locally, and your records stay in your
        project.
      </p>

      <section className="flex flex-col">
        <SectionTitle>How it fits together</SectionTitle>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
          {PARTS.map((part) => (
            <Card className="gap-0 px-3.5 py-3" key={part.name}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-foreground">{part.name}</span>
                <span className="text-[11px] whitespace-nowrap text-muted-foreground">{part.role}</span>
              </div>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">{part.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col">
        <SectionTitle>What it does</SectionTitle>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
          {FEATURES.map((feature) => (
            <Card className="gap-0 px-3.5 py-3" key={feature.title}>
              <span className="mb-1 block text-[13px] font-semibold text-foreground">{feature.title}</span>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">{feature.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col">
        <SectionTitle>This installation</SectionTitle>
        <Card className="gap-0 px-4.5 py-1">
          <Fact label="Version" value={props.version ?? props.info.version} />
          <Fact label="Runtime" value={listen} />
          <Fact label="Workspace" value={props.info.name} />
          <Fact label="Data folder" value="~/.saturn-app" />
          {props.info.secrets ? (
            <Fact label="API keys" value={props.info.secrets.encrypted ? `Encrypted (AES-256-GCM), key in the ${props.info.secrets.label}` : "Not encrypted"} />
          ) : null}
          <Fact label="Runtime ID" value={props.info.runtimeId} mono />
        </Card>
      </section>
    </div>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2.25 text-[12.5px] not-first:border-t not-first:border-border">
      <span className="text-muted-foreground">{props.label}</span>
      <span className={classes("min-w-0 truncate text-foreground", props.mono && "font-mono text-[11.5px]")} title={props.value}>
        {props.value}
      </span>
    </div>
  );
}
