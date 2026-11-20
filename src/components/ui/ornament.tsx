import { cn } from "@/lib/cn";

/** Decorative gold hairline with a small sprig. Purely presentational. */
export function Ornament({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 160 16"
      className={cn("h-4 w-40 text-accent-gold", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
    >
      <path d="M2 8h60M98 8h60" />
      <path d="M80 2c-4 2-6 4-6 6s2 4 6 6c4-2 6-4 6-6s-2-4-6-6Z" />
      <path d="M70 8c-2-2-4-3-7-3M90 8c2-2 4-3 7-3M70 8c-2 2-4 3-7 3M90 8c2 2 4 3 7 3" />
    </svg>
  );
}
