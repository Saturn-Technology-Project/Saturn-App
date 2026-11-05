import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { classes } from "./classes.js";

/** A list of actions that opens from a button. */
export const Menu = MenuPrimitive.Root;

/** What opens the menu. */
export function MenuTrigger({ className, ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" className={classes("cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-primary/40", className)} {...props} />;
}

/** The list. */
export function MenuContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner sideOffset={4} className="isolate z-50">
        <MenuPrimitive.Popup data-slot="menu-content" className={classes("glass max-h-(--available-height) min-w-36 overflow-y-auto rounded-md p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none", className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** One action. */
export function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="menu-item" className={classes("flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground", className)} {...props} />;
}
