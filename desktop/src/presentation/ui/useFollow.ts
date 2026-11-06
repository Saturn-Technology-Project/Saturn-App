import { useEffect, useRef } from "react";
import { isAtEnd } from "../../domain/follow.js";

/**
 * Keeps a scrolling pane at its end as its content grows, for as long as the person is reading the end. Scrolling up leaves them
 * where they are, and scrolling back down picks it up again. `key` names what is shown: a new one starts at its end.
 */
export function useFollow<Pane extends HTMLElement>(key: unknown) {
  const pane = useRef<Pane>(null);
  useEffect(() => {
    const element = pane.current;
    if (!element) return undefined;
    // Decided when the content changes, from how long it was before: a scroll event can arrive later than the change it precedes.
    let length = element.scrollHeight;
    const keepUp = () => {
      const reading = isAtEnd({ scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: length });
      if (reading) element.scrollTop = element.scrollHeight;
      length = element.scrollHeight;
    };
    element.scrollTop = element.scrollHeight;
    // Anything can make it longer: a new turn, a step opening, text arriving, or the pane itself changing size.
    const changes = new MutationObserver(keepUp);
    changes.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    const resizes = new ResizeObserver(keepUp);
    resizes.observe(element);
    return () => {
      changes.disconnect();
      resizes.disconnect();
    };
  }, [key]);
  return pane;
}
