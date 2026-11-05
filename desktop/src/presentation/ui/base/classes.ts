import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names joined, with the later of two conflicting Tailwind classes winning. */
export function classes(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
