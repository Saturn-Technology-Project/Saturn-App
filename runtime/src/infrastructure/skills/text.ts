export const TEXT_LIMIT = 32_000;

export function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** The text up to TEXT_LIMIT; past that, a note says how much was cut, so the model reads less instead of guessing. */
export function clip(value: string): string {
  if (value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)}\n…[${value.length - TEXT_LIMIT} more characters cut. Read a narrower part: filter with grep, head or tail, or read a file with offset and limit.]`;
}
