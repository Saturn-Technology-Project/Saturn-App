// A screen asking the research assistant something on the person's behalf: the panel opens with the request in its
// box, for the person to read, change and send. Nothing is sent without them.

const EVENT = "saturn-assistant-ask";

/** A request made while the panel was closed, which the panel takes when it opens. */
let waiting: string | null = null;

/** Opens the assistant with this request in its box. */
export function askAssistant(prompt: string): void {
  waiting = prompt;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: prompt }));
}

/** Calls `listener` with each request, and at once with one still waiting; answers a function that stops listening. */
export function onAskAssistant(listener: (prompt: string) => void, takes = true): () => void {
  const handle = (event: Event) => {
    if (takes) waiting = null;
    listener((event as CustomEvent<string>).detail);
  };
  if (takes && waiting !== null) {
    const prompt = waiting;
    waiting = null;
    queueMicrotask(() => listener(prompt));
  }
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
