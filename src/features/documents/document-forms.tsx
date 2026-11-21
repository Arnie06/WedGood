"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABELS } from "@/domain/documents/validate";
import {
  archiveDocument,
  linkDocument,
  unlinkDocument,
  updateDocument,
  uploadDocument,
  type DocumentActionState,
} from "@/server/documents/actions";

const idle: DocumentActionState = { status: "idle" };

export type LinkOption = { value: string; label: string; group: string };

function Feedback({ state }: { state: DocumentActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

function Hidden({ values }: { values: Record<string, string | number> }) {
  return Object.entries(values).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

function LinkOptions({ options }: { options: readonly LinkOption[] }) {
  const groups = [...new Set(options.map((o) => o.group))];
  return groups.map((g) => (
    <optgroup key={g} label={g}>
      {options
        .filter((o) => o.group === g)
        .map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
    </optgroup>
  ));
}

export function UploadForm({
  workspaceId,
  options,
  defaultLink,
  accept,
}: {
  workspaceId: string;
  options: readonly LinkOption[];
  defaultLink: string;
  accept: string;
}) {
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    async (prev: DocumentActionState, form: FormData) => {
      const next = await uploadDocument(prev, form);
      if (next.status === "ok") setCreated((n) => n + 1);
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: string, d = "") => echoed?.[k] ?? d;
  return (
    <form action={formAction} className="space-y-4" noValidate key={created}>
      <Hidden values={{ workspaceId }} />
      <input type="hidden" name="idempotencyKey" value={`${keyBase}-${created}`} />
      <TextField
        label="File"
        hint="PDF, JPEG, PNG or WebP, up to 10 MB."
        name="file"
        type="file"
        accept={accept}
        required
        error={errors.file}
      />
      <TextField
        label="Name"
        hint="Leave blank to use the file name."
        name="title"
        maxLength={160}
        autoComplete="off"
        defaultValue={v("title")}
        error={errors.title}
      />
      <SelectField
        key={`kind:${v("kind", "contract")}`}
        label="What kind of document?"
        name="kind"
        defaultValue={v("kind", "contract")}
        error={errors.kind}
      >
        {DOCUMENT_KINDS.map((k) => (
          <option key={k} value={k}>
            {DOCUMENT_KIND_LABELS[k]}
          </option>
        ))}
      </SelectField>
      <SelectField
        key={`link:${v("link", defaultLink)}`}
        label="Attach to (optional)"
        hint="You can attach it later too."
        name="link"
        defaultValue={v("link", defaultLink)}
        error={errors.link}
      >
        <option value="">Not attached yet</option>
        <LinkOptions options={options} />
      </SelectField>
      <Button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Upload document"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function EditDocumentForm({
  workspaceId,
  documentId,
  version,
  title,
  kind,
}: {
  workspaceId: string;
  documentId: string;
  version: number;
  title: string;
  kind: string;
}) {
  const [state, formAction, pending] = useActionState(updateDocument, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Hidden values={{ workspaceId, documentId, version }} />
      <TextField
        label="Name"
        name="title"
        required
        maxLength={160}
        autoComplete="off"
        defaultValue={echoed?.title ?? title}
        error={errors.title}
      />
      <SelectField
        key={`kind:${echoed?.kind ?? kind}`}
        label="Kind"
        name="kind"
        defaultValue={echoed?.kind ?? kind}
        error={errors.kind}
      >
        {DOCUMENT_KINDS.map((k) => (
          <option key={k} value={k}>
            {DOCUMENT_KIND_LABELS[k]}
          </option>
        ))}
      </SelectField>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveDocumentForm({
  workspaceId,
  documentId,
  version,
}: {
  workspaceId: string;
  documentId: string;
  version: number;
}) {
  const [state, formAction, pending] = useActionState(archiveDocument, idle);
  return (
    <form action={formAction} className="space-y-3">
      <Hidden values={{ workspaceId, documentId, version }} />
      <p className="text-body-sm text-ink-muted">
        An archived document stays stored but can no longer be downloaded or attached.
      </p>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Archiving…" : "Archive this document"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function AttachDocumentForm({
  workspaceId,
  documentId,
  options,
}: {
  workspaceId: string;
  documentId: string;
  options: readonly LinkOption[];
}) {
  const [state, formAction, pending] = useActionState(linkDocument, idle);
  const echoed = state.status === "error" ? state.values.link : undefined;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, documentId }} />
      <SelectField
        key={`link:${echoed ?? ""}`}
        label="Attach to"
        name="link"
        required
        defaultValue={echoed ?? ""}
        error={state.status === "error" ? state.fieldErrors.link : undefined}
      >
        <option value="">Choose…</option>
        <LinkOptions options={options} />
      </SelectField>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Attaching…" : "Attach"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function DetachButton({
  workspaceId,
  documentId,
  link,
  label,
}: {
  workspaceId: string;
  documentId: string;
  link: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(unlinkDocument, idle);
  return (
    <form action={formAction} className="inline">
      <Hidden values={{ workspaceId, documentId, link }} />
      <Button
        type="submit"
        variant="quiet"
        size="sm"
        disabled={pending}
        aria-label={`Detach from ${label}`}
      >
        {pending ? "Detaching…" : "Detach"}
      </Button>
      {state.status === "error" && (
        <span role="alert" className="text-body-sm text-danger">
          {state.message}
        </span>
      )}
    </form>
  );
}
