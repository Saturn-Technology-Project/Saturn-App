/** How close to the end, in pixels, still counts as reading the end. */
const NEAR_END = 48;

/** Whether a scrolling pane is at its end, so that it should keep up with what is added. */
export function isAtEnd(pane: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= NEAR_END;
}
