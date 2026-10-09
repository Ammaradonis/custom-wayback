import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines clsx + tailwind-merge so conditional Tailwind classes are
 * correctly deduplicated and merged (the shadcn/ui standard helper).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
