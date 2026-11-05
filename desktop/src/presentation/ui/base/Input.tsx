import type { ComponentProps } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { classes } from "./classes.js";

/** A line of text. */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <InputPrimitive data-slot="input" className={classes("h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30", className)} {...props} />;
}
