import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardElement = "div" | "section" | "article" | "li";

/** Master card: white over ivory, hairline border, generous padding. */
export function Card({
  as: Component = "div",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: CardElement }) {
  return (
    <Component
      className={cn(
        "rounded-card border border-border-hairline bg-surface p-5 shadow-ambient-sm sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  children,
  as: Heading = "h2",
  id,
  className,
}: {
  children: ReactNode;
  as?: "h2" | "h3";
  id?: string;
  className?: string;
}) {
  return (
    <Heading id={id} className={cn("font-serif text-headline-sm text-ink", className)}>
      {children}
    </Heading>
  );
}
