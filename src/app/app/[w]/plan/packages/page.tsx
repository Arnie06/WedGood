import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { presetDef } from "@/domain/packages/catalog";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadPackages, packageFreshness } from "@/server/packages/queries";

export const metadata: Metadata = { title: "Packages" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function PackagesPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const allowed = hasCapability(access, "exports.create");
  const packages = allowed ? await loadPackages(access.wedding.id) : [];
  const freshness = allowed ? await packageFreshness(access.wedding.id, packages) : new Map();
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Packages</h1>
        <p className="text-body-lg text-ink-muted">
          Fixed PDF and CSV copies of your plan for the couple, family or vendors. A package
          doesn&apos;t change after it is made; it just tells you when your plan has moved on.
        </p>
      </header>

      {!allowed ? (
        <Card>
          <p className="text-body-md">Only the workspace owner or a partner can see packages.</p>
        </Card>
      ) : (
        <>
          <p>
            <ButtonLink href={`${base}/plan/packages/new`}>Create a package</ButtonLink>
          </p>
          {packages.length === 0 ? (
            <Card>
              <p className="text-body-md text-ink-muted">
                No packages yet. Create one to hand a caterer their headcount, or keep a dated copy
                of your budget.
              </p>
            </Card>
          ) : (
            <ul className="space-y-4">
              {packages.map((p) => {
                const state = freshness.get(p.id) ?? "unknown";
                return (
                  <li key={p.id}>
                    <Card className="space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <CardTitle as="h2">
                          <Link href={`${base}/plan/packages/${p.id}`} className={link}>
                            {p.title}
                          </Link>
                        </CardTitle>
                        {state === "current" ? (
                          <Badge tone="confirmed">Matches your plan</Badge>
                        ) : state === "stale" ? (
                          <Badge tone="pending">Plan has changed</Badge>
                        ) : (
                          <Badge>Not checked</Badge>
                        )}
                      </div>
                      <p className="text-body-md text-ink-muted">
                        {presetDef(p.preset).label}
                        {p.recipient ? ` · for ${p.recipient}` : ""} · made {when(p.createdAt)} UTC
                        · plan revision {p.revision}
                      </p>
                      <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-md">
                        {p.artifacts.map((a) => (
                          <a
                            key={a.format}
                            href={`${base}/plan/packages/${p.id}/download?format=${a.format}`}
                            className={link}
                          >
                            Download {a.format.toUpperCase()}
                          </a>
                        ))}
                      </p>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
