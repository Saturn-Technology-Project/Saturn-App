import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { classes } from "./classes.js";

/** One of several things that can each be chosen. */
export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={classes("relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input text-white transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-info data-checked:bg-info", className)} {...props}>
      <CheckboxPrimitive.Indicator className="grid place-content-center">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
