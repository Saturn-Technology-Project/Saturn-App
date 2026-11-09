import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { classes } from "./classes.js";

/**
 * A dialog: keyboard focus stays inside it and returns where it was, what is behind it cannot be reached, and Escape or
 * a click outside closes it.
 */
export const Dialog = DialogPrimitive.Root;

/**
 * What a dialog shows, over the rest of the window. Its one column is `minmax(0, 1fr)`, so a long unbreakable word (a
 * path, say) wraps or clips inside the dialog instead of widening the column past it and carrying the buttons along.
 */
export function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 isolate z-50 bg-black/25" />
      <DialogPrimitive.Popup data-slot="dialog-content" className={classes("fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-6 rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-md", className)} {...props}>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** A dialog's title and what it is about. */
export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={classes("flex flex-col gap-1", className)} {...props} />;
}

/** A dialog's buttons. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={classes("flex justify-end gap-2", className)} {...props} />;
}

/** A dialog's title, which names it for assistive technology. */
export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={classes("text-base font-medium", className)} {...props} />;
}

/** A line under a dialog's title, which describes it for assistive technology. */
export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={classes("text-sm text-muted-foreground", className)} {...props} />;
}
