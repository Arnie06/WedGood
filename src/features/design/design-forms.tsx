"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { RIGHTS, RIGHTS_LABELS, type ItemKind, type Rights } from "@/domain/design/board";
import {
  addItem,
  archiveBoard,
  createBoard,
  moveItem,
  removeItem,
  setFavorite,
  updateBoard,
  updateItem,
  uploadImage,
  type DesignActionState,
} from "@/server/design/actions";

const idle: DesignActionState = { status: "idle" };

export type VendorChoice = { id: string; label: string };

function Feedback({ state }: { state: DesignActionState }) {
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

/** A key that stays stable for double-submits but changes after any finished attempt. */
function useAttemptKey() {
  const [base] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState(0);
  return { key: `${base}-${attempt}`, next: () => setAttempt((n) => n + 1) };
}

function VendorSelect({
  vendors,
  value,
  error,
}: {
  vendors: readonly VendorChoice[];
  value: string;
  error?: string | undefined;
}) {
  return (
    <SelectField
      key={`candidate:${value}`}
      label="Link to a vendor (optional)"
      name="candidate"
      defaultValue={value}
      error={error}
    >
      <option value="">Not linked</option>
      {vendors.map((v) => (
        <option key={v.id} value={v.id}>
          {v.label}
        </option>
      ))}
    </SelectField>
  );
}

function RightsSelect({ value, error }: { value: string; error?: string | undefined }) {
  return (
    <SelectField
      key={`rights:${value}`}
      label="Can you use this image?"
      hint="This stays private to your workspace. It isn't published anywhere."
      name="rights"
      required
      defaultValue={value}
      error={error}
    >
      <option value="">Choose…</option>
      {RIGHTS.map((r) => (
        <option key={r} value={r}>
          {RIGHTS_LABELS[r]}
        </option>
      ))}
    </SelectField>
  );
}

// ---------------------------------------------------------------- boards
export function NewBoardForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const attempt = useAttemptKey();
  const [created, setCreated] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (prev: DesignActionState, form: FormData) => {
      const next = await createBoard(prev, form);
      if (next.status === "ok" && next.id) {
        setCreated((n) => n + 1);
        router.push(`/app/${workspaceId}/design/${next.id}`);
      }
      attempt.next();
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate key={created}>
      <Hidden values={{ workspaceId, idempotencyKey: attempt.key }} />
      <TextField
        label="Board name"
        name="title"
        required
        maxLength={120}
        autoComplete="off"
        placeholder="e.g. Florals and table styling"
        defaultValue={echoed?.title ?? ""}
        error={errors.title}
      />
      <TextAreaField
        label="What is it for? (optional)"
        name="description"
        maxLength={1000}
        defaultValue={echoed?.description ?? ""}
        error={errors.description}
      />
      <TextField
        label="Palette (optional)"
        hint="Up to 8 hex colours, such as #D88C9A #3D5A50."
        name="palette"
        autoComplete="off"
        defaultValue={echoed?.palette ?? ""}
        error={errors.palette}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create board"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function EditBoardForm({
  workspaceId,
  boardId,
  version,
  title,
  description,
  palette,
}: {
  workspaceId: string;
  boardId: string;
  version: number;
  title: string;
  description: string;
  palette: string;
}) {
  const [state, formAction, pending] = useActionState(updateBoard, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Hidden values={{ workspaceId, boardId, version }} />
      <TextField
        label="Board name"
        name="title"
        required
        maxLength={120}
        autoComplete="off"
        defaultValue={echoed?.title ?? title}
        error={errors.title}
      />
      <TextAreaField
        label="Description"
        name="description"
        maxLength={1000}
        defaultValue={echoed?.description ?? description}
        error={errors.description}
      />
      <TextField
        label="Palette"
        hint="Up to 8 hex colours separated by spaces or commas. Clear it to remove the palette."
        name="palette"
        autoComplete="off"
        defaultValue={echoed?.palette ?? palette}
        error={errors.palette}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save board"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveBoardForm({
  workspaceId,
  boardId,
  version,
  basePath,
}: {
  workspaceId: string;
  boardId: string;
  version: number;
  basePath: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (prev: DesignActionState, form: FormData) => {
      const next = await archiveBoard(prev, form);
      if (next.status === "ok") router.push(basePath);
      return next;
    },
    idle,
  );
  return (
    <form action={formAction} className="space-y-3">
      <Hidden values={{ workspaceId, boardId, version }} />
      <p className="text-body-sm text-ink-muted">
        An archived board and its images are hidden from everyone in the workspace.
      </p>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Archiving…" : "Archive this board"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- adding items
export function AddItemForm({
  workspaceId,
  boardId,
  kind,
  vendors,
}: {
  workspaceId: string;
  boardId: string;
  kind: "link" | "note";
  vendors: readonly VendorChoice[];
}) {
  const attempt = useAttemptKey();
  const [reset, setReset] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (prev: DesignActionState, form: FormData) => {
      const next = await addItem(prev, form);
      if (next.status === "ok") setReset((n) => n + 1);
      attempt.next();
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate key={reset}>
      <Hidden values={{ workspaceId, boardId, kind, idempotencyKey: attempt.key }} />
      {kind === "link" && (
        <TextField
          label="Link"
          hint="We save the address only. We never open it or copy anything from the page."
          name="url"
          type="url"
          inputMode="url"
          required
          autoComplete="off"
          placeholder="https://"
          defaultValue={echoed?.url ?? ""}
          error={errors.url}
        />
      )}
      <TextField
        label={kind === "link" ? "Title" : "Note title"}
        name="title"
        required
        maxLength={160}
        autoComplete="off"
        defaultValue={echoed?.title ?? ""}
        error={errors.title}
      />
      <TextAreaField
        label={kind === "link" ? "Why you saved it (optional)" : "Note (optional)"}
        name="note"
        maxLength={1000}
        defaultValue={echoed?.note ?? ""}
        error={errors.note}
      />
      <VendorSelect vendors={vendors} value={echoed?.candidate ?? ""} error={errors.candidate} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : kind === "link" ? "Save link" : "Add note"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function UploadImageForm({
  workspaceId,
  boardId,
  vendors,
  accept,
}: {
  workspaceId: string;
  boardId: string;
  vendors: readonly VendorChoice[];
  accept: string;
}) {
  const attempt = useAttemptKey();
  const [reset, setReset] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (prev: DesignActionState, form: FormData) => {
      const next = await uploadImage(prev, form);
      if (next.status === "ok") setReset((n) => n + 1);
      attempt.next();
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate key={reset}>
      <Hidden values={{ workspaceId, boardId, idempotencyKey: attempt.key }} />
      <TextField
        label="Image"
        hint="JPEG, PNG or WebP, up to 5 MB. Photo details such as location aren't removed."
        name="file"
        type="file"
        accept={accept}
        required
        error={errors.file}
      />
      <TextField
        label="Title"
        hint="Leave blank to use the file name."
        name="title"
        maxLength={160}
        autoComplete="off"
        defaultValue={echoed?.title ?? ""}
        error={errors.title}
      />
      <TextAreaField
        label="Note (optional)"
        name="note"
        maxLength={1000}
        defaultValue={echoed?.note ?? ""}
        error={errors.note}
      />
      <RightsSelect value={echoed?.rights ?? ""} error={errors.rights} />
      <VendorSelect vendors={vendors} value={echoed?.candidate ?? ""} error={errors.candidate} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Uploading…" : "Add image"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- item controls
export function FavoriteButton({
  workspaceId,
  itemId,
  version,
  favorite,
  title,
}: {
  workspaceId: string;
  itemId: string;
  version: number;
  favorite: boolean;
  title: string;
}) {
  const [state, formAction, pending] = useActionState(setFavorite, idle);
  return (
    <form action={formAction} className="inline-flex flex-col">
      <Hidden values={{ workspaceId, itemId, version, favorite: favorite ? "false" : "true" }} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-pressed={favorite}
        aria-label={`${favorite ? "Remove from favourites" : "Mark as favourite"}: ${title}`}
      >
        {favorite ? "★ Favourite" : "☆ Favourite"}
      </Button>
      {state.status === "error" && (
        <span role="alert" className="text-body-sm text-danger">
          {state.message}
        </span>
      )}
    </form>
  );
}

export function MoveButtons({
  workspaceId,
  itemId,
  title,
  first,
  last,
}: {
  workspaceId: string;
  itemId: string;
  title: string;
  first: boolean;
  last: boolean;
}) {
  const [state, formAction, pending] = useActionState(moveItem, idle);
  return (
    <form action={formAction} className="inline-flex flex-wrap items-center gap-2">
      <Hidden values={{ workspaceId, itemId }} />
      <Button
        type="submit"
        name="direction"
        value="earlier"
        variant="quiet"
        size="sm"
        disabled={pending || first}
        aria-label={`Move earlier: ${title}`}
      >
        Move earlier
      </Button>
      <Button
        type="submit"
        name="direction"
        value="later"
        variant="quiet"
        size="sm"
        disabled={pending || last}
        aria-label={`Move later: ${title}`}
      >
        Move later
      </Button>
      {state.status === "error" && (
        <span role="alert" className="text-body-sm text-danger">
          {state.message}
        </span>
      )}
    </form>
  );
}

export function EditItemForm({
  workspaceId,
  item,
  vendors,
}: {
  workspaceId: string;
  item: {
    id: string;
    kind: ItemKind;
    version: number;
    title: string;
    note: string;
    url: string;
    candidateId: string;
    rights: Rights | null;
  };
  vendors: readonly VendorChoice[];
}) {
  const [state, formAction, pending] = useActionState(updateItem, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Hidden values={{ workspaceId, itemId: item.id, version: item.version, kind: item.kind }} />
      {item.kind === "link" && (
        <TextField
          label="Link"
          name="url"
          type="url"
          inputMode="url"
          required
          autoComplete="off"
          defaultValue={echoed?.url ?? item.url}
          error={errors.url}
        />
      )}
      <TextField
        label="Title"
        name="title"
        required
        maxLength={160}
        autoComplete="off"
        defaultValue={echoed?.title ?? item.title}
        error={errors.title}
      />
      <TextAreaField
        label="Note"
        name="note"
        maxLength={1000}
        defaultValue={echoed?.note ?? item.note}
        error={errors.note}
      />
      {item.kind === "image" && (
        <RightsSelect value={echoed?.rights ?? item.rights ?? ""} error={errors.rights} />
      )}
      <VendorSelect
        vendors={vendors}
        value={echoed?.candidate ?? item.candidateId}
        error={errors.candidate}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveItemForm({
  workspaceId,
  itemId,
  version,
  title,
}: {
  workspaceId: string;
  itemId: string;
  version: number;
  title: string;
}) {
  const [state, formAction, pending] = useActionState(removeItem, idle);
  return (
    <form action={formAction} className="space-y-2">
      <Hidden values={{ workspaceId, itemId, version }} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Remove from board: ${title}`}
      >
        {pending ? "Removing…" : "Remove from board"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
