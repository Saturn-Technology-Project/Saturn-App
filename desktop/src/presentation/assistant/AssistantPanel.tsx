import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { assistantRole, assistantRunMode, errorContext, MANUAL_REQUESTS, REVIEW_REQUESTS, sampleContext, selectionContext } from "../../domain/assistant.js";
import { GUARDRAIL_MODES, normalizeGuardrailMode, type GuardrailModeId } from "../../domain/conversation.js";
import type { Agent, ContextItem, Model } from "../../domain/model.js";
import { HELP_REQUESTS, workbenchState, type Screen } from "../../domain/workbench.js";
import { hiddenContext } from "../../domain/slash.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf } from "../ui/Parts.js";
import type { WorkspaceFocus } from "../workspace/Workspace.js";
import { Turn } from "./Turn.js";
import { useConversation } from "./useConversation.js";

type Attachment = "file" | "selection" | "error" | "sample";

/** The assistant beside the work. What it may do follows the open file's mode, and it says so. */
export function AssistantPanel(props: ScreenProps & { screen: Screen; focus: WorkspaceFocus | null; onOpenSettings: () => void }) {
  const { project, screen, focus, notify } = props;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [text, setText] = useState("");
  // A sample or error output goes along only when asked: what is sent to a model should be a choice. In review, the sample
  // under review is the point.
  const [off, setOff] = useState<Set<Attachment>>(new Set(["error", "sample"]));
  // Other project files the person picked, by path.
  const [extraFiles, setExtraFiles] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const reviewing = Boolean(focus?.sample && !focus.file);
  const end = useRef<HTMLDivElement>(null);
  const conversation = useConversation(agent?.id ?? null, threadId, notify);

  const load = useCallback(async () => {
    try {
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      setModels(found.models);
      if (found.agent) setThreadId((await desktop.assistant.thread(found.agent, project.id)).id);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setReady(true);
    }
  }, [notify, project.id]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!picking) return undefined;
    let stale = false;
    desktop.projects
      .files(project.id, fileQuery)
      .then((list) => {
        if (!stale) setFound(list.slice(0, 12));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [fileQuery, picking, project.id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [conversation.runs]);

  const mode = focus?.file ? focus.mode : null;
  const available: { id: Attachment; label: string }[] = [
    ...(focus?.file ? [{ id: "file" as const, label: focus.file }] : []),
    ...(focus?.selection ? [{ id: "selection" as const, label: `Selection, line ${focus.selection.line}` }] : []),
    ...(focus?.errorOutput ? [{ id: "error" as const, label: "Error output" }] : []),
    ...(focus?.sample ? [{ id: "sample" as const, label: focus.sample.sample?.sampleId ?? "Sample" }] : []),
  ];
  const attached = (id: Attachment) => available.some((item) => item.id === id) && (reviewing && id === "sample" ? !off.has("selection") : !off.has(id));

  /** The message with what is attached, in a block the conversation keeps out of sight. */
  async function withContext(typed: string): Promise<string> {
    let input = typed;
    const files = [...(attached("file") && focus?.file ? [focus.file] : []), ...extraFiles];
    if (files.length) {
      const items: ContextItem[] = files.map((path) => ({ kind: "file", path, label: path }));
      const expanded = await desktop.projects.expandContext(project.id, items);
      if (expanded.text) input += `\n\n<saturn_context sources="${expanded.sources.join("; ").replace(/"/g, "'")}">\n<attached_context>\n${expanded.text}\n</attached_context>\n</saturn_context>`;
    }
    if (attached("selection") && focus?.selection && focus.file) input += selectionContext(focus.file, focus.selection.line, focus.selection.text);
    if (attached("error") && focus?.errorOutput) input += errorContext(focus.errorOutput);
    if (attached("sample") && focus?.sample) input += sampleContext(focus.sample);
    input += hiddenContext("the screen you are on", workbenchState({ screen, project: project.name, file: focus?.file, mode: focus?.file ? focus.mode : null, run: focus?.run, sampleId: focus?.sample?.sample?.sampleId }));
    return input;
  }

  async function ask(typed: string, also?: string) {
    if (!typed.trim() || conversation.busy) return;
    try {
      if (await conversation.send((await withContext(typed.trim())) + (also ?? ""), assistantRunMode(mode))) setText("");
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function handToTask() {
    if (!agent || !text.trim()) return;
    try {
      await desktop.assistant.startTask(agent, project.id, await withContext(text.trim()));
      setText("");
      props.go("Tasks");
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function chooseModel(modelId: string) {
    if (!agent) return;
    try {
      await desktop.assistant.chooseModel(agent, modelId);
      await load();
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function chooseApprovals(approvals: GuardrailModeId) {
    if (!agent) return;
    try {
      await desktop.catalog.updateAgent(agent.id, { autonomy: approvals });
      await load();
    } catch (error) {
      notify(messageOf(error));
    }
  }

  if (ready && !agent) {
    return (
      <div className="lab-assistant">
        <Empty title="Connect a model" action={<button type="button" className="lab-button primary" onClick={props.onOpenSettings}>Open Settings</button>}>
          The assistant needs a model. Code and experiments work without one.
        </Empty>
      </div>
    );
  }

  return (
    <div className="lab-assistant">
      <div className="lab-assistant-head">
        <strong>Research assistant</strong>
        <select className="lab-assistant-model" aria-label="Model" value={agent?.modelConnectionId ?? ""} onChange={(event) => void chooseModel(event.target.value)}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <select className="lab-assistant-model" aria-label="When the assistant asks first" value={normalizeGuardrailMode(agent?.autonomy)} onChange={(event) => void chooseApprovals(event.target.value as GuardrailModeId)}>
          {GUARDRAIL_MODES.map((item) => (
            <option key={item.id} value={item.id} title={item.description}>
              {item.title}
            </option>
          ))}
        </select>
        <div className="lab-muted lab-assistant-role">{assistantRole(mode)}</div>
      </div>

      <div className="lab-conversation" role="log" aria-label="Conversation with the research assistant">
        {conversation.runs.map((run) => (
          <Turn key={run.id} run={run} onComment={(comment) => void ask(comment)} />
        ))}
        <div ref={end} />
      </div>

      <div className="lab-composer">
        <div className="lab-requests">
          {[...(!focus || mode === "pair" ? [] : reviewing ? REVIEW_REQUESTS : MANUAL_REQUESTS), ...HELP_REQUESTS].map((request) => (
            <button type="button" key={request.label} className="lab-request" disabled={conversation.busy} onClick={() => void ask(request.prompt, request.label === "Explain the error" && focus?.errorOutput && !attached("error") ? errorContext(focus.errorOutput) : undefined)}>
              {request.label}
            </button>
          ))}
        </div>
        {available.length || extraFiles.length || picking ? (
          <div className="lab-attachments" role="group" aria-label="What goes with your message">
            {extraFiles.map((path) => (
              <button type="button" key={`extra-${path}`} aria-pressed="true" className="lab-attachment on" title="Goes with your message. Select to leave it out." onClick={() => setExtraFiles((current) => current.filter((item) => item !== path))}>
                {path}
              </button>
            ))}
            {available.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={attached(item.id)}
                className={attached(item.id) ? "lab-attachment on" : "lab-attachment"}
                title={attached(item.id) ? "Goes with your message. Select to leave it out." : "Left out. Select to include it."}
                onClick={() =>
                  setOff((current) => {
                    const next = new Set(current);
                    const key = reviewing && item.id === "sample" ? "selection" : item.id;
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        {picking ? (
          <div className="lab-picker">
            <input aria-label="Find a file to attach" className="lab-input" autoFocus value={fileQuery} placeholder="Type part of a path" onChange={(event) => setFileQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setPicking(false)} />
            <div className="lab-picker-list">
              {found.filter((path) => !extraFiles.includes(path) && path !== focus?.file).map((path) => (
                <button type="button" key={path} className="lab-file" onClick={() => { setExtraFiles((current) => [...current, path]); setPicking(false); setFileQuery(""); }}>
                  {path}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <textarea
          aria-label="Message to the assistant"
          rows={3}
          value={text}
          placeholder="Ask about your work, or how to do something in Saturn"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(text);
            }
          }}
        />
        <div className="lab-composer-actions">
          <button type="button" className="lab-button quiet" aria-pressed={picking} onClick={() => setPicking((open) => !open)}>
            @ File
          </button>
          {mode === "delegate" ? (
            <button type="button" className="lab-button" disabled={!text.trim()} onClick={() => void handToTask()}>
              Hand to a task
            </button>
          ) : null}
          <div className="lab-rail-space" />
          {conversation.busy && conversation.latest ? (
            <button type="button" className="lab-button" onClick={() => void conversation.stop(conversation.latest!)}>
              Stop
            </button>
          ) : (
            <button type="button" className="lab-button primary" disabled={!text.trim()} onClick={() => void ask(text)}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
