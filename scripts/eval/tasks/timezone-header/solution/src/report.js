/** The report's header line for the given moment in local time, e.g. "Daily report: 2026-10-21 (Wednesday)". */
export function header(when) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const weekday = when.toLocaleDateString('en-US', { weekday: 'long' });
  return `Daily report: ${day} (${weekday})`;
}
