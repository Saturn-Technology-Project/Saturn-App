import type { ComponentProps, ReactNode } from "react";
import { Badge } from "../ui/base/Badge.js";
import { classes } from "../ui/base/classes.js";

/** What a rule or hook does, as the word it is shown with. */
export type RuleKind = "allow" | "ask" | "deny" | "hook";

const RULE_TONES = { allow: "good", ask: "wait", deny: "bad", hook: "accent" } as const;

/** The heading of a group of settings. */
export function SectionTitle(props: { children: ReactNode }) {
  return <div className="mb-2 text-[13.5px] font-semibold text-foreground">{props.children}</div>;
}

/** A title between the cards of a page. */
export function SubTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("mt-1 mb-0 text-[13.5px] font-semibold text-foreground", className)} {...props} />;
}

/** The card a group of settings sits in. */
export function SettingsCard({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("rounded-lg border border-border bg-card px-4.5 py-3.5", className)} {...props} />;
}

/** One setting: its words on the left, what changes it on the right, a rule between two of them. */
export function SettingsRow({ stacked, className, ...props }: ComponentProps<"div"> & { stacked?: boolean }) {
  return (
    <div
      className={classes(
        "flex flex-wrap items-center justify-between gap-4 [&+&]:mt-3.5 [&+&]:border-t [&+&]:border-border [&+&]:pt-3.5 [&>:not([data-slot=row-text])]:max-w-full [&>:not([data-slot=row-text])]:shrink-0",
        stacked && "flex-col items-stretch gap-2",
        className,
      )}
      {...props}
    />
  );
}

/** The words of a setting: its name and what it does. */
export function RowText({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="row-text" className={classes("flex min-w-0 flex-[1_1_240px] flex-col gap-0.5", className)} {...props} />;
}

/** A setting's name. */
export function RowLabel({ className, ...props }: ComponentProps<"span">) {
  return <span className={classes("text-[13px] font-medium text-foreground", className)} {...props} />;
}

/** What a setting does. */
export function RowDescription({ className, ...props }: ComponentProps<"span">) {
  return <span className={classes("text-xs text-muted-foreground", className)} {...props} />;
}

/** The buttons beside a setting. */
export function RowActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("flex shrink-0 items-center gap-2", className)} {...props} />;
}

/** Why a setting could not be changed. */
export function RowError({ className, ...props }: ComponentProps<"p">) {
  return <p className={classes("mt-2.5 mb-0 text-xs text-destructive", className)} {...props} />;
}

/** A line of controls that belong together. */
export function InlineForm({ className, ...props }: ComponentProps<"form">) {
  return <form className={classes("flex items-center gap-2", className)} {...props} />;
}

/** A card's top line: a name on one side, its buttons on the other. */
export function CardRow({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("flex flex-wrap items-center justify-between gap-3", className)} {...props} />;
}

/** Whether something is on, in words and a dot of the color that says so. */
export function Status(props: { ok: boolean; label: string }) {
  return (
    <Badge tone={props.ok ? "good" : "neutral"}>
      <span className={classes("size-1.5 rounded-full", props.ok ? "bg-good" : "bg-destructive")} />
      {props.label}
    </Badge>
  );
}

/** A word in the text that does something when clicked. */
export function LinkButton({ className, ...props }: ComponentProps<"button">) {
  return <button type="button" className={classes("cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-primary underline", className)} {...props} />;
}

/** One of a few values, side by side, of which exactly one is chosen. */
export function Pills<T extends string>(props: { label: string; value: string | undefined; options: readonly (readonly [T, string, ReactNode?])[]; onChoose: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={props.label} className="inline-flex items-stretch gap-0.5 rounded-lg border border-border bg-muted p-[3px] select-none">
      {props.options.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          className="inline-flex h-[26px] min-w-19 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[5px] border-0 bg-transparent px-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
          onClick={() => props.onChoose(value)}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** A list of rules or hooks, one to a line. */
export function RuleList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={classes("m-0 flex list-none flex-col gap-1 p-0", className)} {...props} />;
}

/** One rule or hook. */
export function RuleItem({ className, ...props }: ComponentProps<"li">) {
  return <li className={classes("flex items-center gap-2 text-[12.5px]", className)} {...props} />;
}

/** What a rule does, colored by whether it lets a call through. */
export function RuleEffect(props: { kind: RuleKind; children: ReactNode }) {
  return <Badge tone={RULE_TONES[props.kind]} className={classes("text-[11px] font-semibold uppercase", props.kind !== "hook" && "min-w-11")}>{props.children}</Badge>;
}

/** The tool or the pattern of a rule, in code. */
export function RuleCode({ pattern, className, ...props }: ComponentProps<"code"> & { pattern?: boolean }) {
  return <code className={classes("font-mono text-xs", pattern ? "min-w-0 flex-1 truncate" : "text-muted-foreground", className)} {...props} />;
}

/** A line of fields that add a rule or a hook, with a hint under it. */
export function RuleForm({ className, ...props }: ComponentProps<"form">) {
  return <form className={classes("flex flex-wrap items-center gap-1.5", className)} {...props} />;
}

/** The hint under a form's fields. */
export function FormHint({ className, ...props }: ComponentProps<"span">) {
  return <span className={classes("basis-full text-[11.5px] text-muted-foreground", className)} {...props} />;
}
