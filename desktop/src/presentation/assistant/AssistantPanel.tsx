import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { errorContext, MANUAL_REQUESTS, REVIEW_REQUESTS, sampleContext, selectionContext } from "../../domain/assistant.js";
import { assistantRole, assistantRunMode, CHAT_MODES, chatModeOf } from "../../domain/chat-mode.js";
import type { Agent, ChatMode, ContextItem, Model } from "../../domain/model.js";
import { helpRequests, workbenchState, type Screen } from "../../domain/workbench.js";
import { hiddenContext } from "../../domain/slash.js";
import { t } from "../../domain/i18n.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { classes } from "../ui/base/classes.js";
import { Button } from "../ui/base/Button.js";
import { Choice } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Textarea } from "../ui/base/Textarea.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { useFollow } from "../ui/useFollow.js";
import type { WorkspaceFocus } from "../workspace/Workspace.js";
import { Turn } from "./Turn.js";
import { useConversation } from "./useConversation.js";

type Attachment = "file" | "selection" | "error" | "sample";

/** How an attachment chip is laid out: one line, cut short with an ellipsis when it is too long. */
const ATTACHMENT = "h-6 max-w-full justify-start font-mono text-[11px]";
/** The chat's settings sit quietly in the message box until they are pointed at. */
/** The mode beside the assistant's name: quiet until pointed at, like the panel's other controls. */
const MODE_SELECT = "h-6 w-auto border-transparent bg-transparent px-1.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground dark:bg-transparent";
const CHAT_SELECT = "h-6 w-auto max-w-[130px] border-transparent bg-transparent px-1 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground dark:bg-transparent";

