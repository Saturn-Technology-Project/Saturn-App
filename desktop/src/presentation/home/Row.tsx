import type { ComponentProps, ReactNode } from "react";
import { classes } from "../ui/base/classes.js";

/** One line of a list: its first part takes the room, and whatever follows (a state, a button) wraps beneath when narrow. */
export function Row({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5 *:first:min-w-0 *:first:flex-[1_1_220px] *:first:[overflow-wrap:anywhere]", className)} {...props} />;
}

/** A section's heading inside a Page. */
export function Heading({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={classes("mt-5! mb-2! text-sm font-semibold", className)} {...props} />;
}

/** A small table that scrolls sideways when it does not fit; `label` names it. */
export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border [&_td]:p-2 [&_td]:align-top [&_td]:[overflow-wrap:anywhere] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground" aria-label={label}>
        {children}
      </table>
    </div>
  );
}
