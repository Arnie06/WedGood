"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { guestCalendarFile, type GuestCalendarEvent } from "@/domain/calendar/guest";

/**
 * UX-16: "Add to calendar" on the guest's confirmation. The file is built here in the browser from
 * what the page already shows, so there is no extra public endpoint and the link never appears in
 * the file. Renders nothing when no attended event has a date.
 */
export function AddToCalendar({
  weddingName,
  events,
}: {
  weddingName: string;
  events: readonly GuestCalendarEvent[];
}) {
  const [done, setDone] = useState(false);
  const attended = events.filter((e) => e.attending && e.localDate);
  if (attended.length === 0) return null;

  const download = () => {
    const body = guestCalendarFile(weddingName, events, new Date());
    if (!body) return;
    const url = URL.createObjectURL(new Blob([body], { type: "text/calendar;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "wedding.ics";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDone(true);
  };

  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={download}>
        Add to calendar
      </Button>
      <p className="text-body-md text-ink-muted" aria-live="polite">
        {done
          ? "Your calendar file is downloading. Open it to add the date."
          : attended.length === 1
            ? "Adds the date as an all-day event. Times are in your invitation."
            : `Adds ${attended.length} dates as all-day events. Times are in your invitation.`}
      </p>
    </div>
  );
}
