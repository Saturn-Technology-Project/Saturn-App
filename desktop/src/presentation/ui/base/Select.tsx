import { Select as SelectPrimitive } from "@base-ui/react/select";
import { classes } from "./classes.js";

/** One of several values, chosen from a list that looks the same on every system. */
export const Select = SelectPrimitive.Root;

/** What shows the chosen value, and opens the list. */
export function SelectTrigger({ className, placeholder, ...props }: SelectPrimitive.Trigger.Props & { placeholder?: string }) {
  return (
    <SelectPrimitive.Trigger data-slot="select-trigger" data-size="sm" className={classes("flex w-fit items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className)} {...props}>
      <SelectPrimitive.Value data-slot="select-value" className="flex-1 truncate text-left" placeholder={placeholder} />
      <SelectPrimitive.Icon className="pointer-events-none text-muted-foreground">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The list. */
export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="isolate z-50">
        <SelectPrimitive.Popup data-slot="select-content" className={classes("relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md glass text-popover-foreground shadow-md ring-1 ring-foreground/10 p-1", className)} {...props}>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** One value in the list, with a check when it is the chosen one. */
export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={classes("relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2", className)} {...props}>
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
