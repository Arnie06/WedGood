import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { buttonClasses } from "@/components/ui/button";
import {
  FORMATS,
  PRESETS,
  SECTIONS,
  isPresetId,
  parsePackageRequest,
  presetDef,
  sectionDef,
  type RawRequest,
} from "@/domain/packages/catalog";
import { countPdfReplacements } from "@/domain/packages/document";
import { buildDocument } from "@/domain/packages/sections";
import { capabilitiesFor } from "@/domain/permissions";
import { PackageDocumentView } from "@/features/packages/package-document-view";
import { CreatePackageForm } from "@/features/packages/package-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { documentDigest } from "@/server/packages/digest";
import { newPreviewIds } from "@/server/packages/preview-ids";
import { loadProjection } from "@/server/packages/projection";

export const metadata: Metadata = { title: "Create a package" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const checkbox = "flex min-h-11 items-start gap-3 py-2 text-body-md";

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export default async function NewPackagePage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<Query>;
}) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const query = await searchParams;

  const header = (
    <header className="space-y-2">
      <h1 className="font-serif text-headline-mobile md:text-headline-lg">Create a package</h1>
      <p className="text-body-lg text-ink-muted">
        A package is a PDF or CSV of part of your plan, made for one reader.{" "}
        <Link href={`${base}/plan/packages`} className={link}>
          Your packages
        </Link>
      </p>
    </header>
  );

  if (!hasCapability(access, "exports.create")) {
    return (
      <div className="max-w-3xl space-y-8">
        {header}
        <Card>
          <p className="text-body-md">Only the workspace owner or a partner can create packages.</p>
        </Card>
      </div>
    );
  }

  const presetParam = one(query.preset);
  if (!isPresetId(presetParam)) {
    return (
      <div className="max-w-3xl space-y-8">
        {header}
        <section aria-labelledby="start" className="space-y-3">
          <h2 id="start" className="font-serif text-headline-sm">
            Who is it for?
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {PRESETS.map((p) => (
              <li key={p.id}>
                <Card className="h-full space-y-2">
                  <CardTitle as="h3">{p.label}</CardTitle>
                  <p className="text-body-md text-ink-muted">{p.summary}</p>
                  <Link href={`${base}/plan/packages/new?preset=${p.id}`} className={link}>
                    Start with {p.label.toLowerCase()}
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
          <p className="text-body-sm text-ink-muted">
            A starting point is only a suggestion. You choose the sections on the next step, and
            guest names, dietary details, links and files are never included.
          </p>
        </section>
      </div>
    );
  }

  const preset = presetDef(presetParam);
  const customized = one(query.customized) === "1";
  const previewing = one(query.preview) === "1";
  const raw: RawRequest = {
    preset: presetParam,
    title: one(query.title),
    recipient: one(query.recipient),
    paper: one(query.paper),
    orientation: one(query.orientation),
    ...(customized
      ? {
          sections: many(query.sections),
          formats: many(query.formats),
          includeContacts: one(query.includeContacts),
          includeNotes: one(query.includeNotes),
        }
      : {}),
  };
  const allowed = capabilitiesFor(access.membership.role, access.membership.grants);
  const parsed = parsePackageRequest(raw, allowed, access.wedding.name);
  const errors = !parsed.ok ? parsed.errors : {};
  const checked = new Set<string>(
    parsed.ok ? parsed.value.sections : customized ? many(query.sections) : preset.sections,
  );
  const formats = new Set<string>(
    parsed.ok ? parsed.value.formats : customized ? many(query.formats) : ["pdf"],
  );
  const opts = parsed.ok ? parsed.value.options : { includeContacts: false, includeNotes: false };

  let preview: React.ReactNode = null;
  if (previewing && parsed.ok) {
    const projection = await loadProjection(access.wedding.id, parsed.value.sections);
    const doc = buildDocument(parsed.value, projection);
    const digest = documentDigest(doc);
    const ids = newPreviewIds();
    const replaced = parsed.value.formats.includes("pdf") ? countPdfReplacements(doc) : 0;
    preview = (
      <section aria-labelledby="preview" className="space-y-5">
        <div className="space-y-2">
          <h2 id="preview" className="font-serif text-headline-sm">
            Preview
          </h2>
          <p className="text-body-md text-ink-muted">
            This is exactly what the{" "}
            {parsed.value.formats.map((f) => f.toUpperCase()).join(" and ")} will contain, as of
            plan revision {projection.revision}. It is a snapshot and does not change when your plan
            does.
          </p>
        </div>
        <Card className="space-y-2">
          <CardTitle as="h3">What this shares</CardTitle>
          <ul className="list-disc space-y-1 pl-5 text-body-md">
            {parsed.value.sections.map((id) => (
              <li key={id}>
                <span className="font-semibold">{sectionDef(id).label}:</span>{" "}
                {sectionDef(id).shares}
              </li>
            ))}
            {parsed.value.options.includeContacts && (
              <li>Contact details you added to schedule items are included.</li>
            )}
            {parsed.value.options.includeNotes && (
              <li>Notes you added to schedule items and design items are included.</li>
            )}
          </ul>
          {parsed.dropped.length > 0 && (
            <p className="text-body-sm text-ink-muted">
              Left out because your role can&apos;t include them:{" "}
              {parsed.dropped.map((id) => sectionDef(id).label).join(", ")}.
            </p>
          )}
          {replaced > 0 && (
            <p role="note" className="text-body-sm text-ink-muted">
              {replaced} {replaced === 1 ? "character" : "characters"} can&apos;t be shown in the
              PDF and will be simplified (for example é stays, but 李 becomes ?). The CSV keeps
              every character.
            </p>
          )}
        </Card>
        <div className="rounded-card border border-border-hairline bg-surface p-4 sm:p-6">
          <p className="mb-6 font-serif text-headline-sm">{doc.title}</p>
          <PackageDocumentView doc={doc} />
        </div>
        <CreatePackageForm
          fields={{
            workspaceId: access.wedding.id,
            packageId: ids.packageId,
            generatedAt: ids.generatedAt,
            digest,
            revision: projection.revision,
            title: parsed.value.title,
            preset: parsed.value.preset,
            recipient: parsed.value.recipient,
            sections: parsed.value.sections,
            includeContacts: parsed.value.options.includeContacts,
            includeNotes: parsed.value.options.includeNotes,
            formats: parsed.value.formats,
            paper: parsed.value.paper,
            orientation: parsed.value.orientation,
          }}
        />
      </section>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      {header}
      <form method="get" className="space-y-6" noValidate>
        <input type="hidden" name="preset" value={preset.id} />
        <input type="hidden" name="customized" value="1" />
        <input type="hidden" name="preview" value="1" />
        {previewing && !parsed.ok && (
          <p role="alert" className="text-body-md text-danger">
            Please check the highlighted details.
          </p>
        )}
        <Card className="space-y-4">
          <CardTitle>{preset.label}</CardTitle>
          <p className="text-body-md text-ink-muted">{preset.summary}</p>
          <TextField
            label="Title"
            name="title"
            maxLength={120}
            defaultValue={one(query.title)}
            placeholder={`${access.wedding.name} · ${preset.label}`}
            error={errors.title}
          />
          <TextField
            label="Prepared for"
            name="recipient"
            maxLength={80}
            defaultValue={one(query.recipient)}
            placeholder={preset.recipient || "Who will read it"}
            hint="Shown on the cover and in the footer. It does not send anything."
            error={errors.recipient}
          />
        </Card>

        <fieldset className="space-y-1">
          <legend className="font-serif text-headline-sm">Sections</legend>
          {errors.sections && (
            <p role="alert" className="text-body-md text-danger">
              {errors.sections}
            </p>
          )}
          {SECTIONS.map((s) => (
            <label key={s.id} className={checkbox}>
              <input
                type="checkbox"
                name="sections"
                value={s.id}
                defaultChecked={checked.has(s.id)}
                disabled={!allowed.has(s.capability)}
                className="mt-1 size-5 shrink-0"
              />
              <span>
                <span className="font-semibold">{s.label}</span>
                <span className="block text-body-sm text-ink-muted">{s.description}</span>
                <span className="block text-body-sm text-ink-muted">Shares: {s.shares}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="font-serif text-headline-sm">Private details</legend>
          <p className="text-body-sm text-ink-muted">
            Left out unless you choose them. Guest names, dietary details, prices, links and files
            are never included.
          </p>
          <label className={checkbox}>
            <input
              type="checkbox"
              name="includeContacts"
              value="on"
              defaultChecked={opts.includeContacts}
              className="mt-1 size-5 shrink-0"
            />
            <span>Include contact details on schedule items</span>
          </label>
          <label className={checkbox}>
            <input
              type="checkbox"
              name="includeNotes"
              value="on"
              defaultChecked={opts.includeNotes}
              className="mt-1 size-5 shrink-0"
            />
            <span>Include notes on schedule and design items</span>
          </label>
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="font-serif text-headline-sm">Format</legend>
          {errors.formats && (
            <p role="alert" className="text-body-md text-danger">
              {errors.formats}
            </p>
          )}
          {FORMATS.map((f) => (
            <label key={f} className={checkbox}>
              <input
                type="checkbox"
                name="formats"
                value={f}
                defaultChecked={formats.has(f)}
                className="mt-1 size-5 shrink-0"
              />
              <span>
                {f === "pdf" ? "PDF" : "CSV"}
                <span className="block text-body-sm text-ink-muted">
                  {f === "pdf"
                    ? "A readable document with page numbers."
                    : "One flat table, one row per value. Opens in a spreadsheet but is not a workbook."}
                </span>
              </span>
            </label>
          ))}
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            <SelectField label="Paper (PDF)" name="paper" defaultValue={one(query.paper) || "a4"}>
              <option value="a4">A4</option>
              <option value="letter">US Letter</option>
            </SelectField>
            <SelectField
              label="Orientation (PDF)"
              name="orientation"
              defaultValue={one(query.orientation) || "portrait"}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape (wide tables)</option>
            </SelectField>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button type="submit" className={buttonClasses({ variant: "secondary" })}>
            {previewing ? "Update preview" : "Preview package"}
          </button>
          <Link href={`${base}/plan/packages/new`} className={link}>
            Choose a different starting point
          </Link>
        </div>
      </form>
      {preview}
    </div>
  );
}
