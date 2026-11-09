import { useCallback, useEffect, useRef, useState } from "react";
import { onAskAssistant } from "../../application/assistant-requests.js";
import { desktop } from "../../application/desktop.js";
import { chatName, errorContext, MANUAL_REQUESTS, REVIEW_REQUESTS, sampleContext, selectionContext, titleFromMessage, unnamed } from "../../domain/assistant.js";
import { assistantRole, assistantRunMode, CHAT_MODES, chatModeOf } from "../../domain/chat-mode.js";
import { browserHost, type Agent, type ChatMode, type ContextItem, type Conversation, type Model } from "../../domain/model.js";
import { helpRequests, workbenchState, type Screen } from "../../domain/workbench.js";
import { hiddenContext, shownInput } from "../../domain/slash.js";
import { askToConfirm } from "../../infrastructure/confirm.js";
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
import { InstructionsNotice } from "../InstructionFiles.js";
import { useAgentBrowser } from "./AgentBrowser.js";
import { Turn } from "./Turn.js";
import { useConversation } from "./useConversation.js";

type Attachment = "file" | "selection" | "error" | "sample";

/** Where the chat a project last had open is remembered, in this browser only: losing it only opens the newest chat. */
const LAST_CHAT = "saturn.assistant.chat.";

function lastChat(projectId: string): string | null {
  try {
    return window.localStorage.getItem(LAST_CHAT + projectId);
  } catch {
    return null;
  }
}

function rememberChat(projectId: string, threadId: string) {
  try {
    window.localStorage.setItem(LAST_CHAT + projectId, threadId);
  } catch {
    // Nothing to keep it in; the newest chat opens next time.
  }
}

