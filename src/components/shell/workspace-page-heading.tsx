import type { ReactNode } from "react";

export function WorkspacePageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-xl">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{title}</h1>
        {description && <p className="mt-1 text-body-md text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
