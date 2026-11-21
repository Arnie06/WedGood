import type { ReactNode } from "react";
import { Hallmark } from "@/components/shell/hallmark";

export function AuthFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string | undefined;
  children: ReactNode;
}) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-margin-mobile py-12"
    >
      <Hallmark />
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{title}</h1>
        {intro && <p className="text-body-lg text-ink-muted">{intro}</p>}
      </div>
      {children}
    </main>
  );
}

export function UnconfiguredNotice() {
  return (
    <p
      role="status"
      className="rounded-card border border-border-hairline bg-surface-muted p-4 text-body-md"
    >
      Sign-in isn&apos;t configured in this environment yet, so accounts can&apos;t be used. Nothing
      is being faked here.
    </p>
  );
}
