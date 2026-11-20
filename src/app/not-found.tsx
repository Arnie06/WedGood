import { Hallmark } from "@/components/shell/hallmark";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-margin-mobile py-16"
    >
      <Hallmark />
      <h1 className="font-serif text-headline-mobile md:text-headline-lg">
        We couldn&apos;t find that page
      </h1>
      <p className="text-body-lg text-ink-muted">
        The link may be out of date, or the page may have moved.
      </p>
      <div>
        <ButtonLink href="/">Return home</ButtonLink>
      </div>
    </main>
  );
}
