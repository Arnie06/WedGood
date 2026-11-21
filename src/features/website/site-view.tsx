import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Ornament } from "@/components/ui/ornament";
import { EVENT_KIND_LABELS, formatEventDate, type EventKind } from "@/domain/events/event";
import type { PublicSite, SiteTemplate } from "@/domain/website/site";
import { cn } from "@/lib/cn";

const kindLabel = (kind: string) =>
  kind in EVENT_KIND_LABELS ? EVENT_KIND_LABELS[kind as EventKind] : EVENT_KIND_LABELS.other;

// Template differences are layout and tone only, built from semantic tokens.
const THEME: Record<
  SiteTemplate,
  { hero: string; section: string; align: string; ornament: boolean }
> = {
  classic: {
    hero: "text-center items-center",
    section: "",
    align: "text-center",
    ornament: true,
  },
  garden: {
    hero: "text-center items-center rounded-card bg-action-secondary-subtle px-4 py-10",
    section: "bg-surface-sunken",
    align: "text-center",
    ornament: true,
  },
  modern: {
    hero: "text-left items-start",
    section: "",
    align: "text-left",
    ornament: false,
  },
};

function Prose({ children }: { children: string }) {
  // Plain text only: React escapes it, newlines are kept visually.
  return <p className="whitespace-pre-line text-body-lg break-words">{children}</p>;
}

export type SiteViewProps = {
  site: PublicSite;
  /** Shown as a banner above the page; never part of the public output. */
  banner?: string;
  /** Present only on the invitation route: where the guest answers. */
  rsvpHref?: string;
};

/** The one renderer for the draft preview, the public page and the invitation page. */
export function SiteView({ site, banner, rsvpHref }: SiteViewProps) {
  const theme = THEME[site.template];
  const date = site.date ? formatEventDate(site.date) : null;
  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:py-12">
      {banner && (
        <p
          role="note"
          className="rounded-control border border-border-control bg-surface-muted p-3 text-body-md"
        >
          {banner}
        </p>
      )}
      <header className={cn("flex flex-col gap-3", theme.hero)}>
        {theme.ornament && <Ornament />}
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {site.title}
        </h1>
        {site.tagline && <p className="text-body-lg text-ink-muted break-words">{site.tagline}</p>}
        {(date || site.location) && (
          <p className="text-label-lg font-semibold text-ink break-words">
            {[date, site.location].filter(Boolean).join(" · ")}
          </p>
        )}
        {site.invitation && (
          <p className="text-body-md text-action-emphasis">
            Welcome, {site.invitation.label}. Here are your details.
          </p>
        )}
        {rsvpHref && (
          <ButtonLink href={rsvpHref} variant="emphasis">
            Reply to your invitation
          </ButtonLink>
        )}
      </header>

      {site.events.length > 0 && (
        <section aria-labelledby="site-events" className="space-y-3">
          <h2 id="site-events" className={cn("font-serif text-headline-sm", theme.align)}>
            {site.events.length === 1 ? "The event" : "The events"}
          </h2>
          <ul className="space-y-3">
            {site.events.map((e, i) => {
              const when = e.localDate ? formatEventDate(e.localDate) : null;
              return (
                <li key={`${e.name}-${i}`}>
                  <Card className={cn("space-y-1", theme.section)}>
                    <CardTitle as="h3">{e.name}</CardTitle>
                    <p className="text-body-md text-ink-muted">
                      {kindLabel(e.kind)}
                      {when ? ` · ${when}` : ""}
                    </p>
                    {e.when && <p className="text-body-md break-words">{e.when}</p>}
                    {e.where && <p className="text-body-md break-words">{e.where}</p>}
                    {e.notes && (
                      <p className="whitespace-pre-line text-body-md break-words">{e.notes}</p>
                    )}
                    {e.visibility === "invited" && (
                      <p className="text-body-sm text-ink-muted">
                        Shared with invited guests only.
                      </p>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {site.story && (
        <section aria-labelledby="site-story" className="space-y-3">
          <h2 id="site-story" className={cn("font-serif text-headline-sm", theme.align)}>
            Our story
          </h2>
          <Prose>{site.story}</Prose>
        </section>
      )}

      {site.travel && (
        <section aria-labelledby="site-travel" className="space-y-3">
          <h2 id="site-travel" className={cn("font-serif text-headline-sm", theme.align)}>
            Travel and stay
          </h2>
          <Prose>{site.travel}</Prose>
        </section>
      )}

      {site.faq.length > 0 && (
        <section aria-labelledby="site-faq" className="space-y-3">
          <h2 id="site-faq" className={cn("font-serif text-headline-sm", theme.align)}>
            Questions
          </h2>
          <dl className="space-y-4">
            {site.faq.map((f, i) => (
              <div key={`${f.q}-${i}`} className="space-y-1">
                <dt className="text-label-lg font-semibold break-words">{f.q}</dt>
                <dd className="whitespace-pre-line text-body-md text-ink-muted break-words">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {site.registry.length > 0 && (
        <section aria-labelledby="site-registry" className="space-y-3">
          <h2 id="site-registry" className={cn("font-serif text-headline-sm", theme.align)}>
            Registry
          </h2>
          <ul className="space-y-2">
            {site.registry.map((r, i) => (
              <li key={`${r.url}-${i}`}>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4 break-all"
                >
                  {r.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
