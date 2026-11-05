import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { classes } from "./classes.js";

const noticeVariants = cva("whitespace-pre-wrap rounded-md border px-3 py-2 text-xs", {
  variants: {
    tone: {
      neutral: "border-border bg-muted text-foreground",
      good: "border-good/30 bg-good/10 text-foreground",
      wait: "border-wait/30 bg-wait/10 text-foreground",
      bad: "border-destructive/30 bg-destructive/10 text-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

/** Something to read before going on. A problem is announced to assistive technology. */
export function Notice({ className, tone, ...props }: ComponentProps<"div"> & VariantProps<typeof noticeVariants>) {
  return <div data-slot="notice" role={tone === "bad" ? "alert" : undefined} className={classes(noticeVariants({ tone }), className)} {...props} />;
}
