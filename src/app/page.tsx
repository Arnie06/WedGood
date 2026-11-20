import {
  ArrowRight,
  ClipboardCheck,
  Compass,
  Gift,
  Scale,
  Send,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { ArchIllustration } from "@/components/marketing/arch-illustration";
import { Hallmark } from "@/components/shell/hallmark";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Ornament } from "@/components/ui/ornament";

const jobs: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Compass,
    title: "Discover",
    body: "Save venues and vendors you find anywhere, with the link and details you trust.",
  },
  {
    icon: Scale,
    title: "Compare",
    body: "See proposals side by side on the same guest count. Unconfirmed costs stay visible.",
  },
  {
    icon: ClipboardCheck,
    title: "Plan",
    body: "A checklist that follows your date, plus timelines for every event you're hosting.",
  },
  {
    icon: Wallet,
    title: "Track",
    body: "Estimates, commitments and payments kept distinct, so you always know what's owed.",
  },
  {
    icon: Send,
    title: "Share",
    body: "Invite your partner and helpers, and let guests reply without creating an account.",
  },
  {
    icon: Gift,
    title: "Package",
    body: "Hand your caterer, planner or family exactly what they need, and nothing more.",
  },
];

const principles = [
  {
    title: "Enter it once",
    body: "A guest, a contract or a payment lives in one place and flows everywhere it matters.",
  },
  {
    title: "Unknown stays unknown",
    body: "Missing prices are never treated as zero, and estimates are never shown as commitments.",
  },
  {
    title: "Share only what's needed",
    body: "Private notes, guest details and finances stay with you unless you choose otherwise.",
  },
];

export default function LandingPage() {
  return (
    <>
      <header className="glass sticky top-0 z-20 border-b border-border-hairline">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-margin-mobile md:px-8">
          <Hallmark />
          <div className="hidden sm:block">
            <ButtonLink href="/preview" variant="outline" size="sm">
              View the preview
            </ButtonLink>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-margin-mobile pt-14 pb-20 md:px-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pt-24">
          <div className="space-y-6">
            <p className="text-label-md font-semibold text-ink-muted uppercase">
              A calm wedding planning workspace
            </p>
            <h1 className="font-serif text-display-mobile text-balance md:text-display-lg">
              Your wedding. Beautifully organized.
            </h1>
            <p className="max-w-xl text-body-lg text-ink-muted">
              Discover, compare and bring every detail together, from the first venue you love to
              the last table you seat.
            </p>
            <div className="flex flex-col gap-3 pt-2 min-[26rem]:flex-row min-[26rem]:items-center">
              <ButtonLink href="/preview">
                Explore the preview
                <ArrowRight aria-hidden="true" className="size-4" />
              </ButtonLink>
              <ButtonLink href="#what-it-does" variant="quiet">
                See what it brings together
              </ButtonLink>
            </div>
            <p className="text-body-sm text-ink-muted">
              Accounts aren&apos;t open yet. The preview uses fictional sample data.
            </p>
          </div>
          <ArchIllustration className="mx-auto w-full max-w-64 lg:max-w-none" />
        </section>

        <section
          id="what-it-does"
          aria-labelledby="what-it-does-title"
          className="scroll-mt-20 border-y border-border-hairline bg-surface-sunken"
        >
          <div className="mx-auto max-w-6xl space-y-10 px-margin-mobile py-16 md:px-8 lg:py-24">
            <div className="space-y-4 text-center">
              <h2
                id="what-it-does-title"
                className="font-serif text-headline-mobile md:text-headline-lg"
              >
                Everything in one connected place
              </h2>
              <Ornament className="mx-auto" />
            </div>
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map(({ icon: Icon, title, body }) => (
                <Card as="li" key={title} className="space-y-3">
                  <Icon
                    aria-hidden="true"
                    className="size-6 text-action-secondary"
                    strokeWidth={1.5}
                  />
                  <h3 className="font-serif text-headline-sm">{title}</h3>
                  <p className="text-body-md text-ink-muted">{body}</p>
                </Card>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="principles-title"
          className="mx-auto max-w-6xl space-y-10 px-margin-mobile py-16 md:px-8 lg:py-24"
        >
          <h2 id="principles-title" className="font-serif text-headline-mobile md:text-headline-lg">
            Calm by design
          </h2>
          <ul className="grid gap-8 md:grid-cols-3">
            {principles.map((principle) => (
              <li key={principle.title} className="space-y-2 border-t border-action-secondary pt-4">
                <h3 className="text-label-lg font-semibold uppercase">{principle.title}</h3>
                <p className="text-body-md text-ink-muted">{principle.body}</p>
              </li>
            ))}
          </ul>
          <ButtonLink href="/preview" variant="secondary">
            Explore the preview
          </ButtonLink>
        </section>
      </main>

      <footer className="border-t border-border-hairline">
        <div className="mx-auto max-w-6xl space-y-1 px-margin-mobile py-8 text-body-sm text-ink-muted md:px-8">
          <p>Wedding Workspace is a working name for a product in development.</p>
          <p>No accounts, payments or messages are active yet.</p>
        </div>
      </footer>
    </>
  );
}
