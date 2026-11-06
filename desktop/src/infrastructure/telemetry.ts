/** What a user action may note about itself. */
export type ActionSpan = { setAttribute(name: string, value: string | number | boolean): void };
type Attributes = Record<string, string | number | boolean | undefined>;

const unrecorded: ActionSpan = { setAttribute: () => undefined };

/**
 * Marks one thing the user did. The desktop app exports no spans of its own for now (the runtime exports its own); the marks stay
 * here so these actions can reach the runtime's traces later without touching every caller.
 */
export function userAction<T>(_name: string, _attributes: Attributes, work: (span: ActionSpan) => Promise<T>): Promise<T> {
  return work(unrecorded);
}
