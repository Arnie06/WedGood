import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hallmark } from "@/components/shell/hallmark";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Ornament } from "@/components/ui/ornament";
import { ProgressBar } from "@/components/ui/progress-bar";
import { TextField } from "@/components/ui/text-field";

export const metadata: Metadata = {
  title: "Design reference",
  robots: { index: false, follow: false },
};

const swatches: ReadonlyArray<{ name: string; bg: string; fg: string; use: string }> = [
  {
    name: "action-primary",
    bg: "bg-action-primary",
    fg: "text-on-action-primary",
    use: "Primary buttons",
  },
  {
    name: "action-emphasis",
    bg: "bg-action-emphasis",
    fg: "text-on-action-emphasis",
    use: "High emphasis, selected nav",
  },
  {
    name: "action-secondary",
    bg: "bg-action-secondary",
    fg: "text-on-action-secondary",
    use: "Organizational controls",
  },
  { name: "canvas", bg: "bg-canvas", fg: "text-ink", use: "Page background" },
  { name: "surface", bg: "bg-surface", fg: "text-ink", use: "Cards" },
  { name: "surface-sunken", bg: "bg-surface-sunken", fg: "text-ink", use: "Inputs, quiet panels" },
  {
    name: "status-confirmed",
    bg: "bg-status-confirmed-bg",
    fg: "text-status-confirmed-fg",
    use: "Confirmed",
  },
  {
    name: "status-pending",
    bg: "bg-status-pending-bg",
    fg: "text-status-pending-fg",
    use: "Pending",
  },
  {
    name: "status-ceremony",
    bg: "bg-status-ceremony-bg",
    fg: "text-status-ceremony-fg",
    use: "Ceremony, VIP",
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="space-y-5">
      <h2 id={id} className="font-serif text-headline-md">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto max-w-5xl space-y-14 px-margin-mobile py-10 md:px-8"
    >
      <header className="space-y-4">
        <Hallmark />
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Design reference</h1>
        <p className="max-w-2xl text-body-lg text-ink-muted">
          Internal reference for the Vow &amp; Bloom tokens and components. Colours come from the
          semantic aliases in <code className="font-mono text-body-sm">src/styles/tokens.css</code>.
        </p>
        <Ornament />
      </header>

      <Section title="Colour roles">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {swatches.map((swatch) => (
            <li
              key={swatch.name}
              className={`rounded-card border border-border-hairline p-4 ${swatch.bg} ${swatch.fg}`}
            >
              <p className="text-label-lg font-semibold">{swatch.name}</p>
              <p className="text-body-sm">{swatch.use}</p>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-body-sm text-ink-muted">
          <span aria-hidden="true" className="size-4 rounded-full bg-accent-gold" />
          Antique gold is decoration only. It never carries text or meaning on its own.
        </p>
      </Section>

      <Section title="Typography">
        <div className="space-y-3">
          <p className="font-serif text-display-mobile md:text-display-lg">Display serif</p>
          <p className="font-serif text-headline-lg">Headline large</p>
          <p className="font-serif text-headline-sm">Headline small</p>
          <p className="text-body-lg">Body large in Manrope, for introductions.</p>
          <p className="text-body-md">Body medium, the default interface text.</p>
          <p className="text-label-md font-semibold text-ink-muted uppercase">Label · micro-copy</p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="emphasis">High emphasis</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="quiet">Quiet action</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small primary</Button>
          <Button disabled>Disabled</Button>
          <ButtonLink href="/" variant="outline">
            Link styled as button
          </ButtonLink>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge tone="confirmed">RSVP confirmed</Badge>
          <Badge tone="pending">Awaiting reply</Badge>
          <Badge tone="ceremony">Ceremony</Badge>
          <Badge tone="neutral">Not available yet</Badge>
        </div>
      </Section>

      <Section title="Form fields">
        <div className="grid gap-6 md:grid-cols-2">
          <TextField
            label="Wedding name"
            hint="You can change this later."
            placeholder="e.g. Our wedding"
          />
          <TextField
            label="Guest count"
            inputMode="numeric"
            required
            error="Enter a whole number, or leave it blank."
            defaultValue="about 120"
          />
        </div>
      </Section>

      <Section title="Cards and progress">
        <Card className="max-w-md space-y-4">
          <h3 className="font-serif text-headline-sm">Master card</h3>
          <p className="text-body-md text-ink-muted">White over ivory with a hairline border.</p>
          <ProgressBar label="Example" value={3} max={8} valueText="3 of 8 complete" />
        </Card>
      </Section>
    </main>
  );
}
