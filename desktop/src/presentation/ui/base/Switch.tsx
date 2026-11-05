import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { classes } from "./classes.js";

/** Something on or off, that takes effect at once. */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={classes("relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-input transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-info", className)} {...props}>
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-xs transition-transform data-checked:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
