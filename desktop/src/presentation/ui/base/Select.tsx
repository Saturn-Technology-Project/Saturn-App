import type { ReactNode } from "react";
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
        <SelectPrimitive.Popup data-slot="select-content" className={classes("relative isolate z-50 max-h-(--available-height) w-max max-w-[min(20rem,var(--available-width))] min-w-[max(9rem,var(--anchor-width))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 p-1", className)} {...props}>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** Values that belong together, under a name. */
export function SelectGroup(props: { label: string; children: ReactNode }) {
  return (
    <SelectPrimitive.Group data-slot="select-group" className="not-first:mt-1">
      <SelectPrimitive.GroupLabel className="px-2 py-1 text-xs text-muted-foreground">{props.label}</SelectPrimitive.GroupLabel>
      {props.children}
    </SelectPrimitive.Group>
  );
}

/** A line between values that do not belong together, such as the values and an action under them. */
export function SelectSeparator(props: SelectPrimitive.Separator.Props) {
  return <SelectPrimitive.Separator data-slot="select-separator" className="my-1 h-px bg-border" {...props} />;
}

/**
 * One value in the list, with a check when it is the chosen one. The highlighted one is tinted with the text color, which
 * shows on the popover in both themes (the accent color is the popover's own in the dark one), and its hint stays muted, so
 * the name and its explanation keep their weights while the pointer moves.
 */
export function SelectItem({ className, children, hint, ...props }: SelectPrimitive.Item.Props & { hint?: string }) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={classes("relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-foreground/8 data-highlighted:bg-foreground/8 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2", className)} {...props}>
      <SelectPrimitive.ItemText className="block min-w-0 flex-1 truncate">{children}</SelectPrimitive.ItemText>
      {hint ? <span className="max-w-full text-xs text-pretty whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{hint}</span> : null}
      <SelectPrimitive.ItemIndicator render={<span className="pointer-events-none absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center" />}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
