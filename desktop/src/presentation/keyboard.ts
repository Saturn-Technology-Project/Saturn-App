import type { KeyboardEvent } from "react";

/** Enter or Space on an element with `role="button"` clicks it, as a real button would; keys pressed in a child control are left alone. */
export function activateOnKey(event: KeyboardEvent<HTMLElement>) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.click();
}
