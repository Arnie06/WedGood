import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { NavGroup } from "./nav-groups";

/**
 * Lists the tools a navigation group will contain. Tools that don't exist yet
 * are labelled as such and are not links, so nothing appears to work when it
 * doesn't.
 */
export function SectionOverview({ group }: { group: NavGroup }) {
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{group.label}</h1>
        <p className="max-w-2xl text-body-lg text-ink-muted">{group.summary}</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {group.tools.map((tool) => (
          <Card as="li" key={tool.name} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-serif text-headline-sm">{tool.name}</h2>
              <Badge tone="neutral">Not available yet</Badge>
            </div>
            <p className="text-body-md text-ink-muted">{tool.description}</p>
          </Card>
        ))}
      </ul>
    </div>
  );
}
