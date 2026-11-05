import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { classes } from "./classes.js";

const badgeVariants = cva("inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      accent: "bg-primary/14 text-primary",
      good: "bg-good/14 text-good",
      wait: "bg-wait/14 text-wait",
      bad: "bg-destructive/14 text-destructive",
      info: "bg-info/14 text-info",
      violet: "bg-violet/14 text-violet",
    },
  },
  defaultVariants: { tone: "neutral" },
});

/** A short word about a state. It says it in words, so nothing rests on its color. */
export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={classes(badgeVariants({ tone }), className)} {...props} />;
}
