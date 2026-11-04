import type { ReactNode } from "react";

/** A failure's message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a screen shows when there is nothing yet, and the next thing to do. */
export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="lab-empty">
      <h2>{props.title}</h2>
      {props.children ? <p>{props.children}</p> : null}
      {props.action}
    </div>
  );
}

/** A screen's scrolling page with its heading. */
export function Page(props: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="lab-page">
      <div className="lab-page-inner">
        <h1>{props.title}</h1>
        {props.lead ? <p className="lab-lead">{props.lead}</p> : null}
        {props.children}
      </div>
    </div>
  );
}

/** A row of tabs; the panel under it belongs to the caller. */
export function Tabs<T extends string>(props: { label: string; tabs: readonly T[]; current: T; onChoose: (tab: T) => void; end?: ReactNode }) {
  return (
    <div className="lab-tabs" role="tablist" aria-label={props.label}>
      {props.tabs.map((tab) => (
        <button type="button" role="tab" key={tab} aria-selected={tab === props.current} className="lab-tab" onClick={() => props.onChoose(tab)}>
          {tab}
        </button>
      ))}
      {props.end}
    </div>
  );
}
