import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { classes } from "./classes.js";

// From shadcn's Base UI components, keeping only what Saturn uses; its look comes from styles/theme.css.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        soft: "bg-primary/12 text-primary hover:bg-primary/20",
        danger: "bg-destructive/12 text-destructive hover:bg-destructive/20",
        outline: "border-border bg-background shadow-xs hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5",
        small: "h-7 gap-1 px-2 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/** A button. */
export function Button({ className, variant, size, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={classes(buttonVariants({ variant, size, className }))} {...props} />;
}
