import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines clsx + tailwind-merge so conditional Tailwind classes are
 * correctly deduplicated and merged (the shadcn/ui standard helper).
 *
 * Note for the component classes in `index.css`: `cw-btn` and `cw-field` use
 * plain CSS `background-color`/`color`, not Tailwind utilities, so tailwind-merge
 * cannot see through them to resolve a conflict. A utility that overrides a
 * component class (`.cw-btn-secondary h-8`) works because utilities and
 * components live in different cascade layers — components always lose to
 * utilities. Prefer that direction when adding overrides.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
