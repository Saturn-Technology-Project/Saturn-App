import type { ReactElement, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

/** A few words about something, shown when pointed at or focused. What it says must not be needed to use the thing. */
export function Tooltip(props: { text: ReactNode; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={props.children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner sideOffset={4} className="isolate z-50">
          <TooltipPrimitive.Popup data-slot="tooltip" className="max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background">{props.text}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
