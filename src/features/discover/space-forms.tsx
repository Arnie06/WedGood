"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { useTrayActionState } from "@/components/ui/tray";
import {
  archiveVenueSpace,
  saveVenueSpace,
  type SpaceActionState,
} from "@/server/candidates/space-actions";

const idle: SpaceActionState = { status: "idle" };

export type SpaceDefaults = {
  name: string;
  seatedCapacity: string;
  standingCapacity: string;
  notes: string;
};
const EMPTY: SpaceDefaults = { name: "", seatedCapacity: "", standingCapacity: "", notes: "" };

export function SpaceForm({
  workspaceId,
  venueId,
  space,
  defaults = EMPTY,
}: {
  workspaceId: string;
  venueId: string;
  space?: { id: string; version: number };
  defaults?: SpaceDefaults;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useTrayActionState(saveVenueSpace, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof SpaceDefaults) => echoed?.[k] ?? defaults[k];
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="venueId" value={venueId} />
      {space ? (
        <>
          <input type="hidden" name="spaceId" value={space.id} />
          <input type="hidden" name="version" value={space.version} />
        </>
      ) : (
        <input type="hidden" name="idempotencyKey" value={key} />
      )}
      <TextField
        label="Space name"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        hint="A room or area, like “Garden terrace” or “Main hall”."
        defaultValue={v("name")}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Seated capacity"
          name="seatedCapacity"
          inputMode="numeric"
          autoComplete="off"
          hint="Leave blank if unknown."
          defaultValue={v("seatedCapacity")}
          error={errors.seatedCapacity}
        />
        <TextField
          label="Standing capacity"
          name="standingCapacity"
          inputMode="numeric"
          autoComplete="off"
          hint="Leave blank if unknown."
          defaultValue={v("standingCapacity")}
          error={errors.standingCapacity}
        />
      </div>
      <TextAreaField
        label="Notes"
        name="notes"
        rows={3}
        maxLength={500}
        defaultValue={v("notes")}
        error={errors.notes}
      />
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : space ? "Save space" : "Add space"}
      </Button>
    </form>
  );
}

export function ArchiveSpaceForm({
  workspaceId,
  spaceId,
  version,
}: {
  workspaceId: string;
  spaceId: string;
  version: number;
}) {
  const [state, action, pending] = useTrayActionState(archiveVenueSpace, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="spaceId" value={spaceId} />
      <input type="hidden" name="version" value={version} />
      <p className="text-body-sm text-ink-muted">
        Events held here will show it as no longer at this venue until you choose another.
      </p>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Removing…" : "Remove this space"}
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
