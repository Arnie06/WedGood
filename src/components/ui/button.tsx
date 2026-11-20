import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "emphasis" | "secondary" | "outline" | "quiet";
export type ButtonSize = "md" | "sm";

const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-sans text-label-lg font-semibold tracking-[0.02em] transition-colors duration-150 select-none disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55";

// Every height is at least 44px (48px default) for comfortable touch targets.
const sizes: Record<ButtonSize, string> = {
  md: "min-h-12 px-6 py-2",
  sm: "min-h-11 px-4 py-2",
};

const variants: Record<ButtonVariant, string> = {
  // Blush with charcoal text; never white text on blush (ADR-014).
  primary:
    "bg-action-primary text-on-action-primary enabled:hover:bg-action-primary-hover enabled:active:bg-action-primary-pressed [a&]:hover:bg-action-primary-hover [a&]:active:bg-action-primary-pressed",
  emphasis:
    "bg-action-emphasis text-on-action-emphasis enabled:hover:bg-action-emphasis-hover enabled:active:bg-action-emphasis-pressed [a&]:hover:bg-action-emphasis-hover [a&]:active:bg-action-emphasis-pressed",
  secondary:
    "bg-action-secondary text-on-action-secondary enabled:hover:bg-action-secondary-hover enabled:active:bg-action-secondary-pressed [a&]:hover:bg-action-secondary-hover [a&]:active:bg-action-secondary-pressed",
  outline:
    "border border-action-secondary bg-transparent text-action-secondary enabled:hover:bg-action-secondary-subtle [a&]:hover:bg-action-secondary-subtle",
  quiet:
    "px-2 text-action-emphasis underline decoration-1 underline-offset-4 enabled:hover:decoration-2 [a&]:hover:decoration-2",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string | undefined;
} = {}): string {
  return cn(base, sizes[size], variants[variant], className);
}

type StyleProps = { variant?: ButtonVariant; size?: ButtonSize };

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & StyleProps) {
  return (
    <button
      type={type}
      className={buttonClasses({
        ...(variant && { variant }),
        ...(size && { size }),
        className,
      })}
      {...props}
    />
  );
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ComponentProps<typeof Link> & StyleProps) {
  return (
    <Link
      className={buttonClasses({
        ...(variant && { variant }),
        ...(size && { size }),
        className,
      })}
      {...props}
    />
  );
}
