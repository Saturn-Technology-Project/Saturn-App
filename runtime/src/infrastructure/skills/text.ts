export const TEXT_LIMIT = 32_000;

export function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function clip(value: string): string {
  return value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT)}…`;
}