/** The assistant beside the work. What it may do follows the mode chosen here, for this chat, and it says so. */
export function AssistantPanel(props: ScreenProps & { screen: Screen; focus: WorkspaceFocus | null; onOpenSettings: () => void }) {
  const { project, screen, focus, notify } = props;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>("manual");
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
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useFollow<HTMLDivElement>(threadId);
  const conversation = useConversation(agent?.id ?? null, threadId, notify);

  const load = useCallback(async () => {
    try {
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      setModels(found.models);
      if (found.agent) {
        const thread = await desktop.assistant.thread(found.agent, project.id);
        setThreadId(thread.id);
        setMode(chatModeOf(thread));
      }
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

  // The message box grows with what is typed, up to the height its style allows, and scrolls after that.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  const available: { id: Attachment; label: string }[] = [
    ...(focus?.file ? [{ id: "file" as const, label: focus.file }] : []),
    ...(focus?.selection ? [{ id: "selection" as const, label: t("Selection, line {line}", { line: focus.selection.line }) }] : []),
    ...(focus?.errorOutput ? [{ id: "error" as const, label: t("Error output") }] : []),
    ...(focus?.sample ? [{ id: "sample" as const, label: focus.sample.sample?.sampleId ?? t("Sample") }] : []),
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
    input += hiddenContext("the screen you are on", workbenchState({ screen, project: project.name, chatMode: mode, file: focus?.file, run: focus?.run, sampleId: focus?.sample?.sample?.sampleId }));
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

  async function chooseMode(next: ChatMode) {
    if (!threadId) return;
    try {
      setMode(chatModeOf(await desktop.catalog.setChatMode(threadId, next)));
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

  if (ready && !agent) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-panel">
        <Empty title={t("Connect a model")} action={<Button onClick={props.onOpenSettings}>{t("Open Settings")}</Button>}>
          {t("The assistant needs a model. Code and experiments work without one.")}
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-border px-3 py-1">
        <strong className="flex-none">{t("Research assistant")}</strong>
        <div className="ml-auto flex-none" data-tour="assistant-mode">
          <Choice ariaLabel={t("How much the assistant may do in this chat")} triggerClassName={MODE_SELECT} value={mode} options={CHAT_MODES.map((item) => ({ value: item.id, label: item.label, hint: item.hint }))} onChange={(next) => void chooseMode(next as ChatMode)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-3 py-3.5" ref={log} role="log" aria-label={t("Conversation with the research assistant")}>
        {conversation.runs.map((run) => (
          <Turn key={run.id} run={run} onComment={(comment) => void ask(comment)} />
        ))}
        {ready && !conversation.runs.length ? <p className="m-auto max-w-[220px] text-center text-xs text-muted-foreground">{t("Ask about your work, or how to do something in Saturn.")}</p> : null}
      </div>

      <div className="flex flex-none flex-col gap-1.5 border-t border-border px-3 py-2.5">
        <div className="flex flex-none gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[...(!focus || mode !== "manual" ? [] : reviewing ? REVIEW_REQUESTS : MANUAL_REQUESTS), ...helpRequests(t)].map((request) => (
            <Button variant="outline" size="small" key={request.label} className="h-[26px] flex-none rounded-full px-2.5 text-[11.5px]" disabled={conversation.busy} onClick={() => void ask(request.prompt, request.label === t("Explain the error") && focus?.errorOutput && !attached("error") ? errorContext(focus.errorOutput) : undefined)}>
              {request.label}
            </Button>
          ))}
        </div>
        {available.length || extraFiles.length || picking ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("What goes with your message")}>
            {extraFiles.map((path) => (
              <Button variant="soft" size="small" key={`extra-${path}`} aria-pressed="true" className={ATTACHMENT} title={t("Goes with your message. Select to leave it out.")} onClick={() => setExtraFiles((current) => current.filter((item) => item !== path))}>
                <span className="truncate">{path}</span>
              </Button>
            ))}
            {available.map((item) => (
              <Button
                variant={attached(item.id) ? "soft" : "outline"}
                size="small"
                key={item.id}
                aria-pressed={attached(item.id)}
                className={classes(ATTACHMENT, !attached(item.id) && "border-dashed text-muted-foreground line-through")}
                title={attached(item.id) ? t("Goes with your message. Select to leave it out.") : t("Left out. Select to include it.")}
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
                <span className="truncate">{item.label}</span>
              </Button>
            ))}
          </div>
        ) : null}
        {picking ? (
          <div className="flex flex-col gap-1">
            <Input aria-label={t("Find a file to attach")} autoFocus value={fileQuery} placeholder={t("Type part of a path")} onChange={(event) => setFileQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setPicking(false)} />
            <div className="flex max-h-40 flex-col gap-px overflow-auto">
              {found.filter((path) => !extraFiles.includes(path) && path !== focus?.file).map((path) => (
                <Button variant="ghost" size="small" key={path} className="h-auto min-h-7 justify-start py-1 text-left font-mono break-all whitespace-normal" onClick={() => { setExtraFiles((current) => [...current, path]); setPicking(false); setFileQuery(""); }}>
                  {path}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col rounded-[10px] border border-input bg-(--input) focus-within:border-info">
          <Textarea
            ref={box}
            className="max-h-40 min-h-[46px] resize-none border-0 bg-transparent px-2.5 pt-2 pb-0.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
            aria-label={t("Message to the assistant")}
            rows={2}
            value={text}
            placeholder={t("Message the assistant")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask(text);
              }
            }}
          />
          <div className="flex items-center gap-0.5 px-1.5 pt-[3px] pb-[5px]">
            <Button variant="ghost" size="small" className="min-w-7 flex-none px-1.5" aria-label={t("Attach a file")} title={t("Attach a file")} aria-pressed={picking} onClick={() => setPicking((open) => !open)}>
              @
            </Button>
            <div className="max-w-[130px] min-w-0" title={models.find((model) => model.id === agent?.modelConnectionId)?.name}>
              <Choice ariaLabel={t("Model")} triggerClassName={CHAT_SELECT} value={agent?.modelConnectionId ?? ""} options={models.map((model) => ({ value: model.id, label: model.name }))} onChange={(next) => void chooseModel(next)} />
            </div>
            <div className="flex-1" />
            {conversation.busy && conversation.latest ? (
              <Button variant="outline" onClick={() => void conversation.stop(conversation.latest!)}>
                {t("Stop")}
              </Button>
            ) : (
              <Button disabled={!text.trim()} onClick={() => void ask(text)}>
                {t("Send")}
              </Button>
            )}
          </div>
        </div>
        <div className="px-0.5 text-[11.5px] leading-snug text-muted-foreground" role="status">{assistantRole(mode, models.find((model) => model.id === agent?.modelConnectionId)?.provider)}</div>
      </div>
    </div>
  );
}
