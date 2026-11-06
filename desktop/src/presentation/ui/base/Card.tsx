import type { ComponentProps } from "react";
import { classes } from "./classes.js";

/** A group of things that belong together. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" className={classes("flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-foreground", className)} {...props} />;
}

/** A card's heading. */
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={classes("mt-0! text-sm font-semibold", className)} {...props} />;
}