/** When a chat was last used: the time today, the day before that. */
function chatTime(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
  // The project's chats, and whether their list is showing in place of the conversation.
  const [chats, setChats] = useState<Conversation[]>([]);
  const [listing, setListing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [mode, setMode] = useState<ChatMode>("manual");
  const [ready, setReady] = useState(false);
  const [text, setText] = useState("");
  // A sample or error output goes along only when asked: what is sent to a model should be a choice. In review, the sample
  // under review is the point.
  const [off, setOff] = useState<Set<Attachment>>(new Set(["error", "sample"]));
  // Other project files the person picked, by path.
  const [extraFiles, setExtraFiles] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  // The assistant's browser shows in the Workspace; while it is open, the panel says so and leads there.
  const browser = useAgentBrowser();
  const browsing = Boolean(browser.state?.open);
  const [fileQuery, setFileQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const reviewing = Boolean(focus?.sample && !focus.file);
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useFollow<HTMLDivElement>(threadId);
  const conversation = useConversation(agent?.id ?? null, threadId, notify);

  // Another screen may put a request in the box: the person reads it, changes it if they like, and sends it.
  useEffect(
    () =>
      onAskAssistant((prompt) => {
        setText(prompt);
        window.requestAnimationFrame(() => box.current?.focus());
      }),
    [],
  );

  /** Opens a chat in the panel and remembers it for the project; with none, a new chat that is made by its first message. */
  const open = useCallback(
    (chat: Conversation | null) => {
      setThreadId(chat?.id ?? null);
      setMode(chatModeOf(chat));
      setListing(false);
      setRenaming(null);
      if (chat) rememberChat(project.id, chat.id);
    },
    [project.id],
  );

  const load = useCallback(async () => {
    try {
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      setModels(found.models);
      if (found.agent) {
        // The chat this project had open last, else its most recently used, else a new one, made when it is first used.
        const list = await desktop.assistant.chats(found.agent, project.id);
        const remembered = lastChat(project.id);
        setChats(list);
        open(list.find((chat) => chat.id === remembered) ?? list[0] ?? null);
      }
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setReady(true);
    }
  }, [notify, open, project.id]);

  /** The chats again, for the list: their order follows what was used last. */
  const refreshChats = useCallback(async () => {
    if (!agent) return;
    try {
      setChats(await desktop.assistant.chats(agent, project.id));
    } catch (error) {
      notify(messageOf(error));
    }
  }, [agent, notify, project.id]);

  const current = chats.find((chat) => chat.id === threadId);

  /** Names a chat, keeping the list in step. */
  const name = useCallback(async (chatId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const renamed = await desktop.assistant.renameChat(chatId, trimmed);
      setChats((list) => list.map((chat) => (chat.id === chatId ? { ...chat, title: renamed.title } : chat)));
    } catch (error) {
      notify(messageOf(error));
    }
  }, [notify]);

  // A chat that still has the name it was made with takes one from its first message, including one from before chats had
  // names.
  // Only this chat's own first turn: right after a switch, the turns of the chat before are still in hand for a moment.
  const firstRun = conversation.runs[0];
  const firstInput = firstRun?.threadId === threadId ? firstRun.input : undefined;
  useEffect(() => {
    if (!current || !unnamed(current.title) || !firstInput) return;
    const title = titleFromMessage(shownInput(firstInput));
    if (title) void name(current.id, title);
  }, [current, firstInput, name]);

  /** Starts a new chat. It is made when its first message is sent, so an unused one leaves nothing behind. */
  function startChat() {
    open(null);
    setText("");
    window.requestAnimationFrame(() => box.current?.focus());
  }

  /** Deletes a chat after asking; the panel moves to the most recent one left, or a new one. */
  async function remove(chat: Conversation) {
    if (!agent) return;
    if (chat.id === threadId && conversation.busy) {
      notify(t("The assistant is still answering in this chat. Stop it first."));
      return;
    }
    if (!(await askToConfirm(t("Delete the chat “{name}” and its messages? This cannot be undone.", { name: chatName(chat) })))) return;
    try {
      await desktop.assistant.deleteChat(agent, chat.id);
      const left = chats.filter((item) => item.id !== chat.id);
      setChats(left);
      if (chat.id === threadId) {
        open(left[0] ?? null);
        setListing(left.length > 0);
      }
    } catch (error) {
      notify(messageOf(error));
    }
  }

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
    if (!typed.trim() || conversation.busy || !agent) return;
    try {
      // A new chat is made now, named by this message and set to the mode chosen for it.
      let into: string | undefined;
      if (!threadId) {
        let chat = await desktop.assistant.newChat(agent, project.id, titleFromMessage(typed));
        if (chatModeOf(chat) !== mode) chat = await desktop.catalog.setChatMode(chat.id, mode);
        setChats((list) => [chat, ...list]);
        setThreadId(chat.id);
        rememberChat(project.id, chat.id);
        into = chat.id;
      }
      if (await conversation.send((await withContext(typed.trim())) + (also ?? ""), assistantRunMode(mode), into)) setText("");
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function chooseMode(next: ChatMode) {
    // A chat not made yet takes its mode when it is.
    if (!threadId) {
      setMode(next);
      return;
    }
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
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      setModels(found.models);
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
      <div className="flex min-h-10 flex-none items-center justify-between gap-1 border-b border-border px-2 py-1">
        <button
          type="button"
          className="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-left hover:bg-muted"
          aria-expanded={listing}
          aria-label={t("Chats in this project")}
          title={current ? `${t("Research assistant")} · ${chatName(current)}` : t("Research assistant")}
          onClick={() => {
            if (!listing) void refreshChats();
            setListing((showing) => !showing);
            setRenaming(null);
          }}
        >
          <strong className="truncate">{current ? chatName(current) : t("New chat")}</strong>
          <svg className={classes("size-3.5 flex-none text-muted-foreground transition-transform", listing && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <Button variant="ghost" size="small" className="min-w-7 flex-none px-1.5 text-base leading-none" aria-label={t("New chat")} title={t("New chat")} onClick={startChat}>
          +
        </Button>
        {browsing && props.screen !== "Workspace" ? (
          <button type="button" className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-transparent px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" title={browserHost(browser.frame?.url ?? browser.state?.url) || undefined} onClick={() => props.go("Workspace")}>
            <span className="size-1.5 flex-none animate-pulse rounded-full bg-good" aria-hidden="true" />
            <span className="truncate">{t("Browsing · watch in Workspace")}</span>
          </button>
        ) : null}
        <div className="ml-auto flex-none" data-tour="assistant-mode">
          <Choice ariaLabel={t("How much the assistant may do in this chat")} triggerClassName={MODE_SELECT} value={mode} options={CHAT_MODES.map((item) => ({ value: item.id, label: item.label, hint: item.hint }))} onChange={(next) => void chooseMode(next as ChatMode)} />
        </div>
      </div>
      <InstructionsNotice projectId={props.project.id} onError={props.notify} />

      {listing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 py-2" role="list" aria-label={t("Chats in this project")}>
          {chats.map((chat) => (
            <div key={chat.id} role="listitem" className={classes("group flex min-h-9 items-center gap-1 rounded-md pr-1", chat.id === threadId ? "bg-muted" : "hover:bg-muted/60")}>
              {renaming?.id === chat.id ? (
                <Input
                  aria-label={t("Name of the chat")}
                  autoFocus
                  className="mx-1 h-7 flex-1"
                  value={renaming.title}
                  onChange={(event) => setRenaming({ id: chat.id, title: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void name(chat.id, renaming.title);
                      setRenaming(null);
                    }
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <button type="button" className="flex min-w-0 flex-1 cursor-pointer flex-col items-start px-2 py-1 text-left" aria-current={chat.id === threadId ? "true" : undefined} onClick={() => open(chat)}>
                  <span className="w-full truncate text-[13px]">{chatName(chat)}</span>
                  <span className="text-[11px] text-muted-foreground">{chatTime(chat.updatedAt)}</span>
                </button>
              )}
              {renaming?.id === chat.id ? null : (
                <div className="flex flex-none gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button variant="ghost" size="small" className="h-6 px-1.5 text-[11px]" aria-label={t("Rename {name}", { name: chatName(chat) })} onClick={() => setRenaming({ id: chat.id, title: unnamed(chat.title) ? "" : chat.title })}>
                    {t("Rename")}
                  </Button>
                  <Button variant="ghost" size="small" className="h-6 px-1.5 text-[11px] text-destructive" aria-label={t("Delete {name}", { name: chatName(chat) })} onClick={() => void remove(chat)}>
                    {t("Delete")}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <p className="px-2 pt-2 text-[11.5px] leading-snug text-muted-foreground">{t("Each chat keeps its own messages and mode. Tasks are listed apart, on Tasks.")}</p>
        </div>
      ) : null}
      <div className={classes("min-h-0 flex-1 flex-col gap-5 overflow-auto px-3 py-3.5", listing ? "hidden" : "flex")} ref={log} role="log" aria-label={t("Conversation with the research assistant")}>
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
