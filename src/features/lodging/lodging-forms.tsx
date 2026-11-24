"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { useTrayActionState } from "@/components/ui/tray";
import { LODGING_LIMITS, type BlockField, type HotelField } from "@/domain/lodging/input";
import { Feedback, Hidden } from "@/features/events/event-forms";
import type { EventActionState } from "@/server/events/actions";
import {
  recordLodgingPickup,
  removeLodgingBlock,
  saveLodgingBlock,
  saveLodgingHotel,
  setLodgingHotelArchived,
  setLodgingStays,
} from "@/server/lodging/actions";

const idle: EventActionState = { status: "idle" };
const errorOf = (s: EventActionState, f: string) =>
  s.status === "error" ? s.fieldErrors[f] : undefined;
const valueOf = (s: EventActionState, f: string, fallback: string) =>
  s.status === "error" ? (s.values[f] ?? fallback) : fallback;

function Check({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex min-h-11 items-start gap-3 text-body-md">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-1 size-5 shrink-0 accent-action-secondary"
      />
      <span>
        {label}
        <span className="block text-body-sm text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------- hotels
export function HotelForm({
  workspaceId,
  initial,
  vendors,
  hotel,
}: {
  workspaceId: string;
  initial: Record<HotelField, string>;
  vendors: { id: string; name: string }[];
  hotel?: { id: string; version: number } | undefined;
}) {
  const [state, action, pending] = useTrayActionState(saveLodgingHotel, idle);
  const v = (f: HotelField) => valueOf(state, f, initial[f]);
  const checked = (f: "showToGuests" | "showRate") =>
    state.status === "error" ? state.values[f] === "on" : initial[f] === "on";
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden
        values={{ workspaceId, ...(hotel && { hotelId: hotel.id, version: hotel.version }) }}
      />
      <TextField
        name="name"
        label="Hotel name"
        defaultValue={v("name")}
        error={errorOf(state, "name")}
        maxLength={LODGING_LIMITS.hotelName}
        required
      />
      <TextField
        name="address"
        label="Address"
        defaultValue={v("address")}
        error={errorOf(state, "address")}
        maxLength={LODGING_LIMITS.address}
      />
      <TextField
        name="phone"
        label="Phone"
        type="tel"
        defaultValue={v("phone")}
        error={errorOf(state, "phone")}
        maxLength={LODGING_LIMITS.phone}
      />
      <TextField
        name="websiteUrl"
        label="Hotel website"
        type="url"
        hint="Starts with https://"
        defaultValue={v("websiteUrl")}
        error={errorOf(state, "websiteUrl")}
      />
      <TextAreaField
        name="guestNote"
        label="Note for guests"
        hint="Shown on your website with this hotel, such as parking or how to reach the venue."
        defaultValue={v("guestNote")}
        error={errorOf(state, "guestNote")}
        maxLength={LODGING_LIMITS.guestNote}
        rows={3}
      />
      {vendors.length > 0 && (
        <SelectField
          // Remount with the echoed choice: a select ignores a changed defaultValue after a reset.
          key={v("candidateId")}
          name="candidateId"
          label="Linked vendor (optional)"
          hint="If you track this hotel as a vendor, its booking appears beside the block."
          defaultValue={v("candidateId")}
          error={errorOf(state, "candidateId")}
        >
          <option value="">None</option>
          {vendors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      )}
      <fieldset className="space-y-1">
        <legend className="text-label-lg font-semibold">What guests see</legend>
        <Check
          name="showToGuests"
          label="Show this hotel to guests"
          hint="On your website (when you include hotels) and in the RSVP question about where they're staying."
          defaultChecked={checked("showToGuests")}
        />
        <Check
          name="showRate"
          label="Show the nightly rate to guests"
          hint="Rooms held, bookings and attrition are never shown to guests."
          defaultChecked={checked("showRate")}
        />
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : hotel ? "Save hotel" : "Add hotel"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveHotelForm({
  workspaceId,
  hotel,
}: {
  workspaceId: string;
  hotel: { id: string; version: number; name: string; archived: boolean };
}) {
  const [state, action, pending] = useTrayActionState(setLodgingHotelArchived, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden
        values={{
          workspaceId,
          hotelId: hotel.id,
          version: hotel.version,
          archived: hotel.archived ? "no" : "yes",
        }}
      />
      <p className="text-body-md">
        {hotel.archived
          ? `Restoring ${hotel.name} lets you choose it again. Guests see it again if it is marked for guests.`
          : `Archiving ${hotel.name} hides it from guests and from new choices. Its blocks stay on the Budget page, and guests who chose it keep their answer.`}
      </p>
      <Button type="submit" variant={hotel.archived ? "primary" : "emphasis"} disabled={pending}>
        {pending ? "Saving…" : hotel.archived ? `Restore ${hotel.name}` : `Archive ${hotel.name}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- blocks
export function BlockForm({
  workspaceId,
  hotelId,
  initial,
  categories,
  currency,
  block,
}: {
  workspaceId: string;
  hotelId: string;
  initial: Record<BlockField, string>;
  categories: { id: string; name: string }[];
  currency: string;
  block?: { id: string; version: number } | undefined;
}) {
  const [state, action, pending] = useTrayActionState(saveLodgingBlock, idle);
  const v = (f: BlockField) => valueOf(state, f, initial[f]);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden
        values={{
          workspaceId,
          ...(block ? { blockId: block.id, version: block.version } : { hotelId }),
        }}
      />
      <TextField
        name="label"
        label="Name (optional)"
        hint="Useful when a hotel has more than one block, such as King rooms."
        defaultValue={v("label")}
        error={errorOf(state, "label")}
        maxLength={LODGING_LIMITS.blockLabel}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="checkIn"
          type="date"
          label="First night"
          defaultValue={v("checkIn")}
          error={errorOf(state, "checkIn")}
          required
        />
        <TextField
          name="checkOut"
          type="date"
          label="Check-out day"
          defaultValue={v("checkOut")}
          error={errorOf(state, "checkOut")}
          required
        />
      </div>
      <TextField
        name="roomsPerNight"
        label="Rooms held each night"
        inputMode="numeric"
        defaultValue={v("roomsPerNight")}
        error={errorOf(state, "roomsPerNight")}
        required
      />
      <TextField
        name="nightlyRate"
        label={`Group rate per night (${currency})`}
        inputMode="decimal"
        hint="Leave blank if you don't know it yet."
        defaultValue={v("nightlyRate")}
        error={errorOf(state, "nightlyRate")}
      />
      <fieldset className="space-y-4">
        <legend className="text-label-lg font-semibold">
          Attrition (from your hotel contract)
        </legend>
        <TextField
          name="attritionPercent"
          label="Rooms you may leave unbooked (%)"
          inputMode="decimal"
          hint="For example 20 if the hotel needs 80% of the block booked. Leave blank if unknown."
          defaultValue={v("attritionPercent")}
          error={errorOf(state, "attritionPercent")}
        />
        <TextField
          name="attritionCharge"
          label={`Charge per unbooked room-night (${currency})`}
          inputMode="decimal"
          hint="Leave blank if the hotel charges the group rate."
          defaultValue={v("attritionCharge")}
          error={errorOf(state, "attritionCharge")}
        />
      </fieldset>
      <TextField
        name="cutoffDate"
        type="date"
        label="Book by"
        hint="The hotel's cut-off date for the group rate."
        defaultValue={v("cutoffDate")}
        error={errorOf(state, "cutoffDate")}
      />
      <TextField
        name="bookingUrl"
        type="url"
        label="Booking link for guests"
        hint="Starts with https://"
        defaultValue={v("bookingUrl")}
        error={errorOf(state, "bookingUrl")}
      />
      <TextField
        name="bookingCode"
        label="Booking code for guests"
        defaultValue={v("bookingCode")}
        error={errorOf(state, "bookingCode")}
        maxLength={LODGING_LIMITS.bookingCode}
      />
      {categories.length > 0 && (
        <SelectField
          // Remount with the echoed choice: a select ignores a changed defaultValue after a reset.
          key={v("budgetCategoryId")}
          name="budgetCategoryId"
          label="Budget category"
          hint="Where the possible attrition charge is listed on the Budget page. It is never added to your forecast."
          defaultValue={v("budgetCategoryId")}
          error={errorOf(state, "budgetCategoryId")}
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : block ? "Save block" : "Add block"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveBlockForm({
  workspaceId,
  block,
}: {
  workspaceId: string;
  block: { id: string; version: number; name: string };
}) {
  const [state, action, pending] = useTrayActionState(removeLodgingBlock, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden values={{ workspaceId, blockId: block.id, version: block.version }} />
      <p className="text-body-md">
        This removes {block.name} and its pickup report. Your hotel contract is not changed.
      </p>
      <Button type="submit" variant="emphasis" disabled={pending}>
        {pending ? "Removing…" : "Remove block"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function PickupForm({
  workspaceId,
  block,
  today,
}: {
  workspaceId: string;
  block: {
    id: string;
    version: number;
    checkIn: string;
    checkOut: string;
    rooms: number;
    held: number;
    roomNights: number | null;
    asOf: string | null;
  };
  today: string;
}) {
  const [state, action, pending] = useTrayActionState(recordLodgingPickup, idle);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden
        values={{
          workspaceId,
          blockId: block.id,
          version: block.version,
          checkIn: block.checkIn,
          checkOut: block.checkOut,
          rooms: block.rooms,
        }}
      />
      <p className="text-body-md">
        Copy the numbers from the hotel&apos;s latest pickup report. This block holds {block.held}{" "}
        room-nights. Leave both blank to clear the report.
      </p>
      <TextField
        name="roomNights"
        label="Room-nights booked"
        inputMode="numeric"
        defaultValue={valueOf(state, "roomNights", block.roomNights?.toString() ?? "")}
        error={errorOf(state, "roomNights")}
      />
      <TextField
        name="asOf"
        type="date"
        label="Report date"
        max={today}
        defaultValue={valueOf(state, "asOf", block.asOf ?? today)}
        error={errorOf(state, "asOf")}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save report"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- who stays where
export type StayGuestChoice = { id: string; name: string; detail: string | null };

/** Checkbox list: a non-drag way to set where several guests are staying at once. */
export function StaysForm({
  workspaceId,
  guests,
  hotels,
}: {
  workspaceId: string;
  guests: StayGuestChoice[];
  hotels: { id: string; name: string }[];
}) {
  const [state, action, pending] = useTrayActionState(setLodgingStays, idle);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  if (guests.length === 0) {
    return <p className="text-body-md">Guests appear here once they accept an invitation.</p>;
  }
  return (
    <form action={action} className="space-y-4">
      <Hidden values={{ workspaceId }} />
      <SelectField name="stay" label="Staying at" defaultValue="" required>
        <option value="" disabled>
          Choose…
        </option>
        {hotels.map((h) => (
          <option key={h.id} value={`hotel:${h.id}`}>
            {h.name}
          </option>
        ))}
        <option value="elsewhere">Staying elsewhere</option>
        <option value="not_staying">Not staying overnight</option>
        <option value="clear">Clear my choice (keep the guest&apos;s own answer)</option>
      </SelectField>
      <p className="text-body-md" aria-live="polite">
        {chosen.size} chosen{chosen.size > 20 ? ". Choose up to 20 at a time." : "."}
      </p>
      <fieldset className="space-y-1">
        <legend className="text-label-lg font-semibold">Guests attending</legend>
        <ul>
          {guests.map((g) => (
            <li key={g.id}>
              <label className="flex min-h-11 items-start gap-3 py-1 text-body-md">
                <input
                  type="checkbox"
                  name="guestId"
                  value={g.id}
                  checked={chosen.has(g.id)}
                  onChange={(e) => toggle(g.id, e.target.checked)}
                  className="mt-1 size-5 shrink-0 accent-action-secondary"
                />
                <span>
                  {g.name}
                  {g.detail && (
                    <span className="block text-body-sm text-ink-muted">{g.detail}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <Button type="submit" disabled={pending || chosen.size === 0 || chosen.size > 20}>
        {pending
          ? "Saving…"
          : chosen.size === 0
            ? "Save for guests"
            : `Save for ${chosen.size} ${chosen.size === 1 ? "guest" : "guests"}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
