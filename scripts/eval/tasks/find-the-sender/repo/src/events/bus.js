const handlers = new Map();

/** A tiny in-process event bus. */
export const bus = {
  on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload); },
};
