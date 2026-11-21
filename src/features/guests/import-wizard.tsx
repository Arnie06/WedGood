"use client";

import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, type ImportField } from "@/domain/guests/import";
import {
  commitGuestImport,
  previewGuestImport,
  type ImportCommitResult,
  type ImportPreviewResult,
} from "@/server/guests/actions";

type Mapping = Partial<Record<ImportField, number>>;
const MAX_BYTES = 256 * 1024;

const statusLabel = { ready: "Ready", duplicate: "Possible duplicate", invalid: "Needs fixing" };
const statusTone = { ready: "confirmed", duplicate: "pending", invalid: "neutral" } as const;

export function ImportWizard({ workspaceId, listHref }: { workspaceId: string; listHref: string }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | undefined>();
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [pending, startTransition] = useTransition();
  // One key per loaded file and mapping: a retried or double-clicked commit cannot import twice.
  const keyRef = useRef(crypto.randomUUID());
  const resultRef = useRef<HTMLDivElement>(null);

  function runPreview(text: string, nextMapping?: Mapping) {
    startTransition(async () => {
      const res = await previewGuestImport({
        workspaceId,
        csv: text,
        ...(nextMapping && { mapping: nextMapping }),
      });
      setPreview(res);
      if (res.ok) setMapping(res.mapping);
    });
  }

  async function onFile(file: File | undefined) {
    setResult(null);
    setPreview(null);
    setFileError(undefined);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setCsv(null);
      setFileError("That file is larger than 256 KB. Split it into smaller files.");
      return;
    }
    const text = await file.text();
    keyRef.current = crypto.randomUUID();
    setCsv(text);
    setFileName(file.name);
    setIncludeDuplicates(false);
    setAcknowledged(false);
    runPreview(text);
  }

  function changeMapping(field: ImportField, value: string) {
    if (!csv) return;
    const next = { ...mapping };
    if (value === "") delete next[field];
    else next[field] = Number(value);
    keyRef.current = crypto.randomUUID();
    setMapping(next);
    runPreview(csv, next);
  }

  function commit() {
    if (!csv) return;
    startTransition(async () => {
      const res = await commitGuestImport({
        workspaceId,
        csv,
        mapping,
        includeDuplicates,
        acknowledged,
        idempotencyKey: keyRef.current,
      });
      setResult(res);
      requestAnimationFrame(() => resultRef.current?.focus());
    });
  }

  const ok = preview?.ok ? preview : null;
  const usable = ok && !ok.mappingError;
  const importCount = ok ? ok.counts.ready + (includeDuplicates ? ok.counts.duplicate : 0) : 0;

  if (result?.ok) {
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="space-y-4">
        <Card>
          <CardTitle>Import complete</CardTitle>
          <p className="mt-2 text-body-md">
            Added {result.imported} {result.imported === 1 ? "guest" : "guests"}.
            {result.skipped.duplicates > 0 &&
              ` Left out ${result.skipped.duplicates} possible ${result.skipped.duplicates === 1 ? "duplicate" : "duplicates"}.`}
            {result.skipped.invalid > 0 &&
              ` Left out ${result.skipped.invalid} ${result.skipped.invalid === 1 ? "row" : "rows"} that needed fixing.`}
          </p>
          <p className="mt-4">
            <a
              href={listHref}
              className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
            >
              View your guest list
            </a>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-3">
          <TextField
            label="CSV file"
            hint="A spreadsheet saved as CSV, up to 256 KB and 500 guests. Nothing is saved until you confirm."
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
            error={fileError}
          />
          {fileName && <p className="text-body-sm text-ink-muted">Loaded {fileName}.</p>}
        </div>
      </Card>

      <div aria-live="polite">
        {pending && !preview && <p className="text-body-md text-ink-muted">Reading your file…</p>}
        {preview && !preview.ok && (
          <p role="alert" className="text-body-md text-danger">
            {preview.error}
          </p>
        )}
      </div>

      {ok && (
        <section aria-labelledby="map" className="space-y-3">
          <h2 id="map" className="font-serif text-headline-sm">
            Match your columns
          </h2>
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              {IMPORT_FIELDS.map((field) => (
                <SelectField
                  key={`${field}:${mapping[field] ?? ""}`}
                  label={IMPORT_FIELD_LABELS[field]}
                  name={field}
                  value={mapping[field]?.toString() ?? ""}
                  onChange={(e) => changeMapping(field, e.target.value)}
                >
                  <option value="">Don&apos;t import</option>
                  {ok.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </SelectField>
              ))}
            </div>
            {ok.mappingError && (
              <p role="alert" className="mt-4 text-body-md text-danger">
                {ok.mappingError}
              </p>
            )}
          </Card>
        </section>
      )}

      {usable && (
        <section aria-labelledby="review" className="space-y-3">
          <h2 id="review" className="font-serif text-headline-sm">
            Review before importing
          </h2>
          <p className="text-body-md" role="status">
            {ok.counts.ready} ready · {ok.counts.duplicate} possible duplicates ·{" "}
            {ok.counts.invalid} need fixing
          </p>
          <ul className="space-y-2">
            {ok.rows.slice(0, 100).map((r) => (
              <li key={r.line}>
                <Card className="p-4 sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold break-words">
                      {r.name || <span className="text-ink-muted">No name</span>}
                      <span className="font-normal text-ink-muted"> · line {r.line}</span>
                    </p>
                    <Badge tone={statusTone[r.status]}>{statusLabel[r.status]}</Badge>
                  </div>
                  {(r.household || r.email || r.hasPrivateDetails) && (
                    <p className="text-body-sm break-words text-ink-muted">
                      {[
                        r.household && `Household: ${r.household}`,
                        r.email,
                        r.hasPrivateDetails && "Has private details",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {r.duplicateOf && (
                    <p className="text-body-sm">
                      Looks like {r.duplicateOf}. It is left out unless you include duplicates.
                    </p>
                  )}
                  {Object.values(r.errors).length > 0 && (
                    <ul className="text-body-sm text-danger">
                      {Object.entries(r.errors).map(([f, msg]) => (
                        <li key={f}>
                          {IMPORT_FIELD_LABELS[f as ImportField]}: {msg}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
          {ok.rows.length > 100 && (
            <p className="text-body-sm text-ink-muted">
              Showing the first 100 of {ok.rows.length} rows. All rows are checked.
            </p>
          )}

          <Card>
            <div className="space-y-4">
              {ok.counts.duplicate > 0 && (
                <label className="flex min-h-11 items-start gap-3 text-body-md">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={includeDuplicates}
                    onChange={(e) => {
                      keyRef.current = crypto.randomUUID();
                      setIncludeDuplicates(e.target.checked);
                    }}
                  />
                  <span>
                    Also add the {ok.counts.duplicate} possible{" "}
                    {ok.counts.duplicate === 1 ? "duplicate" : "duplicates"} as new people. Two
                    different guests can share a name or an email.
                  </span>
                </label>
              )}
              <label className="flex min-h-11 items-start gap-3 text-body-md">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>
                  I have these guests&apos; contact details for wedding planning and will only share
                  them as needed. Nothing is emailed or sent to them by importing.
                </span>
              </label>
              {result && !result.ok && (
                <p role="alert" className="text-body-md text-danger">
                  {result.error}
                </p>
              )}
              <Button
                type="button"
                onClick={commit}
                disabled={pending || importCount === 0 || !acknowledged}
              >
                {pending
                  ? "Importing…"
                  : `Import ${importCount} ${importCount === 1 ? "guest" : "guests"}`}
              </Button>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}
