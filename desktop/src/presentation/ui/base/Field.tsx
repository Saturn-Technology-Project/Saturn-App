import { useId, type ReactNode } from "react";
import { classes } from "./classes.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./Select.js";

/** A form's field: its name above what fills it in. */
export function Field(props: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={classes("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", props.className)}>
      {props.label}
      {props.children}
      {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
    </label>
  );
}

/** One value in a choice: what it is, and what it reads as. */
export interface ChoiceOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * One of several values, in place of a native select. Named by `label` above it, or by `ariaLabel` when something else on
 * the screen already says what it is. The name is tied to the trigger by id, since the list renders a hidden input too.
 */
export function Choice(props: { label?: ReactNode; ariaLabel?: string; value: string; options: ChoiceOption[]; placeholder?: string; disabled?: boolean; className?: string; triggerClassName?: string; onChange: (value: string) => void }) {
  const id = useId();
  const trigger = (
    <Select value={props.value || null} items={props.options} disabled={props.disabled} onValueChange={(value) => props.onChange(String(value ?? ""))}>
      <SelectTrigger aria-labelledby={props.label ? id : undefined} aria-label={props.ariaLabel} placeholder={props.placeholder} className={classes("w-full text-foreground", props.triggerClassName)} />
      <SelectContent>
        {props.options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  if (!props.label) return <div className={classes("min-w-0", props.className)}>{trigger}</div>;
  return (
    <div className={classes("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", props.className)}>
      <span id={id}>{props.label}</span>
      {trigger}
    </div>
  );
}
