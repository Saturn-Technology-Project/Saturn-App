import type { ReactNode } from "react";

/** A page's one-line purpose, with the details a step away for when they are wanted. */
export function Explained(props: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="text-[13px] leading-normal text-muted-foreground">
      <p className="mt-0 mb-1">{props.summary}</p>
      <details>
        <summary className="w-fit cursor-pointer text-[12.5px] text-foreground">How it works</summary>
        <ul className="mt-2 mb-0 flex flex-col gap-1.5 pl-4.5">{props.children}</ul>
      </details>
    </div>
  );
}
