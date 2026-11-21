"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { createPackage, type PackageActionState } from "@/server/packages/actions";

const idle: PackageActionState = { status: "idle" };

export type CreateFields = {
  workspaceId: string;
  packageId: string;
  generatedAt: string;
  digest: string;
  revision: number;
  title: string;
  preset: string;
  recipient: string;
  sections: string[];
  includeContacts: boolean;
  includeNotes: boolean;
  formats: string[];
  paper: string;
  orientation: string;
};

/** Posts exactly what the preview showed; the server re-derives it and refuses on any change. */
export function CreatePackageForm({ fields }: { fields: CreateFields }) {
  const [state, formAction, pending] = useActionState(createPackage, idle);
  const flat: [string, string][] = [
    ["workspaceId", fields.workspaceId],
    ["packageId", fields.packageId],
    ["generatedAt", fields.generatedAt],
    ["digest", fields.digest],
    ["revision", String(fields.revision)],
    ["title", fields.title],
    ["preset", fields.preset],
    ["recipient", fields.recipient],
    ["paper", fields.paper],
    ["orientation", fields.orientation],
    ...fields.sections.map((s): [string, string] => ["sections", s]),
    ...fields.formats.map((s): [string, string] => ["formats", s]),
    ...(fields.includeContacts ? ([["includeContacts", "on"]] as [string, string][]) : []),
    ...(fields.includeNotes ? ([["includeNotes", "on"]] as [string, string][]) : []),
  ];
  return (
    <form action={formAction} className="space-y-3">
      {flat.map(([name, value], i) => (
        <input key={`${name}-${i}`} type="hidden" name={name} value={value} />
      ))}
      <p className="text-body-md text-ink-muted">
        Creating a package saves a fixed copy and makes files you can download. Nothing is sent to
        anyone. Once you share a downloaded file, it can&apos;t be taken back.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create package"}
      </Button>
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
