"use client";

import { useSyncExternalStore } from "react";
import { zonedDay } from "./reply-by";

const noSubscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
const serverZone = () => null;

/**
 * A date shown in the event's zone, naming the zone once the browser shows the viewer is
 * elsewhere. The server render leaves the zone out, so hydration never mismatches.
 */
export function ZonedDate({
  iso,
  timeZone,
  month = "long",
}: {
  iso: string;
  timeZone: string;
  month?: "long" | "short";
}) {
  const viewer = useSyncExternalStore(noSubscribe, browserZone, serverZone);
  const { date, zone } = zonedDay(iso, timeZone, viewer, month);
  return (
    <time dateTime={iso}>
      {date}
      {zone ? ` (${zone})` : ""}
    </time>
  );
}
