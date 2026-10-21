/** The report's header line for the given moment, e.g. "Daily report: 2026-10-21 (Wednesday)". */
export function header(when) {
  const day = when.toISOString().slice(0, 10);
  const weekday = when.toLocaleDateString('en-US', { weekday: 'long' });
  return `Daily report: ${day} (${weekday})`;
}
