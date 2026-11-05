import type { ReactNode } from "react";
import { Tabs as TabsRoot, TabsList, TabsTrigger } from "./base/Tabs.js";

/** A failure's message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a screen shows when there is nothing yet, and the next thing to do. */
export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="mt-0! text-base font-semibold">{props.title}</h2>
      {props.children ? <p className="max-w-md text-sm text-muted-foreground">{props.children}</p> : null}
      {props.action}
    </div>
  );
}

/** A screen's scrolling page with its heading, marked with the screen's color. */
export function Page(props: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[920px] flex-col px-6 py-5">
        <h1 className="flex items-center gap-2 text-(length:--text-title) font-semibold before:size-2 before:rounded-full before:bg-(--screen-hue)">{props.title}</h1>
        {props.lead ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{props.lead}</p> : null}
        {props.children}
      </div>
    </div>
  );
}

/** A row of tabs; the panel under it belongs to the caller. */
export function Tabs<T extends string>(props: { label: string; tabs: readonly T[]; current: T; onChoose: (tab: T) => void; end?: ReactNode }) {
  return (
    <TabsRoot value={props.current} onValueChange={(tab) => props.onChoose(tab as T)} className="flex-row items-center gap-2">
      <TabsList aria-label={props.label}>
        {props.tabs.map((tab) => <TabsTrigger key={tab} value={tab}>{tab}</TabsTrigger>)}
      </TabsList>
      {props.end}
    </TabsRoot>
  );
}
