import type { ReactNode } from "react";

/** A page's one-line purpose, with the details a step away for when they are wanted. */
export function Explained(props: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-explained">
      <p>{props.summary}</p>
      <details>
        <summary>How it works</summary>
        <ul>{props.children}</ul>
      </details>
    </div>
  );
}
