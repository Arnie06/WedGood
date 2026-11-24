import { WorkspacePageHeading } from "./workspace-page-heading";
import type { NavGroup } from "./nav-groups";

/**
 * Shows the tools for a section in the read-only public preview.
 */
export function SectionOverview({ group }: { group: NavGroup }) {
  return (
    <div className="space-y-6">
      <WorkspacePageHeading title={group.label} description={group.summary} />
      <section aria-label={`${group.label} tools`} className="space-y-2">
        <p className="text-body-sm text-ink-muted">
          These tools are available in a wedding workspace.
        </p>
        <ul className="record-list">
          {group.tools.map((tool) => (
            <li
              key={tool.name}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4"
            >
              <h2 className="text-body-md font-semibold">{tool.name}</h2>
              <p className="text-body-sm text-ink-muted">{tool.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
